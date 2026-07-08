import { isValidCoord } from './routePolyline';

/**
 * Client-side stop ordering used for instant preview after an add/remove, so the
 * list and map show an optimized order without a server Google callout on every
 * edit. Routes up to the Google waypoint cap use the Directions API
 * (`optimizeWaypoints`); larger routes fall back to a local haversine
 * nearest-neighbor + 2-opt heuristic. The authoritative optimization still runs
 * server-side on "Save & Optimize".
 */

const EARTH_RADIUS_MILES = 3958.8;
// Google Directions allows origin + destination + up to 25 intermediate
// waypoints; stay at/under 25 stops before switching to the local heuristic.
const GOOGLE_WAYPOINT_LIMIT = 25;

const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance (miles) between two {lat,lng} points. */
function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** Extracts a numeric {lat,lng} from a Route__c-shaped stop. */
function coordOf(stop) {
  const lat = Number(stop.Latitude__c ?? stop.MALatitude__c);
  const lng = Number(stop.Longitude__c ?? stop.MALongitude__c);
  return { lat, lng };
}

function hasCoords(stop) {
  const { lat, lng } = coordOf(stop);
  return isValidCoord(lat, lng);
}

/** Nearest-neighbor ordering of `stops` starting from `origin`. */
function nearestNeighbor(stops, origin) {
  const remaining = stops.slice();
  const ordered = [];
  let current = origin || coordOf(remaining[0]);
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const d = haversine(current, coordOf(remaining[i]));
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    current = coordOf(next);
  }
  return ordered;
}

function reverseSegment(arr, i, k) {
  while (i < k) {
    const tmp = arr[i];
    arr[i] = arr[k];
    arr[k] = tmp;
    i += 1;
    k -= 1;
  }
}

/**
 * 2-opt refinement of an open path from `origin` through `order` to `end`
 * (end optional). Uses incremental edge deltas and restarts after each
 * improving swap; guarded to keep it cheap for large routes.
 */
function twoOpt(order, origin, end) {
  const n = order.length;
  if (n < 3) return order;
  const best = order.slice();
  let guard = 0;
  let improved = true;
  while (improved && guard < 60) {
    guard += 1;
    improved = false;
    for (let i = 0; i < n - 1 && !improved; i += 1) {
      const prev = i === 0 ? origin : coordOf(best[i - 1]);
      for (let k = i + 1; k < n; k += 1) {
        const a = coordOf(best[i]);
        const b = coordOf(best[k]);
        const next = k < n - 1 ? coordOf(best[k + 1]) : end;
        let delta;
        if (!next) {
          // Reversing the open tail only swaps the (prev → i) edge for (prev → k).
          delta = haversine(prev, b) - haversine(prev, a);
        } else {
          const before = haversine(prev, a) + haversine(b, next);
          const after = haversine(prev, b) + haversine(a, next);
          delta = after - before;
        }
        if (delta < -1e-9) {
          reverseSegment(best, i, k);
          improved = true;
          break;
        }
      }
    }
  }
  return best;
}

/** Ask the Google Directions API for an optimized waypoint order (indices). */
function googleWaypointOrder(origin, destination, stops) {
  return new Promise((resolve) => {
    if (!window.google?.maps) { resolve(null); return; }
    const service = new google.maps.DirectionsService();
    service.route(
      {
        origin,
        destination,
        waypoints: stops.map((s) => ({ location: coordOf(s), stopover: true })),
        optimizeWaypoints: true,
        travelMode: google.maps.TravelMode.DRIVING,
      },
      (result, status) => {
        const order = result?.routes?.[0]?.waypoint_order;
        resolve(status === 'OK' && Array.isArray(order) ? order : null);
      },
    );
  });
}

/** Local heuristic ordering; keeps `Fixed_point__c` stops at their current index. */
function localOptimize(stops, startPt, endPt) {
  const origin = startPt || coordOf(stops[0]);
  const hasFixed = stops.some((s) => s.Fixed_point__c);
  if (!hasFixed) {
    return twoOpt(nearestNeighbor(stops, origin), origin, endPt);
  }
  const fixedByIndex = new Map();
  const free = [];
  stops.forEach((s, i) => {
    if (s.Fixed_point__c) fixedByIndex.set(i, s);
    else free.push(s);
  });
  const orderedFree = twoOpt(nearestNeighbor(free, origin), origin, endPt);
  const result = [];
  let f = 0;
  for (let i = 0; i < stops.length; i += 1) {
    if (fixedByIndex.has(i)) result.push(fixedByIndex.get(i));
    else { result.push(orderedFree[f]); f += 1; }
  }
  return result;
}

/**
 * Returns `stops` reordered for the shortest driving preview. Stops without
 * valid coordinates are appended in their original order.
 *
 * @param {Array<object>} stops Route__c-shaped stops.
 * @param {{start?:{lat,lng}|null, end?:{lat,lng}|null}} depots Service-location anchors.
 * @returns {Promise<Array<object>>} Reordered stops.
 */
export async function optimizeStopOrder(stops, { start = null, end = null } = {}) {
  const valid = stops.filter(hasCoords);
  const invalid = stops.filter((s) => !hasCoords(s));
  if (valid.length <= 1) return stops.slice();

  const startPt = start && isValidCoord(start.lat, start.lng) ? start : null;
  const endPt = end && isValidCoord(end.lat, end.lng) ? end : null;
  const hasFixed = valid.some((s) => s.Fixed_point__c);
  const canUseGoogle =
    !hasFixed && !!window.google?.maps && valid.length <= GOOGLE_WAYPOINT_LIMIT && (startPt || endPt);

  let ordered;
  if (canUseGoogle) {
    const origin = startPt || endPt;
    const dest = endPt || startPt;
    const waypointOrder = await googleWaypointOrder(origin, dest, valid);
    ordered = waypointOrder ? waypointOrder.map((i) => valid[i]) : localOptimize(valid, startPt, endPt);
  } else {
    ordered = localOptimize(valid, startPt, endPt);
  }

  return [...ordered, ...invalid];
}
