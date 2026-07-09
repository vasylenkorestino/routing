import { decodeRoutePolyline, isValidCoord } from './routePolyline';

const EARTH_RADIUS_MI = 3958.8;
const MAX_PATH_POINTS = 500;

/** Great-circle distance in miles between two { lat, lng } points. */
export function haversineMiles(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(s));
}

/**
 * Distance in miles from point p to segment [a, b] using a local equirectangular
 * projection — accurate enough for the few-mile scale of route detours.
 */
function distToSegmentMiles(p, a, b) {
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lng * cosLat, ay = a.lat;
  const bx = b.lng * cosLat, by = b.lat;
  const px = p.lng * cosLat, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const proj = { lat: ay + t * dy, lng: (ax + t * dx) / cosLat };
  return haversineMiles(p, proj);
}

/**
 * Builds the reference path for a route: decoded Polyline__c when available,
 * otherwise its stops sorted by Priority__c. Long paths are downsampled.
 */
export function buildRoutePath(route) {
  if (!route) return [];
  const stops = (route.Routes__r?.records ?? route.Routes__r ?? [])
    .filter((s) => isValidCoord(Number(s.Latitude__c), Number(s.Longitude__c)))
    .sort((a, b) => (a.Priority__c ?? 9999) - (b.Priority__c ?? 9999))
    .map((s) => ({ lat: Number(s.Latitude__c), lng: Number(s.Longitude__c) }));

  let path = decodeRoutePolyline(route.Polyline__c, { anchors: stops });
  if (path.length < 2) path = stops;
  if (path.length > MAX_PATH_POINTS) {
    const stride = Math.ceil(path.length / MAX_PATH_POINTS);
    path = path.filter((_, i) => i % stride === 0 || i === path.length - 1);
  }
  return path;
}

/** Minimum distance in miles from a point to the route path; null when unavailable. */
export function offRouteMiles(point, path) {
  if (!point || !path?.length) return null;
  if (path.length === 1) return haversineMiles(point, path[0]);
  let min = Infinity;
  for (let i = 0; i < path.length - 1; i += 1) {
    const d = distToSegmentMiles(point, path[i], path[i + 1]);
    if (d < min) min = d;
  }
  return Number.isFinite(min) ? min : null;
}

/** Formats an off-route distance for display, e.g. "0.4 mi" / "12 mi". */
export function formatMiles(mi) {
  if (mi == null) return '';
  return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi)} mi`;
}
