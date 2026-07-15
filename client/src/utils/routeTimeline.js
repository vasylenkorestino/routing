/**
 * Pure helpers for the Route Timeline: leg-duration estimates, cumulative
 * stop offsets, clock-time anchoring from completed stops, and label formatting.
 * Directions API fetching lives in hooks/useRouteTimeline.js — everything here
 * is synchronous and unit-testable.
 */

import { isValidCoord } from './routePolyline';
import { isCompletedStatus } from './stopStatus';

/** Per-stop service duration (same assumption as routeRecompute.js). */
export const SERVICE_TIME_MIN = 15;

/** Average speed used when Directions data is unavailable. */
export const FALLBACK_AVG_SPEED_MPH = 35;

const EARTH_RADIUS_MILES = 3958.8;

const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in miles between two {lat,lng} points. */
export function haversineMiles(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** Rough drive time (seconds) for one leg when Directions data is missing. */
export function estimateLegSeconds(a, b) {
  return Math.round((haversineMiles(a, b) / FALLBACK_AVG_SPEED_MPH) * 3600);
}

/** {lat,lng} of a stop, or null when its coordinates are unusable. */
export function stopCoord(stop) {
  const lat = Number(stop?.Latitude__c);
  const lng = Number(stop?.Longitude__c);
  return isValidCoord(lat, lng) ? { lat, lng } : null;
}

/** Route stops with valid coordinates, sorted by Priority__c. */
export function orderedRouteStops(route) {
  const stops = route?.Routes__r?.records ?? route?.Routes__r ?? route?.points ?? [];
  return stops
    .filter((s) => stopCoord(s))
    .sort((a, b) => (a.Priority__c ?? 0) - (b.Priority__c ?? 0));
}

/** Stable signature of an ordered coordinate sequence (cache / memo key). */
export function coordsSignature(coords) {
  return coords.map((c) => `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`).join('|');
}

/** Haversine-based leg durations (seconds) for consecutive coordinates. */
export function estimateAllLegSeconds(coords) {
  const legs = [];
  for (let i = 0; i < coords.length - 1; i++) legs.push(estimateLegSeconds(coords[i], coords[i + 1]));
  return legs;
}

/**
 * Cumulative arrival offset (seconds from route start) for each point of the
 * journey. `legsSeconds[i]` is the drive time from point i to point i+1;
 * departing any point that is a stop (not a depot) adds SERVICE_TIME_MIN.
 * Returns one offset per point (first point = 0).
 */
export function cumulativeOffsets(legsSeconds, { hasStartDepot, pointCount }) {
  const serviceSec = SERVICE_TIME_MIN * 60;
  const offsets = [0];
  for (let i = 1; i < pointCount; i++) {
    const prevIsDepot = hasStartDepot && i === 1;
    offsets.push(offsets[i - 1] + (prevIsDepot ? 0 : serviceSec) + (legsSeconds[i - 1] ?? 0));
  }
  return offsets;
}

/**
 * Anchors the timeline to real clock time when possible: the completed stop
 * (Status__c Complete/Completed/Driver Complete) with the latest
 * LastModifiedDate is assumed to have finished at that timestamp.
 * Returns route start time in ms, or null → caller falls back to offsets.
 */
export function anchorStartMs(stops, stopOffsetsSec) {
  let best = null;
  stops.forEach((s, i) => {
    if (!isCompletedStatus(s?.Status__c) || !s?.LastModifiedDate) return;
    const ms = Date.parse(s.LastModifiedDate);
    if (Number.isNaN(ms)) return;
    if (!best || ms > best.ms) best = { ms, index: i };
  });
  if (!best) return null;
  // LastModifiedDate marks completion → subtract arrival offset + service time.
  const completionOffsetSec = (stopOffsetsSec[best.index] ?? 0) + SERVICE_TIME_MIN * 60;
  return best.ms - completionOffsetSec * 1000;
}

/** "Start" / "+45m" / "+1h 20m" for a relative offset in seconds. */
export function formatOffset(sec) {
  if (!sec || sec < 30) return 'Start';
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `+${m}m`;
  return m === 0 ? `+${h}h` : `+${h}h ${m}m`;
}

/** Timezone the routes operate in — DB timestamps are GMT, display is local Atlanta time. */
export const ROUTE_TIME_ZONE = 'America/New_York';

/** "10:45 AM" (in ROUTE_TIME_ZONE) for an epoch-ms timestamp. */
export function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: ROUTE_TIME_ZONE,
  });
}

/**
 * Latest completed stop by LastModifiedDate, or null when none are completed.
 * NOTE: Route__c has no dedicated completion timestamp (Service_Completed__c is a
 * checkbox), so LastModifiedDate is used as a completion-time proxy — it can shift
 * if the record is edited after being serviced.
 */
export function getLastCompletedStop(stops = []) {
  let best = null;
  stops.forEach((s) => {
    if (!isCompletedStatus(s?.Status__c) || !s?.LastModifiedDate) return;
    const ms = Date.parse(s.LastModifiedDate);
    if (Number.isNaN(ms)) return;
    if (!best || ms > best.ms) best = { stop: s, ms };
  });
  return best ? best.stop : null;
}

/** First not-yet-completed stop by Priority__c (the driver's next stop), or null. */
export function getNextPendingStop(stops = []) {
  return [...stops]
    .sort((a, b) => (a?.Priority__c ?? 0) - (b?.Priority__c ?? 0))
    .find((s) => !isCompletedStatus(s?.Status__c)) ?? null;
}

/** Clock label for a stop: "10:45 AM" for actual times, "est. 11:24 AM" for projections. */
export function formatStopTimeLabel({ ms, isActual = false, timeZone = ROUTE_TIME_ZONE }) {
  if (ms == null || Number.isNaN(ms)) return null;
  const clock = new Date(ms).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
  return isActual ? clock : `est. ${clock}`;
}

/** "12 min" / "1h 5m" for a leg duration in seconds. */
export function formatLegDuration(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
