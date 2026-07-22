const BaseSkill = require('./base');
const { getConnection } = require('../services/salesforce');
const { haversine } = require('../modules/distanceMatrix');
const {
  queryCandidateAccounts,
  isDueForAdd,
  mapCandidate,
  loadRecentlyDeclinedAddAccountIds,
} = require('../services/enhanceAddCandidates');

const DEFAULT_BUFFER_MI = 4;
const DEFAULT_MAX = 25;
const MI_PER_DEG_LAT = 69;

/** Degrees of lat/lng pad for a buffer in miles (lng scaled by cos(midLat)). */
function padDegrees(bufferMiles, midLat) {
  const latPad = bufferMiles / MI_PER_DEG_LAT;
  const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const lngPad = bufferMiles / (MI_PER_DEG_LAT * cos);
  return { latPad, lngPad };
}

/** Builds a stop bbox padded by bufferMiles (lat/lng degrees). */
function bboxFromStopsWithBuffer(stops, bufferMiles) {
  const lats = stops.map((s) => Number(s.Latitude__c)).filter((n) => Number.isFinite(n) && n !== 0);
  const lngs = stops.map((s) => Number(s.Longitude__c)).filter((n) => Number.isFinite(n) && n !== 0);
  if (!lats.length || !lngs.length) return null;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const { latPad, lngPad } = padDegrees(bufferMiles, midLat);
  return {
    minLat: Math.min(...lats) - latPad,
    maxLat: Math.max(...lats) + latPad,
    minLng: Math.min(...lngs) - lngPad,
    maxLng: Math.max(...lngs) + lngPad,
  };
}

/**
 * Approximate distance in miles from point P to segment AB (haversine to closest point).
 */
function distPointToSegmentMi(p, a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const same = Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9;
  if (same) return haversine(p, a);

  // Project in local degrees (scale lng by cos mid-lat), then convert closest point back.
  const midLat = (a.lat + b.lat) / 2;
  const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const ax = a.lng * cos;
  const ay = a.lat;
  const bx = b.lng * cos;
  const by = b.lat;
  const px = p.lng * cos;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const closest = { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
  return haversine(p, closest);
}

/** Min distance from a point to any consecutive stop-pair segment. */
function distToCorridorMi(p, pathPoints) {
  if (!pathPoints?.length) return Number.POSITIVE_INFINITY;
  if (pathPoints.length === 1) return haversine(p, pathPoints[0]);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pathPoints.length - 1; i++) {
    const d = distPointToSegmentMi(p, pathPoints[i], pathPoints[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

/** Matches a stop by 1-based index or partial account name. */
function findStop(stops, { index, name }) {
  if (index != null && Number.isFinite(Number(index))) {
    const i = Number(index) - 1;
    if (i >= 0 && i < stops.length) return stops[i];
  }
  if (name) {
    const q = String(name).toLowerCase();
    return stops.find((s) => (s.Account_Name__c || '').toLowerCase().includes(q)) || null;
  }
  return null;
}

/**
 * Finds due accounts near the path between route stops (corridor), for chat
 * "along the way / between stop A and B" requests.
 */
class RouteNearbyCandidatesSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_nearby_candidates',
      description:
        'Find due accounts along the current route path (or between two stops) that could be added. ' +
        'Use for "along the way", "between stop 1 and 2", "nearby / need service in between". ' +
        'Returns ranked candidates with distanceMi to the corridor. Then call route_edit_proposal with addAccountIds to propose adds.',
      inputSchema: {
        type: 'object',
        properties: {
          googleRouteId: { type: 'string', description: 'Google_Route__c Id of the open route.' },
          fromAccountName: { type: 'string', description: 'Optional start anchor account name (partial match).' },
          toAccountName: { type: 'string', description: 'Optional end anchor account name (partial match).' },
          fromStopIndex: { type: 'number', description: 'Optional 1-based start stop index from the stop list.' },
          toStopIndex: { type: 'number', description: 'Optional 1-based end stop index from the stop list.' },
          targetDate: { type: 'string', description: 'Service date YYYY-MM-DD (defaults to route Service_Date__c).' },
          bufferMiles: { type: 'number', description: `Corridor buffer in miles (default ${DEFAULT_BUFFER_MI}).` },
          maxResults: { type: 'number', description: `Max candidates to return (default ${DEFAULT_MAX}).` },
        },
        required: ['googleRouteId'],
      },
    });
  }

  async execute({
    googleRouteId,
    fromAccountName,
    toAccountName,
    fromStopIndex,
    toStopIndex,
    targetDate,
    bufferMiles = DEFAULT_BUFFER_MI,
    maxResults = DEFAULT_MAX,
  }) {
    const conn = await getConnection();
    const routes = await conn.query(
      `SELECT Id, Name, Service_Date__c, Shape__c,
        (SELECT Id, AccountId__c, Account_Name__c, Latitude__c, Longitude__c, Priority__c
         FROM Routes__r ORDER BY Priority__c ASC)
       FROM Google_Route__c WHERE Id = '${googleRouteId}'`
    );
    const route = routes.records?.[0];
    if (!route) return { error: 'Google Route not found', googleRouteId };

    const stops = route.Routes__r?.records || [];
    if (stops.length < 1) {
      return { googleRouteId, candidates: [], message: 'Route has no stops to build a corridor from.' };
    }

    const fromStop = findStop(stops, { index: fromStopIndex, name: fromAccountName });
    const toStop = findStop(stops, { index: toStopIndex, name: toAccountName });

    let segmentStops = stops;
    if (fromStop || toStop) {
      const fromIdx = fromStop ? stops.indexOf(fromStop) : 0;
      const toIdx = toStop ? stops.indexOf(toStop) : stops.length - 1;
      const lo = Math.min(fromIdx, toIdx);
      const hi = Math.max(fromIdx, toIdx);
      segmentStops = stops.slice(lo, hi + 1);
      if (segmentStops.length < 2 && stops.length >= 2) {
        // Single-anchor: use that stop + next/prev neighbor for a short segment.
        if (lo < stops.length - 1) segmentStops = stops.slice(lo, lo + 2);
        else segmentStops = stops.slice(Math.max(0, lo - 1), lo + 1);
      }
    }

    const pathPoints = segmentStops
      .map((s) => ({ lat: Number(s.Latitude__c), lng: Number(s.Longitude__c) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && !(p.lat === 0 && p.lng === 0));

    if (pathPoints.length < 1) {
      return { googleRouteId, candidates: [], message: 'Segment has no valid coordinates.' };
    }

    const buffer = Number(bufferMiles) > 0 ? Number(bufferMiles) : DEFAULT_BUFFER_MI;
    const bbox = bboxFromStopsWithBuffer(segmentStops, buffer);
    const excludeAccountIds = stops.map((s) => s.AccountId__c).filter(Boolean);
    const serviceDate = String(targetDate || route.Service_Date__c || '').slice(0, 10)
      || new Date().toISOString().slice(0, 10);

    const rawAccounts = await queryCandidateAccounts(conn, {
      excludeAccountIds,
      shapeIds: route.Shape__c ? [route.Shape__c] : [],
      bbox,
    });

    const dueAccounts = rawAccounts.filter((a) => isDueForAdd(a, serviceDate));
    const declinedIds = await loadRecentlyDeclinedAddAccountIds(conn, dueAccounts.map((a) => a.Id));
    const eligible = dueAccounts.filter((a) => !declinedIds.has(a.Id));

    const mapped = eligible.map((a) => {
      const base = mapCandidate(a, serviceDate, { routeShapeId: route.Shape__c || null });
      const p = { lat: Number(a.MALatitude__c), lng: Number(a.MALongitude__c) };
      const distanceMi = distToCorridorMi(p, pathPoints);
      return { ...base, distanceMi: Math.round(distanceMi * 100) / 100 };
    })
      .filter((c) => c.distanceMi <= buffer)
      .sort((a, b) => {
        if (a.distanceMi !== b.distanceMi) return a.distanceMi - b.distanceMi;
        if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
        return (Number(b.estimatedGallonsAtDate) || 0) - (Number(a.estimatedGallonsAtDate) || 0);
      })
      .slice(0, Math.min(Number(maxResults) || DEFAULT_MAX, 40));

    return {
      googleRouteId,
      routeName: route.Name,
      serviceDate,
      segment: {
        from: segmentStops[0]?.Account_Name__c || null,
        to: segmentStops[segmentStops.length - 1]?.Account_Name__c || null,
        stopCount: segmentStops.length,
        bufferMiles: buffer,
      },
      candidates: mapped.map((c) => ({
        accountId: c.accountId,
        accountName: c.accountName,
        lat: c.lat,
        lng: c.lng,
        distanceMi: c.distanceMi,
        daysOverdue: c.daysOverdue,
        nextDueDate: c.nextDueDate,
        estimatedGallonsAtDate: c.estimatedGallonsAtDate,
        dueReason: c.dueReason,
        address: null,
      })),
      stats: {
        queried: rawAccounts.length,
        due: dueAccounts.length,
        declinedExcluded: declinedIds.size,
        returned: mapped.length,
      },
      hint: mapped.length
        ? 'Propose adds with route_edit_proposal using addAccountIds from these candidates (manager approval required).'
        : 'No due accounts found in the corridor buffer — try a larger bufferMiles or different segment.',
    };
  }
}

module.exports = RouteNearbyCandidatesSkill;
