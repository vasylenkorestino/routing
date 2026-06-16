/**
 * Deterministic "Generate by Service Location" planner.
 *
 * Pipeline: discover eligible UCO accounts -> assign each to nearest depot
 * (Service_Location__c) -> cluster by compass direction + proximity ->
 * split clusters into routes by capacity caps (stops / gallons / duration) ->
 * TSP-optimize each route -> compute metrics + geometry for an in-memory preview.
 *
 * No Salesforce writes happen here; the route handler commits selected routes
 * separately via the route_generation skill.
 */

const AccountDiscoverySkill = require('../skills/accountDiscovery');
const sf = require('../services/salesforce');
const routeOptimizer = require('./routeOptimizer');
const { haversine } = require('./distanceMatrix');
const logger = require('../utils/logger');

const DEFAULTS = {
  maxStops: 25,
  maxGallons: 1800,
  maxDurationMin: 480,
  serviceTimeMin: 15,
  avgSpeedMph: 30,
  sectorCount: 8,
  defaultGallons: 40, // fallback per-stop fill when no service history exists
};

const SECTOR_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Resolves user-supplied caps onto sane defaults. */
function resolveOpts(params) {
  const strategy = params.strategy || process.env.TSP_STRATEGY || 'haversine';
  return {
    maxStops: clampNum(params.maxStops, DEFAULTS.maxStops, 1, 200),
    maxGallons: clampNum(params.maxGallons, DEFAULTS.maxGallons, 1, 100000),
    maxDurationMin: clampNum(params.maxDurationMin, DEFAULTS.maxDurationMin, 30, 1440),
    serviceTimeMin: clampNum(params.serviceTimeMin, DEFAULTS.serviceTimeMin, 0, 240),
    avgSpeedMph: clampNum(params.avgSpeedMph, DEFAULTS.avgSpeedMph, 5, 80),
    sectorCount: clampNum(params.sectorCount, DEFAULTS.sectorCount, 1, 16),
    defaultGallons: DEFAULTS.defaultGallons,
    strategy,
    osrmUrl: process.env.OSRM_URL || null,
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
  };
}

function clampNum(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Initial compass bearing (degrees, 0-360) from one point to another. */
function bearing(from, to) {
  const phi1 = toRad(from.lat);
  const phi2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** Maps a bearing to one of N evenly spaced compass sectors and a label. */
function sectorFor(brng, sectorCount) {
  const norm = ((brng % 360) + 360) % 360;
  const size = 360 / sectorCount;
  const idx = Math.floor(norm / size) % sectorCount;
  const labelIdx = Math.round((norm / 360) * SECTOR_LABELS.length) % SECTOR_LABELS.length;
  return { idx, label: SECTOR_LABELS[labelIdx] };
}

/** Loads non-temporary Service_Location__c depots, optionally scoped to one record type / id. */
async function loadDepots({ recordType, serviceLocationId }) {
  let soql =
    'SELECT Id, Name, Latitude__c, Longitude__c, Street__c, City__c, State__c ' +
    'FROM Service_Location__c WHERE Temporary__c = false ' +
    'AND Latitude__c != null AND Longitude__c != null ';
  if (serviceLocationId) {
    soql += `AND Id = '${String(serviceLocationId).replace(/'/g, "")}' `;
  } else if (recordType) {
    soql += `AND RecordType.Name = '${String(recordType).replace(/'/g, "")}' `;
  }
  soql += 'ORDER BY Name';

  const rows = await sf.query(soql);
  return rows.map((r) => ({
    id: r.Id,
    name: r.Name,
    lat: Number(r.Latitude__c),
    lng: Number(r.Longitude__c),
    street: r.Street__c || '',
    city: r.City__c || '',
    state: r.State__c || '',
  }));
}

/**
 * Runs the full planning pipeline.
 * @param {object} params - { date, recordType, serviceLocationId?, maxRadiusMiles?, caps... }
 * @param {(progress: object) => void} [onProgress] - receives { step, label, counters, percent }
 * @returns {Promise<object>} preview result { routes, summary, warnings }
 */
async function plan(params, onProgress = () => {}) {
  const opts = resolveOpts(params);
  const { date, recordType, serviceLocationId } = params;
  const maxRadiusMiles = Number.isFinite(Number(params.maxRadiusMiles)) ? Number(params.maxRadiusMiles) : null;

  const counters = {
    accountsAnalyzed: 0,
    eligibleFound: 0,
    serviceLocationsProcessed: 0,
    accountsAssigned: 0,
    accountsExcluded: 0,
    clustersBuilt: 0,
    routesPlanned: 0,
    routesOptimized: 0,
  };
  const warnings = [];
  const emit = (step, label, percent) => onProgress({ step, label, counters: { ...counters }, percent });

  // 1. Discover eligible accounts (reuses shared UCO eligibility rules).
  emit('discovering', 'Analyzing accounts that need UCO service', 8);
  const discovery = new AccountDiscoverySkill();
  const discovered = await discovery.execute({ targetDate: date, recordTypeName: recordType, maxResults: 2000 });
  const accounts = (discovered.accounts || []).filter((a) => a.MALatitude__c != null && a.MALongitude__c != null);
  counters.accountsAnalyzed = discovered.accounts?.length || 0;
  emit('discovering', `Found ${accounts.length} accounts with valid coordinates`, 15);

  // 2. Load depots.
  emit('loading_depots', 'Loading service locations', 20);
  const depots = await loadDepots({ recordType, serviceLocationId });
  counters.serviceLocationsProcessed = depots.length;
  emit('loading_depots', `Processed ${depots.length} service location(s)`, 25);

  if (accounts.length === 0 || depots.length === 0) {
    if (accounts.length === 0) warnings.push('No eligible accounts found for the selected date and record type.');
    if (depots.length === 0) warnings.push('No service locations found for the selected scope.');
    const summary = buildSummary([], counters, opts, { date, recordType, serviceLocationId });
    emit('complete', 'Nothing to generate', 100);
    return { routes: [], summary, warnings };
  }

  // 3. Assign each account to nearest depot (single-depot mode assigns all to that depot).
  emit('assigning', 'Assigning accounts to nearest service location', 30);
  const byDepot = new Map(depots.map((d) => [d.id, []]));
  for (const acct of accounts) {
    const pt = { lat: Number(acct.MALatitude__c), lng: Number(acct.MALongitude__c) };
    let best = null;
    let bestDist = Infinity;
    for (const d of depots) {
      const dist = haversine(pt, { lat: d.lat, lng: d.lng });
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    if (!best) continue;
    if (maxRadiusMiles != null && bestDist > maxRadiusMiles) {
      counters.accountsExcluded += 1;
      continue;
    }
    byDepot.get(best.id).push({ ...acct, _distFromDepot: bestDist });
  }
  counters.accountsAssigned = [...byDepot.values()].reduce((s, arr) => s + arr.length, 0);
  counters.eligibleFound = counters.accountsAssigned;
  if (counters.accountsExcluded > 0) {
    warnings.push(`${counters.accountsExcluded} account(s) excluded beyond the ${maxRadiusMiles}-mile radius.`);
  }
  emit('assigning', `Assigned ${counters.accountsAssigned} accounts across depots`, 38);

  // 4. Cluster by direction + proximity, then split into capacity-bounded bins.
  emit('clustering', 'Grouping accounts by direction and proximity', 42);
  const bins = [];
  for (const depot of depots) {
    const depotAccts = byDepot.get(depot.id) || [];
    if (depotAccts.length === 0) continue;

    const sectors = new Map();
    for (const acct of depotAccts) {
      const brng = bearing(
        { lat: depot.lat, lng: depot.lng },
        { lat: Number(acct.MALatitude__c), lng: Number(acct.MALongitude__c) }
      );
      const sec = sectorFor(brng, opts.sectorCount);
      if (!sectors.has(sec.idx)) sectors.set(sec.idx, { label: sec.label, accounts: [] });
      sectors.get(sec.idx).accounts.push(acct);
    }

    for (const { label, accounts: sectorAccts } of sectors.values()) {
      sectorAccts.sort((a, b) => a._distFromDepot - b._distFromDepot);
      for (const group of splitByCapacity(sectorAccts, opts)) {
        bins.push({ depot, sectorLabel: label, accounts: group });
      }
    }
  }
  counters.clustersBuilt = bins.length;
  counters.routesPlanned = bins.length;
  emit('clustering', `Built ${bins.length} route cluster(s)`, 45);

  // 5/6. Optimize each bin (and split if it exceeds the duration cap).
  const routes = [];
  for (let i = 0; i < bins.length; i++) {
    const bin = bins[i];
    await finalizeBin(bin.accounts, bin.depot, bin.sectorLabel, opts, routes);
    counters.routesOptimized = routes.length;
    const pct = 45 + Math.round(((i + 1) / bins.length) * 45);
    emit('optimizing', `Optimizing routes (${i + 1}/${bins.length})`, pct);
  }

  // 7. Number + finalize preview routes.
  emit('finalizing', 'Finalizing generated routes', 96);
  const finalRoutes = routes.map((r, i) => ({
    ...r,
    id: `preview-${i + 1}`,
    routeName: routeName(r.depot, r.sectorLabel, date, i + 1),
    serviceDate: date,
    recordType: recordType || null,
  }));
  counters.routesPlanned = finalRoutes.length;

  const summary = buildSummary(finalRoutes, counters, opts, { date, recordType, serviceLocationId });
  emit('complete', `Generated ${finalRoutes.length} route(s)`, 100);

  logger.info('[serviceLocationPlanner] plan complete', {
    routes: finalRoutes.length,
    accounts: counters.accountsAssigned,
    depots: depots.length,
  });

  return { routes: finalRoutes, summary, warnings };
}

/** Greedy bin-packing of accounts into routes bounded by stop count and estimated gallons. */
function splitByCapacity(sortedAccounts, opts) {
  const bins = [];
  let current = [];
  let gallons = 0;
  for (const acct of sortedAccounts) {
    const est = estGallons(acct, opts);
    const wouldExceed = current.length >= opts.maxStops || (current.length > 0 && gallons + est > opts.maxGallons);
    if (wouldExceed) {
      bins.push(current);
      current = [];
      gallons = 0;
    }
    current.push(acct);
    gallons += est;
  }
  if (current.length > 0) bins.push(current);
  return bins;
}

/** Estimated gallons to collect at a stop, from recent service history or a fallback. */
function estGallons(acct, opts) {
  const last = Number(acct.lastGallons);
  return Number.isFinite(last) && last > 0 ? last : opts.defaultGallons;
}

/**
 * Optimizes a group of accounts into a route; if the result exceeds the duration
 * cap it is split along its optimized sequence and each half re-optimized.
 */
async function finalizeBin(accounts, depot, sectorLabel, opts, out) {
  if (!accounts || accounts.length === 0) return;

  const route = await buildRoute(accounts, depot, sectorLabel, opts);

  if (route.totalDurationMin > opts.maxDurationMin && accounts.length > 1) {
    const byId = new Map(accounts.map((a) => [a.Id, a]));
    const orderedAccts = route.stops.map((s) => byId.get(s.accountId)).filter(Boolean);
    const mid = Math.ceil(orderedAccts.length / 2);
    await finalizeBin(orderedAccts.slice(0, mid), depot, sectorLabel, opts, out);
    await finalizeBin(orderedAccts.slice(mid), depot, sectorLabel, opts, out);
    return;
  }

  out.push(route);
}

/** Builds an optimized route object with metrics + geometry for one group of accounts. */
async function buildRoute(accounts, depot, sectorLabel, opts) {
  const stops = accounts.map((a) => ({
    accountId: a.Id,
    accountName: a.Name,
    lat: Number(a.MALatitude__c),
    lng: Number(a.MALongitude__c),
    address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
    estGallons: estGallons(a, opts),
    hasOpenTicket: !!a.hasOpenTicket,
  }));

  const depotPt = { lat: depot.lat, lng: depot.lng };
  const opt = await routeOptimizer.optimize({
    stops,
    startLocation: depotPt,
    endLocation: depotPt,
    strategy: opts.strategy,
    osrmUrl: opts.osrmUrl,
    googleApiKey: opts.googleApiKey,
  });

  const orderedStops = (opt.orderedStops.length ? opt.orderedStops : stops).map((s, i) => ({
    accountId: s.accountId,
    accountName: s.accountName,
    lat: s.lat,
    lng: s.lng,
    address: s.address,
    estGallons: s.estGallons,
    hasOpenTicket: s.hasOpenTicket,
    priority: i + 1,
  }));

  const distanceMi = round2(opt.totalDistance || 0);
  const driveTimeMin = Math.round((distanceMi / opts.avgSpeedMph) * 60);
  const serviceTimeMin = orderedStops.length * opts.serviceTimeMin;
  const totalDurationMin = driveTimeMin + serviceTimeMin;
  const totalGallons = round2(orderedStops.reduce((s, x) => s + (x.estGallons || 0), 0));

  return {
    depot: { id: depot.id, name: depot.name, lat: depot.lat, lng: depot.lng, address: [depot.street, depot.city, depot.state].filter(Boolean).join(', ') },
    sectorLabel,
    direction: `${depot.name} ${sectorLabel}`,
    serviceLocationId: depot.id,
    stops: orderedStops,
    accountIds: orderedStops.map((s) => s.accountId),
    totalStops: orderedStops.length,
    totalDistanceMi: distanceMi,
    driveTimeMin,
    serviceTimeMin,
    totalDurationMin,
    totalGallons,
    optimizationScore: parsePct(opt.improvement),
  };
}

/** Builds a stable, human-readable route name. */
function routeName(depot, sectorLabel, date, n) {
  return `AI ${depot.name} ${sectorLabel} ${date} #${n}`;
}

function buildSummary(routes, counters, opts, scope) {
  const totalStops = routes.reduce((s, r) => s + r.totalStops, 0);
  const totalDistance = round2(routes.reduce((s, r) => s + r.totalDistanceMi, 0));
  const totalDuration = routes.reduce((s, r) => s + r.totalDurationMin, 0);
  return {
    date: scope.date,
    recordType: scope.recordType || null,
    serviceLocationId: scope.serviceLocationId || null,
    routeCount: routes.length,
    totalStops,
    totalDistanceMi: totalDistance,
    totalDurationMin: totalDuration,
    caps: {
      maxStops: opts.maxStops,
      maxGallons: opts.maxGallons,
      maxDurationMin: opts.maxDurationMin,
      serviceTimeMin: opts.serviceTimeMin,
    },
    counters,
  };
}

function parsePct(improvement) {
  if (typeof improvement === 'number') return improvement;
  const m = String(improvement || '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { plan, loadDepots, bearing, sectorFor, resolveOpts };
