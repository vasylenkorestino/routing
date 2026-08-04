/**
 * Due-aware ADD candidate selection for AI Enhance.
 * Hard-filters nearby accounts with serviceDue.evaluateAccount, scopes by
 * route/neighbor shapes (bbox fallback), and excludes recently declined ADDs.
 */

const { accountRoutingFilterClause } = require('../utils/accountRoutingFilters');
const {
  ACCOUNT_DUE_FIELDS,
  evaluateAccount,
  daysBetween,
} = require('../modules/serviceDue');
const { withServiceHistory } = require('../modules/serviceHistoryLoader');
const { evaluateMustRemainOnRoute, remainReasonLabel } = require('../modules/routeKeepRules');

const BBOX_PAD = 0.15;
const SOQL_LIMIT = 200;
const CANDIDATE_CAP = 40;
const DECLINED_ADD_LOOKBACK_DAYS = 45;

/** Escapes a Salesforce Id for SOQL string literals. */
function escId(id) {
  return String(id).replace(/'/g, "\\'");
}

/** YYYY-MM-DD for today UTC minus N days. */
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Builds a stop-centroid bbox from route stop records.
 * @returns {{ minLat, maxLat, minLng, maxLng }|null}
 */
function bboxFromStops(stops = []) {
  const lats = stops.map((s) => Number(s.Latitude__c)).filter((n) => Number.isFinite(n) && n !== 0);
  const lngs = stops.map((s) => Number(s.Longitude__c)).filter((n) => Number.isFinite(n) && n !== 0);
  if (!lats.length || !lngs.length) return null;
  return {
    minLat: Math.min(...lats) - BBOX_PAD,
    maxLat: Math.max(...lats) + BBOX_PAD,
    minLng: Math.min(...lngs) - BBOX_PAD,
    maxLng: Math.max(...lngs) + BBOX_PAD,
  };
}

/**
 * Discovers neighbor Shape__c Ids from accounts in the stop bbox
 * (shapes present nearby that are not the route/stop shapes).
 */
async function discoverNeighborShapeIds(conn, bbox, primaryShapeIds) {
  if (!bbox) return [];
  const primary = new Set((primaryShapeIds || []).filter(Boolean));
  const q = `
    SELECT Shape__c
    FROM Account
    WHERE MALatitude__c >= ${bbox.minLat} AND MALatitude__c <= ${bbox.maxLat}
      AND MALongitude__c >= ${bbox.minLng} AND MALongitude__c <= ${bbox.maxLng}
      AND Shape__c != null
      AND ${accountRoutingFilterClause()}
    LIMIT 200
  `;
  const res = await conn.query(q);
  const neighbors = new Set();
  for (const a of res.records || []) {
    if (a.Shape__c && !primary.has(a.Shape__c)) neighbors.add(a.Shape__c);
  }
  return [...neighbors];
}

/**
 * Loads stop-account Shape__c values for neighbor discovery.
 */
async function loadStopAccountShapes(conn, accountIds = []) {
  if (!accountIds.length) return [];
  const ids = accountIds.map((id) => `'${escId(id)}'`).join(',');
  const res = await conn.query(`SELECT Id, Shape__c FROM Account WHERE Id IN (${ids}) AND Shape__c != null`);
  return [...new Set((res.records || []).map((a) => a.Shape__c).filter(Boolean))];
}

/** Account SELECT fields for due-aware ADD candidates. */
function candidateSelectClause() {
  // Tank_Size__c comes from ACCOUNT_DUE_FIELDS — do not list it again.
  return `
    Id, Name, ShippingStreet, ShippingCity, ShippingState,
    MALatitude__c, MALongitude__c, Last_Service_Date__c, DaysInterval__c,
    Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
    Ignore_For_Routing__c, Rotisserie_Collection__c, Shape__c, Shape_Name__c,
    ${ACCOUNT_DUE_FIELDS}
  `;
}

/**
 * Queries candidate accounts by shape set and/or bbox.
 */
async function queryCandidateAccounts(conn, {
  excludeAccountIds = [],
  shapeIds = [],
  bbox = null,
} = {}) {
  const exclude = excludeAccountIds.filter(Boolean);
  const excludeClause = exclude.length
    ? `AND Id NOT IN (${exclude.map((id) => `'${escId(id)}'`).join(',')})`
    : '';

  const shapes = [...new Set(shapeIds.filter(Boolean))];
  const shapeClause = shapes.length
    ? `Shape__c IN (${shapes.map((id) => `'${escId(id)}'`).join(',')})`
    : null;
  const bboxClause = bbox
    ? `(MALatitude__c >= ${bbox.minLat} AND MALatitude__c <= ${bbox.maxLat}
       AND MALongitude__c >= ${bbox.minLng} AND MALongitude__c <= ${bbox.maxLng})`
    : null;

  let geoClause;
  if (shapeClause && bboxClause) {
    geoClause = `(${shapeClause} OR ${bboxClause})`;
  } else if (shapeClause) {
    geoClause = shapeClause;
  } else if (bboxClause) {
    geoClause = bboxClause;
  } else {
    return [];
  }

  const q = `
    SELECT ${candidateSelectClause()}
    FROM Account
    WHERE ${geoClause}
      ${excludeClause}
      AND ${accountRoutingFilterClause()}
      AND MALatitude__c != null AND MALongitude__c != null
    LIMIT ${SOQL_LIMIT}
  `;
  const res = await conn.query(q);
  return withServiceHistory(conn, res.records || []);
}

/** True when Reason__c is an AI Enhance ADD recommendation. */
function isAddReason(reason) {
  return /^\s*\[ADD\]/i.test(String(reason || ''));
}

/**
 * Accounts with a Declined [ADD] RouteLog in the lookback window (any route).
 * Reason__c is Long Text Area — cannot filter in SOQL; filter in memory.
 * @returns {Promise<Set<string>>}
 */
async function loadRecentlyDeclinedAddAccountIds(conn, accountIds = []) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const since = daysAgoISO(DECLINED_ADD_LOOKBACK_DAYS);
  const idList = ids.map((id) => `'${escId(id)}'`).join(',');

  const pickDeclinedAdds = (records) => new Set(
    (records || [])
      .filter((r) => isAddReason(r.Reason__c))
      .map((r) => r.Account__c)
      .filter(Boolean),
  );

  const q = `
    SELECT Account__c, Reason__c
    FROM RouteLog__c
    WHERE Skill__c = 'AI Enhance'
      AND Status__c = 'Declined'
      AND Account__c IN (${idList})
      AND (Accepted_Date__c >= ${since}T00:00:00.000Z OR CreatedDate >= ${since}T00:00:00.000Z)
    LIMIT 500
  `;
  try {
    const res = await conn.query(q);
    return pickDeclinedAdds(res.records);
  } catch {
    // Accepted_Date__c datetime filter can fail in some orgs — retry on CreatedDate only.
    const fallback = `
      SELECT Account__c, Reason__c
      FROM RouteLog__c
      WHERE Skill__c = 'AI Enhance'
        AND Status__c = 'Declined'
        AND Account__c IN (${idList})
        AND CreatedDate >= ${since}T00:00:00.000Z
      LIMIT 500
    `;
    const res = await conn.query(fallback);
    return pickDeclinedAdds(res.records);
  }
}

/**
 * True when the account is due for serviceDate, or must remain (CDL / first-3 UCO).
 * Mature recently-serviced accounts stay out after last-service resolution.
 */
function isDueForAdd(account, serviceDate) {
  const svc = evaluateAccount(account, serviceDate);
  if (svc.due) return true;
  const remain = evaluateMustRemainOnRoute(account, serviceDate);
  return !!remain.mustRemainOnRoute;
}

/**
 * Maps a SF Account + due evaluation into the Claude ADD payload shape.
 */
function mapCandidate(account, serviceDate, { routeShapeId = null, neighborShapeIds = [] } = {}) {
  const svc = evaluateAccount(account, serviceDate);
  const remain = evaluateMustRemainOnRoute(account, serviceDate);
  const daysOverdue = svc.due && svc.nextDueDate
    ? Math.max(0, daysBetween(svc.nextDueDate, serviceDate))
    : 0;
  const shapeId = account.Shape__c || null;
  const inRouteShape = !!(routeShapeId && shapeId === routeShapeId);
  const inNeighborShape = !!(shapeId && neighborShapeIds.includes(shapeId));
  const services = account.Services__r?.records || account.Services__r || [];

  return {
    accountId: account.Id,
    accountName: account.Name,
    lat: account.MALatitude__c,
    lng: account.MALongitude__c,
    lastServiceDate: svc.lastServiceDate || account.Last_Service_Date__c || null,
    nextDueDate: svc.nextDueDate,
    effectiveFrequencyDays: svc.effectiveFrequencyDays,
    frequencyLabel: svc.frequencyLabel,
    daysOverdue,
    estimatedGallonsAtDate: svc.estimatedGallonsAtDate,
    dueReason: svc.reason,
    mustRemainOnRoute: remain.mustRemainOnRoute,
    remainReason: remain.remainReason,
    remainReasonLabel: remainReasonLabel(remain.remainReason),
    ucoServiceCount: remain.ucoServiceCount,
    cdlDeliveryDate: remain.cdlDeliveryDate,
    tankSize: account.Tank_Size__c,
    secondContainer: account.Second_Container__c,
    priorityTier: account.Priority_Tier__c,
    routeNotes: account.Route_Notes__c,
    specialInstructions: account.Notes__c,
    shapeId,
    shapeName: account.Shape_Name__c || null,
    inRouteShape,
    inNeighborShape,
    // GPD history span (oldest→newest positive UCO) — NOT pickup cadence / overdue.
    gpdHistorySpanDays: account.DaysInterval__c,
    recentServices: services.map((sv) => ({
      gallons: sv.Qty_Gallons__c,
      date: sv.Service_Date__c,
      recordType: sv.RecordType?.Name || null,
    })),
  };
}

/**
 * Rank due candidates: more overdue first, then higher estimated gallons.
 */
function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
    const ga = Number(a.estimatedGallonsAtDate) || 0;
    const gb = Number(b.estimatedGallonsAtDate) || 0;
    if (gb !== ga) return gb - ga;
    // Prefer route shape over neighbor over bbox-only.
    const score = (c) => (c.inRouteShape ? 2 : 0) + (c.inNeighborShape ? 1 : 0);
    return score(b) - score(a);
  });
}

/**
 * Loads due-aware ADD candidates for a Google Route.
 *
 * @param {object} conn - jsforce connection
 * @param {object} opts
 * @param {object} opts.googleRoute - Google_Route__c (needs Id, Service_Date__c, Shape__c)
 * @param {object[]} opts.stops - Route__c stop records with AccountId__c / lat/lng
 * @param {object} [opts.recorder] - optional step recorder
 * @returns {Promise<{ candidates, rawById, stats }>}
 */
async function loadEnhanceAddCandidates(conn, { googleRoute, stops = [], recorder = null } = {}) {
  const wrap = async (label, fn, input) => {
    if (recorder?.wrap) return recorder.wrap(label, 'SOQL', fn, { input });
    return fn();
  };

  const serviceDate = String(googleRoute?.Service_Date__c || '').slice(0, 10)
    || new Date().toISOString().slice(0, 10);
  const excludeAccountIds = stops.map((s) => s.AccountId__c).filter(Boolean);
  const bbox = bboxFromStops(stops);
  const routeShapeId = googleRoute?.Shape__c || null;

  const stopShapes = await wrap(
    'Load stop account shapes',
    () => loadStopAccountShapes(conn, excludeAccountIds),
    { count: excludeAccountIds.length },
  );
  const primaryShapes = [...new Set([routeShapeId, ...stopShapes].filter(Boolean))];
  const neighborShapeIds = await wrap(
    'Discover neighbor shapes',
    () => discoverNeighborShapeIds(conn, bbox, primaryShapes),
    { primary: primaryShapes.length },
  );
  const shapeIds = [...new Set([...primaryShapes, ...neighborShapeIds])];

  const rawAccounts = await wrap(
    'Find ADD candidate accounts',
    () => queryCandidateAccounts(conn, { excludeAccountIds, shapeIds, bbox }),
    { shapes: shapeIds.length, hasBbox: !!bbox },
  );

  const dueAccounts = rawAccounts.filter((a) => isDueForAdd(a, serviceDate));
  const declinedIds = await wrap(
    'Load declined ADD accounts',
    () => loadRecentlyDeclinedAddAccountIds(conn, dueAccounts.map((a) => a.Id)),
    { due: dueAccounts.length },
  );

  const eligible = dueAccounts.filter((a) => !declinedIds.has(a.Id));
  const mapped = eligible.map((a) => mapCandidate(a, serviceDate, { routeShapeId, neighborShapeIds }));
  const ranked = rankCandidates(mapped).slice(0, CANDIDATE_CAP);

  const rawById = {};
  for (const a of rawAccounts) rawById[a.Id] = a;

  return {
    candidates: ranked,
    rawById,
    stats: {
      serviceDate,
      queried: rawAccounts.length,
      due: dueAccounts.length,
      declinedExcluded: declinedIds.size,
      returned: ranked.length,
      routeShapeId,
      neighborShapeCount: neighborShapeIds.length,
    },
  };
}

module.exports = {
  BBOX_PAD,
  CANDIDATE_CAP,
  DECLINED_ADD_LOOKBACK_DAYS,
  bboxFromStops,
  isDueForAdd,
  mapCandidate,
  rankCandidates,
  loadEnhanceAddCandidates,
  loadRecentlyDeclinedAddAccountIds,
  queryCandidateAccounts,
  isAddReason,
  // Exported for unit tests
  daysAgoISO,
};
