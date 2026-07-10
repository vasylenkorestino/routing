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
 * Eligibility (planning mode): Account_Status__c = 'Active', valid coordinates,
 * not already routed, and (UCO_Collection__c = true OR an open UCO Collection
 * priority ticket). Gallon estimates factor equipment + service history.
 */

const { loadDepots, bearing, sectorFor } = require('./serviceLocationPlanner');
const sf = require('../services/salesforce');
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
  gallonDuePct: 0.75, // predicted fill >= this fraction of capacity => likely due
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
  'Last_Service_Date__c, Expected_Date_Of_Service__c, Equipment_Type__c, ' +
  'Container_Size_number__c, ContainerCapacity__c, Estimated_GPM__c, Number_Of_Fryers__c, ' +
  'Pickup_Frequency_in_Days__c, Estimated_Pickup_Frequency__c, RelatedServiceLocation__c, ' +
  "(SELECT Id, Qty_Gallons__c FROM Services__r WHERE RecordType.Name = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 3), " +
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

/** Parses a pickup cadence (in days) from the numeric or text frequency fields. */
function parseCadenceDays(a) {
  const days = Number(a.Pickup_Frequency_in_Days__c);
  if (Number.isFinite(days) && days > 0) return days;
  const txt = String(a.Estimated_Pickup_Frequency__c || '').toLowerCase();
  if (/week/.test(txt)) return /bi|two|2/.test(txt) ? 14 : 7;
  if (/month/.test(txt)) return 30;
  if (/quarter/.test(txt)) return 90;
  const n = parseFloat(txt);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Adds N days to a YYYY-MM-DD (or ISO) date and returns YYYY-MM-DD. */
function addDaysISO(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

/**
 * Predicts whether an account is likely to need UCO service by the target date,
 * using operational + historical signals (not just static flags):
 *   - an open UCO Collection ticket (always due),
 *   - a scheduled Expected_Date_Of_Service on/before the target,
 *   - cadence: last service + pickup frequency lands on/before the target,
 *   - accrual: predicted gallons since last service near container capacity.
 */
function isLikelyDue(a, targetDate, opts) {
  if (a._hasOpenTicket) return true;

  const exp = a.Expected_Date_Of_Service__c;
  if (exp && String(exp).slice(0, 10) <= targetDate) return true;

  const last = a.Last_Service_Date__c ? String(a.Last_Service_Date__c).slice(0, 10) : null;
  if (last) {
    const cadence = parseCadenceDays(a);
    if (cadence && addDaysISO(last, cadence) <= targetDate) return true;

    // Gallon-accrual prediction from Service__c history + equipment.
    const capacity = Number(a.ContainerCapacity__c) || Number(a.Container_Size_number__c);
    const predicted = estGallons(a, targetDate, opts);
    if (Number.isFinite(capacity) && capacity > 0 && predicted >= capacity * opts.gallonDuePct) return true;
  }

  return false;
}

/**
 * Finds accounts eligible for planning within the range, anchored on the selected
 * Service Location and expanding outward. Returns accounts JS-filtered to
 * (UCO_Collection true OR open UCO ticket), predicted to be due by the target date,
 * excluding any already on an incomplete Route__c in the window, sorted nearest-first.
 *
 * @param {object} p
 * @param {{lat:number,lng:number}} [p.anchor] - Service Location coordinates to expand from.
 * @param {number} [p.radiusMiles] - bounding radius around the anchor (omitted => whole scope).
 */
async function discoverAccounts({ dateFrom, dateTo, recordType, anchor = null, radiusMiles = null, opts = DEFAULTS }) {
  const target = dateTo || dateFrom;
  const routed = await sf.query(
    `SELECT AccountId__c FROM Route__c ` +
    `WHERE DateOfService__c >= ${dateFrom} AND DateOfService__c <= ${target} ` +
    `AND AccountId__c != null AND Status__c != 'Complete'`,
  );
  const alreadyRouted = new Set(routed.map((r) => r.AccountId__c));

  let soql =
    `SELECT ${ACCOUNT_FIELDS} FROM Account ` +
    "WHERE Ignore_For_Routing__c = false AND Account_Status__c = 'Active' " +
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
  soql += `AND (Expected_Date_Of_Service__c <= ${target} OR Expected_Date_Of_Service__c = null) `;
  soql += 'ORDER BY Expected_Date_Of_Service__c ASC NULLS LAST LIMIT 5000';

  const rows = await sf.query(soql);

  return rows
    .filter((a) => !alreadyRouted.has(a.Id))
    .map(decorateAccount)
    .map((a) => ({ ...a, _distMi: anchor ? round2(haversine(anchor, pt(a))) : null }))
    // Bounding box is square; enforce the true circular radius here.
    .filter((a) => !(anchor && radiusMiles) || a._distMi <= radiusMiles)
    .filter((a) => a.UCO_Collection__c === true || a._hasOpenTicket)
    .filter((a) => isLikelyDue(a, target, opts))
    .sort((x, y) => (x._distMi ?? 0) - (y._distMi ?? 0));
}

/** Fetches specific accounts by Id with the fields the planner needs (used by regenerate). */
async function fetchAccountsByIds(ids) {
  const safe = [...new Set((ids || []).map((id) => safeId(id)))];
  if (safe.length === 0) return [];
  const idList = safe.map((id) => `'${id}'`).join(',');
  const rows = await sf.query(`SELECT ${ACCOUNT_FIELDS} FROM Account WHERE Id IN (${idList})`);
  return rows.map(decorateAccount);
}

/** Estimated gallons to collect at a stop, factoring equipment + service history. */
function estGallons(acct, targetDate, opts) {
  const containerNum = Number(acct.Container_Size_number__c);
  const capacity = Number(acct.ContainerCapacity__c);
  const gpm = parseFloat(acct.Estimated_GPM__c);
  const lastServiceGallons = Number(acct._lastGallons);

  // Accrual since last service using estimated gallons/month.
  if (Number.isFinite(gpm) && gpm > 0 && acct.Last_Service_Date__c) {
    const last = new Date(`${acct.Last_Service_Date__c}T00:00:00Z`);
    const target = new Date(`${targetDate}T00:00:00Z`);
    const months = Math.max(0, (target - last) / (1000 * 60 * 60 * 24 * 30));
    const accrued = gpm * months;
    const cap = Number.isFinite(capacity) && capacity > 0
      ? capacity
      : (Number.isFinite(containerNum) && containerNum > 0 ? containerNum : accrued);
    const est = Math.min(accrued, cap);
    if (est > 0) return round2(est);
  }

  if (Number.isFinite(lastServiceGallons) && lastServiceGallons > 0) return lastServiceGallons;
  if (Number.isFinite(containerNum) && containerNum > 0) return round2(containerNum * 0.75);
  return opts.defaultGallons;
}

/**
 * Buckets accounts to the earliest eligible day within the range, avoiding
 * double-booking (an account is placed on exactly one day of the session).
 * Accounts with a specific Expected_Date_Of_Service__c land on that day (clamped
 * into the range); accounts with no expected date land on the first day.
 */
function bucketByDay(accounts, days) {
  const first = days[0];
  const last = days[days.length - 1];
  const byDay = new Map(days.map((d) => [d, []]));
  for (const a of accounts) {
    let day = first;
    const exp = a.Expected_Date_Of_Service__c;
    if (exp) {
      const e = String(exp).slice(0, 10);
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
  const stops = accounts.map((a) => ({
    accountId: a.Id,
    accountName: a.Name,
    lat: Number(a.MALatitude__c),
    lng: Number(a.MALongitude__c),
    address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
    lastServiceDate: a.Last_Service_Date__c ? String(a.Last_Service_Date__c).slice(0, 10) : null,
    estGallons: estGallons(a, targetDate, opts),
    hasOpenTicket: !!a._hasOpenTicket,
    ticketDriven: a.UCO_Collection__c !== true && !!a._hasOpenTicket,
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
  opts.gallonDuePct = DEFAULTS.gallonDuePct;
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

  const emit = (step, label, percent) => {
    const snap = { step, label, percent, counters: { ...counters }, routes: allRoutes.map(snapshotRoute), ts: Date.now() };
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
  let radiusUsed = null;
  if (anchor) {
    let radius = explicitRadius || DEFAULTS.defaultRadiusMiles;
    const ceiling = explicitRadius || DEFAULTS.maxRadiusMiles;
    const enough = Math.max(opts.minStopsPerRoute, 1);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      radiusUsed = radius;
      // eslint-disable-next-line no-await-in-loop
      accounts = await discoverAccounts({
        dateFrom: days[0], dateTo: days[days.length - 1], recordType: opts.recordType, anchor, radiusMiles: radius, opts,
      });
      emit('discovering', `Found ${accounts.length} account(s) within ${radius} mi of ${anchor.name}`, 22);
      if (accounts.length >= enough || radius >= ceiling || explicitRadius) break;
      radius = Math.min(ceiling, Math.round(radius * DEFAULTS.radiusGrowthFactor));
    }
  } else {
    accounts = await discoverAccounts({
      dateFrom: days[0], dateTo: days[days.length - 1], recordType: opts.recordType, opts,
    });
  }

  // Exclude accounts already fixed in preserved (manually-edited / committed) routes
  // so a full re-plan cannot steal their stops.
  const excludeIds = new Set((params.excludeAccountIds || []).map(String));
  if (excludeIds.size) accounts = accounts.filter((a) => !excludeIds.has(a.Id));
  counters.accountsFound = accounts.length;
  emit('discovering', `Selected ${accounts.length} eligible account(s)${radiusUsed ? ` within ${radiusUsed} mi` : ''}`, 24);

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
