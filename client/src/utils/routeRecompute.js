/**
 * Client-side route recomputation for manual combine/split on the review screen.
 * Re-sequences stops with a nearest-neighbor sweep from the depot and recomputes
 * metrics using the same constants the server planner used (carried in summary.caps).
 * No Salesforce writes happen here — edits stay in the in-memory preview until commit.
 */

const EARTH_RADIUS_MILES = 3958.8;
const DEFAULT_AVG_SPEED = 30;
const DEFAULT_SERVICE_MIN = 15;

function toRad(d) {
  return (d * Math.PI) / 180;
}

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** Nearest-neighbor ordering of stops starting from the depot. */
function sequence(stops, depot) {
  if (!depot || stops.length <= 2) return stops.slice();
  const remaining = stops.slice();
  const ordered = [];
  let current = { lat: depot.lat, lng: depot.lng };
  while (remaining.length) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(current, remaining[i]);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const [next] = remaining.splice(bestIdx, 1);
    ordered.push(next);
    current = next;
  }
  return ordered;
}

/** Recomputes ordering + metrics for a route after a manual edit. */
export function recomputeRoute(route, caps = {}, overrides = {}) {
  const avgSpeed = caps.avgSpeedMph || DEFAULT_AVG_SPEED;
  const serviceMin = caps.serviceTimeMin ?? DEFAULT_SERVICE_MIN;
  const depot = route.depot;

  const ordered = sequence(route.stops, depot).map((s, i) => ({ ...s, priority: i + 1 }));

  let distance = 0;
  if (depot && ordered.length) {
    let prev = { lat: depot.lat, lng: depot.lng };
    for (const s of ordered) { distance += haversine(prev, s); prev = s; }
    distance += haversine(prev, { lat: depot.lat, lng: depot.lng });
  }

  const distanceMi = Math.round(distance * 100) / 100;
  const driveTimeMin = Math.round((distanceMi / avgSpeed) * 60);
  const serviceTimeMin = ordered.length * serviceMin;
  const totalGallons = Math.round(ordered.reduce((s, x) => s + (x.estGallons || 0), 0) * 100) / 100;

  return {
    ...route,
    ...overrides,
    stops: ordered,
    accountIds: ordered.map((s) => s.accountId),
    totalStops: ordered.length,
    totalDistanceMi: distanceMi,
    driveTimeMin,
    serviceTimeMin,
    totalDurationMin: driveTimeMin + serviceTimeMin,
    totalGallons,
    optimizationScore: null, // manual edit — baseline comparison no longer applies
    _edited: true,
  };
}

/** Combines multiple routes into one (uses the first route's depot/record type). */
export function combineRoutes(routes, caps = {}) {
  const base = routes[0];
  const stops = routes.flatMap((r) => r.stops);
  const merged = {
    ...base,
    id: `preview-combined-${Date.now()}`,
    routeName: `${base.depot?.name || 'Route'} Combined ${base.serviceDate}`,
    stops,
  };
  return recomputeRoute(merged, caps);
}

/** Splits a route into two by current stop order. */
export function splitRoute(route, caps = {}) {
  const mid = Math.ceil(route.stops.length / 2);
  const ts = Date.now();
  const a = recomputeRoute(
    { ...route, id: `${route.id}-a-${ts}`, routeName: `${route.routeName} (A)`, stops: route.stops.slice(0, mid) },
    caps,
  );
  const b = recomputeRoute(
    { ...route, id: `${route.id}-b-${ts}`, routeName: `${route.routeName} (B)`, stops: route.stops.slice(mid) },
    caps,
  );
  return [a, b];
}

/** Recomputes summary totals after the route list changes. */
export function recomputeSummary(summary, routes) {
  return {
    ...summary,
    routeCount: routes.length,
    totalStops: routes.reduce((s, r) => s + r.totalStops, 0),
    totalDistanceMi: Math.round(routes.reduce((s, r) => s + r.totalDistanceMi, 0) * 100) / 100,
    totalDurationMin: routes.reduce((s, r) => s + r.totalDurationMin, 0),
  };
}
