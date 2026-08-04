/**
 * AI Route Planning planner (SEPARATE, ADDITIVE MODULE).
 *
 * This module powers the new full-screen Route Planning workspace. It is fully
 * isolated from the existing generation logic: it does NOT modify
 * serviceLocationPlanner.js (it only imports its exported pure helpers) and it
 * never writes to Salesforce. It produces temporary MOCK routes plus a recorded
 * "trace" (a series of snapshots) so the client can replay how the plan was built.
 *
 * Pipeline (per day in the requested date range):
 *   discover eligible UCO accounts -> assign to nearest depot -> cluster by
 *   compass bearing -> split into soft-capacity bins -> TSP-optimize each bin.
 *
 * Eligibility (planning mode): UCO_Collection__c = true, Account_Status__c =
 * 'Active', valid coordinates, not already routed, and actually due for service
 * per the shared serviceDue engine (newest UCO Collection Service__c + pickup
 * frequency, with history-based frequency fallbacks and a Gross Gallons fill-rate model).
 */

const { loadDepots, bearing, sectorFor } = require('./serviceLocationPlanner');
const sf = require('../services/salesforce');
const serviceDue = require('./serviceDue');
const { withServiceHistoryForAccounts } = require('./serviceHistoryLoader');
const routeOptimizer = require('./routeOptimizer');
const { haversine } = require('./distanceMatrix');
const logger = require('../utils/logger');

const DEFAULTS = {
  maxStops: 25,
  minStopsPerRoute: 5,
  maxGallons: 1800,
  maxDurationMin: null, // null = do not hard-cap duration (soft guidance only)
  serviceTimeMin: 15,
  avgSpeedMph: 30,
  sectorCount: 8,
  defaultGallons: 40,
  // Soft-guidance overflow: caps may be exceeded by this ratio when the extra
  // stops are tightly clustered (low incremental drive time).
  softOverflowRatio: 0.25,
  softIncrementalMiles: 2, // ~4 minutes at 30 mph
  absoluteDurationCeilingMin: 600, // 10h hard ceiling so a route can't grow unbounded
  // Locality: when a Service Location is selected, start near it and expand
  // outward instead of loading the whole org. Radius grows until enough
  // eligible accounts are found (or the ceiling is hit).
  defaultRadiusMiles: 40,
  maxRadiusMiles: 250,
  radiusGrowthFactor: 2,
};

const SECTOR_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Validates a Salesforce Id (15/18-char alphanumeric) to keep interpolated SOQL safe. */
function safeId(id) {
  const s = String(id || '');
  if (!/^[a-zA-Z0-9]{15,18}$/.test(s)) throw new Error(`Invalid Salesforce Id: ${s}`);
  return s;
}

/** Escapes single quotes for safe SOQL string literals. */
function escapeSoql(str) {
  return String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function clampNum(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Resolves user-supplied guidance onto sane defaults. */
function resolveOpts(params = {}) {
  const strategy = params.strategy || process.env.TSP_STRATEGY || 'haversine';
  return {
    maxStops: clampNum(params.maxStops, DEFAULTS.maxStops, 1, 200),
    minStopsPerRoute: clampNum(params.minStopsPerRoute, DEFAULTS.minStopsPerRoute, 1, 200),
    maxGallons: clampNum(params.maxGallons, DEFAULTS.maxGallons, 1, 100000),
    maxDurationMin: params.maxDurationMin ? clampNum(params.maxDurationMin, DEFAULTS.absoluteDurationCeilingMin, 30, 1440) : null,
    serviceTimeMin: clampNum(params.serviceTimeMin, DEFAULTS.serviceTimeMin, 0, 240),
    avgSpeedMph: clampNum(params.avgSpeedMph, DEFAULTS.avgSpeedMph, 5, 80),
    sectorCount: clampNum(params.sectorCount, DEFAULTS.sectorCount, 1, 16),
    defaultGallons: DEFAULTS.defaultGallons,
    softOverflowRatio: DEFAULTS.softOverflowRatio,
    softIncrementalMiles: DEFAULTS.softIncrementalMiles,
    absoluteDurationCeilingMin: DEFAULTS.absoluteDurationCeilingMin,
    strategy,
    osrmUrl: process.env.OSRM_URL || null,
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
  };
}

function toRad(d) {
  return (d * Math.PI) / 180;
}

/* ── Date helpers ─────────────────────────────────────────── */

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of YYYY-MM-DD strings from dateFrom to dateTo (capped at 31 days). */
function dateRange(dateFrom, dateTo) {
  const from = new Date(`${dateFrom}T00:00:00Z`);
  const to = new Date(`${(dateTo || dateFrom)}T00:00:00Z`);
  const days = [];
  const cur = new Date(from);
  let guard = 0;
  while (cur <= to && guard < 31) {
    days.push(toISODate(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard += 1;
  }
  return days.length ? days : [dateFrom];
}

/* ── Account discovery (planning mode) ────────────────────── */

const ACCOUNT_FIELDS =
  'Id, Name, ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ' +
  'MALatitude__c, MALongitude__c, UCO_Collection__c, Rotisserie_Collection__c, ' +
  'Last_Service_Date__c, UCOLastServiceDate__c, Expected_Date_Of_Service__c, Equipment_Type__c, ' +
  'Tank_Size__c, Container_Size_number__c, ContainerCapacity__c, Estimated_GPM__c, Number_Of_Fryers__c, ' +
  'Pickup_Frequency_in_Days__c, Estimated_Pickup_Frequency__c, RelatedServiceLocation__c, ' +
  "(SELECT Id, Subject, Type FROM Cases WHERE Status = 'Open' AND Type = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 3)";

/** Attaches the derived flags the planner reasons about (tickets, service history). */
function decorateAccount(a) {
  return {
    ...a,
    _hasOpenTicket: (a.Cases?.records?.length || 0) > 0,
    _ticketCount: a.Cases?.records?.length || 0,
    _lastGallons: a.Services__r?.records?.[0]?.Qty_Gallons__c ?? null,
    _serviceCount: a.Services__r?.records?.length || 0,
  };
}

/**
 * Finds accounts eligible for planning within the range, anchored on the selected
 * Service Location and expanding outward. Candidates are UCO_Collection__c = true
 * accounts not already on an incomplete Route__c in the window; each is then
 * evaluated individually by the shared serviceDue engine (newest UCO Collection
 * Service__c + pickup frequency, with history-based frequency fallbacks) and only
 * accounts actually due by the target date are returned (sorted nearest-first,
 * with the evaluation attached as `_svc`). Accounts filtered out are returned as `exclusions`.
 *
 * @param {object} p
 * @param {{lat:number,lng:number}} [p.anchor] - Service Location coordinates to expand from.
 * @param {number} [p.radiusMiles] - bounding radius around the anchor (omitted => whole scope).
 * @returns {Promise<{accounts: object[], exclusions: {byReason: object, sample: object[]}}>}
 */
async function discoverAccounts({ dateFrom, dateTo, recordType, anchor = null, radiusMiles = null }) {
  const target = dateTo || dateFrom;
  const routed = await sf.query(
    `SELECT AccountId__c FROM Route__c ` +
    `WHERE DateOfService__c >= ${dateFrom} AND DateOfService__c <= ${target} ` +
    `AND AccountId__c != null AND Status__c != 'Complete'`,
  );
  const alreadyRouted = new Set(routed.map((r) => r.AccountId__c));

  let soql =
    `SELECT ${ACCOUNT_FIELDS} FROM Account ` +
    "WHERE UCO_Collection__c = true AND Ignore_For_Routing__c = false AND Account_Status__c = 'Active' " +
    'AND MALatitude__c != null AND MALongitude__c != null ';

  if (recordType) soql += `AND RecordType.Name = '${escapeSoql(recordType)}' `;

  // Locality-first: restrict to a lat/lng bounding box around the Service Location
  // so we don't pull far-away accounts (e.g. New York while planning Opa-locka).
  if (anchor && radiusMiles) {
    const dLat = radiusMiles / 69;
    const dLng = radiusMiles / (69 * Math.max(0.1, Math.cos(toRad(anchor.lat))));
    soql +=
      `AND MALatitude__c >= ${round2(anchor.lat - dLat)} AND MALatitude__c <= ${round2(anchor.lat + dLat)} ` +
      `AND MALongitude__c >= ${round2(anchor.lng - dLng)} AND MALongitude__c <= ${round2(anchor.lng + dLng)} `;
  }
  soql += 'ORDER BY UCOLastServiceDate__c ASC NULLS FIRST LIMIT 5000';

  const rows = await withServiceHistoryForAccounts(await sf.query(soql));

  const candidates = rows
    .filter((a) => !alreadyRouted.has(a.Id))
    .map(decorateAccount)
    .map((a) => ({ ...a, _distMi: anchor ? round2(haversine(anchor, pt(a))) : null }))
    // Bounding box is square; enforce the true circular radius here.
    .filter((a) => !(anchor && radiusMiles) || a._distMi <= radiusMiles);

  const exclusions = { byReason: {}, sample: [] };
  const due = [];
  for (const a of candidates) {
    const svc = serviceDue.evaluateAccount(a, dateFrom, target);
    if (svc.due) {
      due.push({ ...a, _svc: svc });
    } else {
      const key = svc.reason.startsWith('not_due_until') ? 'not_due_yet' : svc.reason;
      exclusions.byReason[key] = (exclusions.byReason[key] || 0) + 1;
      if (exclusions.sample.length < 50) {
        exclusions.sample.push({ id: a.Id, name: a.Name, reason: svc.reason, nextDueDate: svc.nextDueDate });
      }
    }
  }

  return { accounts: due.sort((x, y) => (x._distMi ?? 0) - (y._distMi ?? 0)), exclusions };
}

/** Fetches specific accounts by Id with the fields the planner needs (used by regenerate). */
async function fetchAccountsByIds(ids) {
  const safe = [...new Set((ids || []).map((id) => safeId(id)))];
  if (safe.length === 0) return [];
  const idList = safe.map((id) => `'${id}'`).join(',');
  const rows = await withServiceHistoryForAccounts(
    await sf.query(`SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Id IN (${idList})`),
  );
  return rows.map(decorateAccount);
}

/**
 * Estimated gallons to collect at a stop. Delegates to the shared serviceDue
 * engine (Gross Gallons fill-rate model capped at Tank_Size__c capacity, with
 * GPM-accrual and history fallbacks).
 */
function estGallons(acct, targetDate, opts) {
  return serviceDue.estimateGallonsAtDate(acct, targetDate, { defaultGallons: opts.defaultGallons });
}

/**
 * Buckets accounts to the earliest eligible day within the range, avoiding
 * double-booking (an account is placed on exactly one day of the session).
 * Accounts land on their computed next-due day (`_svc.nextDueDate`, clamped
 * into the range); overdue or unevaluated accounts land on the first day.
 */
function bucketByDay(accounts, days) {
  const first = days[0];
  const last = days[days.length - 1];
  const byDay = new Map(days.map((d) => [d, []]));
  for (const a of accounts) {
    let day = first;
    const dueDate = a._svc?.nextDueDate;
    if (dueDate) {
      const e = String(dueDate).slice(0, 10);
      if (e < first) day = first;
      else if (e > last) continue; // out of range
      else day = days.find((d) => d >= e) || first;
    }
    byDay.get(day).push(a);
  }
  return byDay;
}

/* ── Clustering + capacity ────────────────────────────────── */

function pt(a) {
  return { lat: Number(a.MALatitude__c), lng: Number(a.MALongitude__c) };
}

/** Average compass bearing of a group relative to the depot. */
function meanBearing(accounts, depot) {
  let s = 0;
  let c = 0;
  for (const a of accounts) {
    const b = toRad(bearing({ lat: depot.lat, lng: depot.lng }, pt(a)));
    s += Math.sin(b);
    c += Math.cos(b);
  }
  return (Math.atan2(s, c) * 180) / Math.PI;
}

function gallonsOf(accounts, targetDate, opts) {
  return accounts.reduce((sum, a) => sum + estGallons(a, targetDate, opts), 0);
}

/**
 * Greedy bin-packing into routes bounded by stops + gallons, with SOFT overflow:
 * a bin may exceed maxStops by up to softOverflowRatio when the next stop is very
 * close to the previous one (tight cluster => low incremental drive time).
 */
function splitByCapacitySoft(sortedAccounts, targetDate, opts) {
  const hardStops = Math.ceil(opts.maxStops * (1 + opts.softOverflowRatio));
  const bins = [];
  let current = [];
  let gallons = 0;
  let prev = null;

  for (const acct of sortedAccounts) {
    const est = estGallons(acct, targetDate, opts);
    const overGallons = current.length > 0 && gallons + est > opts.maxGallons;
    let overStops = current.length >= opts.maxStops;

    if (overStops && current.length < hardStops && prev) {
      // Allow soft overflow only when the incremental hop is small.
      const hop = haversine(pt(prev), pt(acct));
      if (hop <= opts.softIncrementalMiles) overStops = false;
    }

    if (overStops || overGallons) {
      bins.push(current);
      current = [];
      gallons = 0;
    }
    current.push(acct);
    gallons += est;
    prev = acct;
  }
  if (current.length > 0) bins.push(current);
  return bins;
}

/** Merges trailing under-sized bins into a neighbor when the combined bin still fits. */
function mergeUndersized(bins, targetDate, opts) {
  const minStops = Math.max(1, opts.minStopsPerRoute || 1);
  if (minStops <= 1 || bins.length <= 1) return bins;
  const hardStops = Math.ceil(opts.maxStops * (1 + opts.softOverflowRatio));
  const result = [];
  for (const bin of bins) {
    const prev = result[result.length - 1];
    if (
      bin.length < minStops &&
      prev &&
      prev.length + bin.length <= hardStops &&
      gallonsOf(prev, targetDate, opts) + gallonsOf(bin, targetDate, opts) <= opts.maxGallons
    ) {
      result[result.length - 1] = prev.concat(bin);
    } else {
      result.push(bin);
    }
  }
  return result;
}

/* ── Route building ───────────────────────────────────────── */

/** Builds an optimized mock route object for one group of accounts. */
async function buildRoute(accounts, depot, sectorLabel, targetDate, opts, index) {
  const stops = accounts.map((a) => {
    // Evaluated at discovery; regenerate pools may not carry it, so evaluate lazily.
    const svc = a._svc || serviceDue.evaluateAccount(a, targetDate, targetDate);
    return {
      accountId: a.Id,
      accountName: a.Name,
      lat: Number(a.MALatitude__c),
      lng: Number(a.MALongitude__c),
      address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
      lastServiceDate: svc.lastServiceDate,
      nextDueDate: svc.nextDueDate,
      frequencyDays: svc.effectiveFrequencyDays,
      frequencySource: svc.frequencySource,
      capacityGallons: svc.capacityGallons,
      fillRatePerDay: svc.fillRatePerDay,
      estGallons: estGallons(a, targetDate, opts),
      hasOpenTicket: !!a._hasOpenTicket,
      ticketDriven: false,
    };
  });

  const depotPt = { lat: depot.lat, lng: depot.lng };
  const opt = await routeOptimizer.optimize({
    stops,
    startLocation: depotPt,
    endLocation: depotPt,
    strategy: opts.strategy,
    osrmUrl: opts.osrmUrl,
    googleApiKey: opts.googleApiKey,
  });

  const ordered = (opt.orderedStops.length ? opt.orderedStops : stops).map((s, i) => ({ ...s, priority: i + 1 }));

  const distanceMi = round2(opt.totalDistance || 0);
  const driveTimeMin = Math.round((distanceMi / opts.avgSpeedMph) * 60);
  const serviceTimeMin = ordered.length * opts.serviceTimeMin;
  const totalDurationMin = driveTimeMin + serviceTimeMin;
  const totalGallons = round2(ordered.reduce((s, x) => s + (x.estGallons || 0), 0));
  const ticketCount = ordered.filter((s) => s.hasOpenTicket).length;
  const capacityPct = Math.round((ordered.length / opts.maxStops) * 100);

  return {
    id: `plan-${targetDate}-${index}`,
    routeName: `AI ${depot.name} ${sectorLabel} ${targetDate} #${index}`,
    serviceDate: targetDate,
    recordType: opts.recordType || null,
    depot: { id: depot.id, name: depot.name, lat: depot.lat, lng: depot.lng, address: [depot.street, depot.city, depot.state].filter(Boolean).join(', ') },
    serviceLocationId: depot.id,
    sectorLabel,
    direction: `${depot.name} ${sectorLabel}`,
    stops: ordered,
    accountIds: ordered.map((s) => s.accountId),
    totalStops: ordered.length,
    totalDistanceMi: distanceMi,
    driveTimeMin,
    serviceTimeMin,
    totalDurationMin,
    totalGallons,
    optimizationScore: parsePct(opt.improvement),
    explanation: buildExplanation({ sectorLabel, depot, ticketCount, capacityPct, count: ordered.length }),
    chips: [
      `${depot.name} ${sectorLabel}`,
      `${ordered.length} stops`,
      ...(ticketCount ? [`${ticketCount} priority ticket${ticketCount > 1 ? 's' : ''}`] : []),
      `${capacityPct}% capacity`,
      `${totalGallons} gal`,
    ],
    keepOrder: false,
  };
}

function buildExplanation({ sectorLabel, depot, ticketCount, capacityPct, count }) {
  const parts = [`Groups ${count} nearby ${sectorLabel} stops out of ${depot.name} to minimize driving`];
  if (ticketCount > 0) parts.push(`prioritizing ${ticketCount} open UCO ticket${ticketCount > 1 ? 's' : ''}`);
  parts.push(`filling ~${capacityPct}% of the target route size`);
  return `${parts.join(', ')}.`;
}

function parsePct(improvement) {
  if (typeof improvement === 'number') return improvement;
  const m = String(improvement || '').match(/-?\d+/);
  return m ? Number(m[0]) : null;
}

/* ── Trace ────────────────────────────────────────────────── */

/** Lightweight snapshot of a route for trace playback / live map. */
function snapshotRoute(r) {
  return {
    id: r.id,
    routeName: r.routeName,
    serviceDate: r.serviceDate,
    depot: r.depot ? { name: r.depot.name, lat: r.depot.lat, lng: r.depot.lng } : null,
    stops: (r.stops || []).map((s) => ({ accountId: s.accountId, lat: s.lat, lng: s.lng })),
    totalStops: r.totalStops,
  };
}

/* ── Main entry ───────────────────────────────────────────── */

/**
 * Runs the planning pipeline over a date range and returns mock routes + a trace.
 * @param {object} params - { dateFrom, dateTo, recordType?, serviceLocationId?, maxRadiusMiles?, guidance... }
 * @param {(progress: object) => void} [onProgress] - receives { step, label, percent, counters, routes? }
 */
async function plan(params, onProgress = () => {}) {
  const opts = resolveOpts(params);
  opts.recordType = params.recordType || null;
  const days = dateRange(params.dateFrom, params.dateTo);
  // Only treat an explicit, positive number as a hard radius cap. null/undefined
  // means "no user cap" (previously Number(null)===0 excluded everything).
  const explicitRadius = params.maxRadiusMiles != null && params.maxRadiusMiles !== '' && Number(params.maxRadiusMiles) > 0
    ? Number(params.maxRadiusMiles)
    : null;

  const counters = { accountsFound: 0, accountsPlanned: 0, accountsExcluded: 0, daysPlanned: 0, routesPlanned: 0 };
  const warnings = [];
  const trace = [];
  const allRoutes = [];

  const emit = (step, label, percent, extra = null) => {
    const snap = { step, label, percent, counters: { ...counters }, routes: allRoutes.map(snapshotRoute), ts: Date.now(), ...(extra || {}) };
    trace.push(snap);
    onProgress(snap);
  };

  // Load depots first so we can anchor discovery on the selected Service Location.
  emit('loading_depots', 'Loading service locations', 8);
  const depots = await loadDepots({ recordType: opts.recordType, serviceLocationId: params.serviceLocationId || null });
  emit('loading_depots', `Loaded ${depots.length} service location(s)`, 14);

  if (depots.length === 0) {
    warnings.push('No service locations found for the selected scope.');
    emit('complete', 'Nothing to plan', 100);
    return { routes: [], summary: buildSummary([], counters, opts, params, days), warnings, trace };
  }

  // Anchor = the selected Service Location (locality mode). In "all depots" mode we
  // fall back to org-wide discovery (no anchor), preserving the broad behavior.
  const anchor = params.serviceLocationId
    ? (depots.find((d) => d.id === params.serviceLocationId) || depots[0])
    : null;

  // Discover eligible accounts near the anchor, expanding the radius outward until
  // we have enough to plan (or hit the ceiling). Explicit user radius disables growth.
  emit('discovering', 'Analyzing nearby accounts that need UCO service', 18);
  let accounts = [];
  let exclusions = { byReason: {}, sample: [] };
  let radiusUsed = null;
  if (anchor) {
    let radius = explicitRadius || DEFAULTS.defaultRadiusMiles;
    const ceiling = explicitRadius || DEFAULTS.maxRadiusMiles;
    const enough = Math.max(opts.minStopsPerRoute, 1);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      radiusUsed = radius;
      // eslint-disable-next-line no-await-in-loop
      const discovered = await discoverAccounts({
        dateFrom: days[0], dateTo: days[days.length - 1], recordType: opts.recordType, anchor, radiusMiles: radius,
      });
      accounts = discovered.accounts;
      exclusions = discovered.exclusions;
      emit('discovering', `Found ${accounts.length} account(s) due for service within ${radius} mi of ${anchor.name}`, 22);
      if (accounts.length >= enough || radius >= ceiling || explicitRadius) break;
      radius = Math.min(ceiling, Math.round(radius * DEFAULTS.radiusGrowthFactor));
    }
  } else {
    const discovered = await discoverAccounts({
      dateFrom: days[0], dateTo: days[days.length - 1], recordType: opts.recordType,
    });
    accounts = discovered.accounts;
    exclusions = discovered.exclusions;
  }

  // Exclude accounts already fixed in preserved (manually-edited / committed) routes
  // so a full re-plan cannot steal their stops.
  const excludeIds = new Set((params.excludeAccountIds || []).map(String));
  if (excludeIds.size) accounts = accounts.filter((a) => !excludeIds.has(a.Id));
  counters.accountsFound = accounts.length;
  counters.accountsExcluded = Object.values(exclusions.byReason).reduce((s, n) => s + n, 0);
  const estimatedCount = accounts.filter((a) => a._svc?.frequencySource === 'estimated_from_history' || a._svc?.frequencySource === 'fill_rate').length;
  emit(
    'discovering',
    `Selected ${accounts.length} account(s) due for service${radiusUsed ? ` within ${radiusUsed} mi` : ''} ` +
    `(${counters.accountsExcluded} not due, ${estimatedCount} with AI-estimated frequency)`,
    24,
    { dueAnalysis: { excludedByReason: exclusions.byReason, excludedSample: exclusions.sample, estimatedFrequencyCount: estimatedCount } },
  );

  if (accounts.length === 0) {
    warnings.push('No eligible accounts found near the selected Service Location for this range.');
    emit('complete', 'Nothing to plan', 100);
    return { routes: [], summary: buildSummary([], counters, opts, params, days), warnings, trace };
  }

  const byDay = bucketByDay(accounts, days);

  let dayIdx = 0;
  for (const day of days) {
    const dayAccounts = byDay.get(day) || [];
    counters.daysPlanned += 1;
    const basePct = 25 + Math.round((dayIdx / days.length) * 70);
    emit('assigning', `Planning ${day} (${dayAccounts.length} accounts)`, basePct);

    if (dayAccounts.length === 0) { dayIdx += 1; continue; }

    // Assign each account to nearest depot (single-depot mode already scoped depots to one).
    const assigned = new Map(depots.map((d) => [d.id, []]));
    for (const acct of dayAccounts) {
      let best = null;
      let bestDist = Infinity;
      for (const d of depots) {
        const dist = haversine(pt(acct), { lat: d.lat, lng: d.lng });
        if (dist < bestDist) { bestDist = dist; best = d; }
      }
      if (!best) continue;
      if (explicitRadius != null && bestDist > explicitRadius) { counters.accountsExcluded += 1; continue; }
      assigned.get(best.id).push(acct);
    }

    // Cluster each depot's accounts by bearing, split into soft-capacity bins.
    let routeIndex = allRoutes.filter((r) => r.serviceDate === day).length + 1;
    for (const depot of depots) {
      const depotAccts = assigned.get(depot.id) || [];
      if (depotAccts.length === 0) continue;

      const ordered = depotAccts
        .map((a) => ({ acct: a, brng: bearing({ lat: depot.lat, lng: depot.lng }, pt(a)) }))
        .sort((x, y) => x.brng - y.brng)
        .map((w) => w.acct);

      const groups = mergeUndersized(splitByCapacitySoft(ordered, day, opts), day, opts);
      for (const group of groups) {
        const label = sectorFor(meanBearing(group, depot), opts.sectorCount).label;
        // eslint-disable-next-line no-await-in-loop
        const route = await buildRoute(group, depot, label, day, opts, routeIndex);
        allRoutes.push(route);
        counters.routesPlanned = allRoutes.length;
        counters.accountsPlanned += route.totalStops;
        routeIndex += 1;
        emit('optimizing', `Optimizing ${day} route ${route.routeName}`, Math.min(95, basePct + 2));
      }
    }
    dayIdx += 1;
  }

  emit('finalizing', 'Finalizing plan', 98);
  const summary = buildSummary(allRoutes, counters, opts, params, days);
  emit('complete', `Planned ${allRoutes.length} route(s) across ${days.length} day(s)`, 100);

  logger.info('[planningPlanner] plan complete', { routes: allRoutes.length, days: days.length, accounts: counters.accountsPlanned });
  return { routes: allRoutes, summary, warnings, trace };
}

/**
 * Regenerates a single route from a fixed pool of accounts (its own stops plus any
 * extra accounts dragged in from the tray). Other routes are untouched, so the
 * regenerate can't steal their stops. Pure — no SF writes.
 * @param {object} params - { serviceDate, depot, accountIds, guidance... }
 * @param {object[]} accountPool - full account records (must include the accountIds)
 */
async function regenerateRoute(params, accountPool) {
  const opts = resolveOpts(params);
  opts.recordType = params.recordType || null;
  const ids = new Set((params.accountIds || []).map((id) => safeId(id)));
  const accounts = (accountPool || []).filter((a) => ids.has(a.Id));
  if (accounts.length === 0) return null;

  const depot = params.depot;
  const label = sectorFor(meanBearing(accounts, depot), opts.sectorCount).label;
  const route = await buildRoute(accounts, depot, label, params.serviceDate, opts, params.index || 1);
  route.id = params.routeId || route.id;
  return route;
}

function buildSummary(routes, counters, opts, params, days) {
  return {
    dateFrom: params.dateFrom,
    dateTo: params.dateTo || params.dateFrom,
    days,
    recordType: opts.recordType || null,
    serviceLocationId: params.serviceLocationId || null,
    routeCount: routes.length,
    totalStops: routes.reduce((s, r) => s + r.totalStops, 0),
    totalDistanceMi: round2(routes.reduce((s, r) => s + r.totalDistanceMi, 0)),
    totalDurationMin: routes.reduce((s, r) => s + r.totalDurationMin, 0),
    caps: {
      maxStops: opts.maxStops,
      minStopsPerRoute: opts.minStopsPerRoute,
      maxGallons: opts.maxGallons,
      maxDurationMin: opts.maxDurationMin,
      serviceTimeMin: opts.serviceTimeMin,
      avgSpeedMph: opts.avgSpeedMph,
    },
    counters,
  };
}

module.exports = { plan, regenerateRoute, discoverAccounts, fetchAccountsByIds, resolveOpts, estGallons, safeId, escapeSoql };
