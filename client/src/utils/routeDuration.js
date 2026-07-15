/**
 * Shared route-duration helpers. Distinguishes two different "time" numbers that
 * previously looked inconsistent in the UI:
 *   - Drive Time: Google Route Optimization result (Minutes__c / Total_Time__c) — driving only.
 *   - Total Time: Drive Time + on-site service time (SERVICE_TIME_MIN per stop).
 * Both are derived from the same drive-time source so Total − Service === Drive.
 */

import { SERVICE_TIME_MIN } from './routeTimeline';

/** Reads child stops whether Routes__r is an array, a { records: [] } wrapper, or points. */
export function getRouteStops(route) {
  const r = route?.Routes__r;
  if (Array.isArray(r)) return r;
  if (r?.records) return r.records;
  return route?.points ?? [];
}

/**
 * Parses a Salesforce DHMS string (Apex `secondsToDHMS` output) into minutes.
 * Handles "2 hours 39 mins", "1 day 2 hours 5 mins", "1 hour 1 min", "1 min".
 * Returns null when nothing parseable is found (caller decides the fallback).
 */
export function parseDhmsToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const days = /(\d+)\s*day/i.exec(str);
  const hours = /(\d+)\s*hour/i.exec(str);
  const mins = /(\d+)\s*min/i.exec(str);
  if (!days && !hours && !mins) return null;
  return (days ? Number(days[1]) * 1440 : 0)
    + (hours ? Number(hours[1]) * 60 : 0)
    + (mins ? Number(mins[1]) : 0);
}

/** Formats minutes as "Xh Ym" (or "Ym"); "—" when null/undefined. */
export function fmtDuration(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Computes drive/service/total durations for a Google_Route__c.
 * Drive time prefers the numeric Minutes__c field, falling back to parsing the
 * human-readable Total_Time__c string for legacy records missing Minutes__c.
 * Total = drive + (stops × SERVICE_TIME_MIN) so the two headline numbers stay
 * internally consistent (no dependency on the Directions-based timeline total).
 */
export function computeRouteDurations(route) {
  const stopCount = getRouteStops(route).length;
  const driveTimeLabel = route?.Total_Time__c || null;

  const minutesField = Number(route?.Minutes__c);
  const driveTimeMin = Number.isFinite(minutesField) && minutesField > 0
    ? Math.round(minutesField)
    : parseDhmsToMinutes(driveTimeLabel);

  const serviceTimeMin = stopCount * SERVICE_TIME_MIN;
  const totalDurationMin = driveTimeMin == null ? null : driveTimeMin + serviceTimeMin;

  return { driveTimeLabel, driveTimeMin, serviceTimeMin, totalDurationMin, stopCount };
}
