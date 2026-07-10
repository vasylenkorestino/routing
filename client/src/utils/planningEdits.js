/**
 * Client-side edit helpers for the AI Route Planning workspace.
 *
 * Operate purely on in-memory mock routes (same shape the planner returns).
 * "Keep order" recompute preserves the user's manual stop sequence and only
 * recomputes metrics, so drag/reorder never gets silently re-sequenced. Combine
 * reuses the optimized recompute from routeRecompute so merged routes are tidy.
 */

import { recomputeRoute, splitRoute as splitOptimized } from './routeRecompute';

const EARTH_RADIUS_MILES = 3958.8;
const DEFAULT_AVG_SPEED = 30;
const DEFAULT_SERVICE_MIN = 15;

function toRad(d) { return (d * Math.PI) / 180; }

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

function round2(n) { return Math.round(n * 100) / 100; }

/** Recomputes metrics for a route while PRESERVING the current stop order. */
export function recomputeKeepingOrder(route, caps = {}) {
  const avgSpeed = caps.avgSpeedMph || DEFAULT_AVG_SPEED;
  const serviceMin = caps.serviceTimeMin ?? DEFAULT_SERVICE_MIN;
  const depot = route.depot;
  const stops = (route.stops || []).map((s, i) => ({ ...s, priority: i + 1 }));

  let distance = 0;
  if (depot && stops.length) {
    let prev = { lat: depot.lat, lng: depot.lng };
    for (const s of stops) { distance += haversine(prev, s); prev = s; }
    distance += haversine(prev, { lat: depot.lat, lng: depot.lng });
  }
  const distanceMi = round2(distance);
  const driveTimeMin = Math.round((distanceMi / avgSpeed) * 60);
  const serviceTimeMin = stops.length * serviceMin;
  const totalGallons = round2(stops.reduce((s, x) => s + (x.estGallons || 0), 0));

  return {
    ...route,
    stops,
    accountIds: stops.map((s) => s.accountId),
    totalStops: stops.length,
    totalDistanceMi: distanceMi,
    driveTimeMin,
    serviceTimeMin,
    totalDurationMin: driveTimeMin + serviceTimeMin,
    totalGallons,
    optimizationScore: null,
    keepOrder: true,
    _edited: true,
  };
}

/** Reorders a stop within a single route (drag within a list). */
export function reorderStop(routes, routeId, fromIndex, toIndex, caps) {
  return routes.map((r) => {
    if (r.id !== routeId) return r;
    const stops = r.stops.slice();
    const [moved] = stops.splice(fromIndex, 1);
    stops.splice(toIndex, 0, moved);
    return recomputeKeepingOrder({ ...r, stops }, caps);
  });
}

/** Moves a stop from one route to another at a target index. */
export function moveStop(routes, fromRouteId, toRouteId, accountId, toIndex, caps) {
  if (fromRouteId === toRouteId) return routes;
  const from = routes.find((r) => r.id === fromRouteId);
  const stop = from?.stops.find((s) => s.accountId === accountId);
  if (!stop) return routes;
  return routes.map((r) => {
    if (r.id === fromRouteId) {
      return recomputeKeepingOrder({ ...r, stops: r.stops.filter((s) => s.accountId !== accountId) }, caps);
    }
    if (r.id === toRouteId) {
      const stops = r.stops.slice();
      const idx = Math.min(Math.max(toIndex, 0), stops.length);
      stops.splice(idx, 0, stop);
      return recomputeKeepingOrder({ ...r, stops }, caps);
    }
    return r;
  }).filter((r) => r.stops.length > 0 || r.id === toRouteId);
}

/** Combines routes (same day) into one optimized route. */
export function combineRoutesById(routes, ids, caps) {
  const idSet = new Set(ids);
  const toMerge = routes.filter((r) => idSet.has(r.id));
  if (toMerge.length < 2) return { routes, mergedId: null };
  const base = toMerge[0];
  const stops = toMerge.flatMap((r) => r.stops);
  const merged = recomputeRoute(
    { ...base, id: `plan-combined-${Date.now()}`, routeName: `${base.depot?.name || 'Route'} Combined ${base.serviceDate}`, stops },
    caps,
  );
  const next = [merged, ...routes.filter((r) => !idSet.has(r.id))];
  return { routes: next, mergedId: merged.id };
}

/** Splits a route into two halves (optimized). */
export function splitRouteById(routes, routeId, caps) {
  const target = routes.find((r) => r.id === routeId);
  if (!target || target.stops.length < 2) return { routes, firstId: null };
  const [a, b] = splitOptimized(target, caps);
  const next = routes.flatMap((r) => (r.id === routeId ? [a, b] : [r]));
  return { routes: next, firstId: a.id };
}

/** Removes a stop from a route (moves it to the unassigned tray in the caller). */
export function removeStop(routes, routeId, accountId, caps) {
  const route = routes.find((r) => r.id === routeId);
  const stop = route?.stops.find((s) => s.accountId === accountId);
  const next = routes.map((r) => (r.id === routeId
    ? recomputeKeepingOrder({ ...r, stops: r.stops.filter((s) => s.accountId !== accountId) }, caps)
    : r));
  return { routes: next, stop: stop || null };
}
