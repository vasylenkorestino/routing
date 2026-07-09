/**
 * Shared route geometry helpers used by the map layers (RouteLayer,
 * RouteTimelineMapLayer): stop/service-location coordinates, decoded
 * polyline paths, and leg-midpoint lookup for on-polyline labels.
 */

import { decodeRoutePolyline, isValidCoord } from './routePolyline';

/** True when a stop has usable map coordinates. */
export function hasValidCoords(s) {
  return isValidCoord(Number(s.Latitude__c), Number(s.Longitude__c));
}

/** {lat,lng} of a service location, or null when unset/zeroed. */
export function slCoord(sl) {
  if (!sl) return null;
  const lat = Number(sl.Latitude__c);
  const lng = Number(sl.Longitude__c);
  if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** Ordered stops (valid coords, by Priority__c) + decoded Polyline__c path. */
export function getStopsAndPolyline(route, startPt, endPt) {
  const allStops = route.Routes__r?.records ?? route.Routes__r ?? [];
  const stops = allStops
    .filter(hasValidCoords)
    .sort((a, b) => (a.Priority__c ?? 0) - (b.Priority__c ?? 0));

  const anchors = [
    ...stops.map((s) => ({ lat: Number(s.Latitude__c), lng: Number(s.Longitude__c) })),
    ...(startPt ? [startPt] : []),
    ...(endPt ? [endPt] : []),
  ];

  const polyPath = route.Polyline__c
    ? decodeRoutePolyline(route.Polyline__c, { anchors })
    : [];

  if (route.Polyline__c && polyPath.length < 2) {
    console.warn(`[routeGeometry] polyline unusable for ${route.Name}; using driving directions`);
  }

  return { stops, polyPath };
}

/** Squared degree-space distance — good enough for nearest-vertex lookup. */
function sqDist(a, b) {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

/** Index of the path vertex closest to `point` (searching from `fromIdx`). */
export function nearestVertexIndex(path, point, fromIdx = 0) {
  let bestIdx = fromIdx;
  let best = Infinity;
  for (let i = fromIdx; i < path.length; i++) {
    const d = sqDist(path[i], point);
    if (d < best) { best = d; bestIdx = i; }
  }
  return bestIdx;
}

/**
 * Midpoint (on the polyline) of the leg between two anchor points, so leg
 * labels sit on the drawn route line. Falls back to the geographic midpoint
 * when the path is missing or the anchors don't map onto it.
 */
export function legMidpointOnPath(path, from, to) {
  if (path?.length >= 2) {
    const i = nearestVertexIndex(path, from);
    const j = nearestVertexIndex(path, to, i);
    if (j > i) return path[Math.floor((i + j) / 2)];
  }
  return { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
}
