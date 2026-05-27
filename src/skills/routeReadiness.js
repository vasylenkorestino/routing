/**
 * Route Readiness — single source of truth for "can we still touch this route?"
 *
 * A route is "open" only when nothing on it has been worked yet. Once any of
 * the following becomes true, we must NOT propose new ticket recommendations
 * for the route, and we must NOT honour an Accept on an existing recommendation:
 *
 *   Header (Google_Route__c):
 *     - Driver_Completed__c === true
 *     - isLocked__c === true
 *     - CompletionStatus__c in {'In Progress', 'Completed', 'Failed'}
 *
 *   Any stop (Route__c):
 *     - Gallons_Collected__c is set
 *     - Notes2__c (Service Issues) is set
 *     - Service_Completed__c === true
 *     - Inactive__c === true
 *     - Status__c in {'Driver Complete','Complete','Completed','Passed','Skipped','Active'}
 *
 * Used by:
 *   - services/ticketTriage.js  (filter candidate routes before Claude sees them)
 *   - routes/notifications.js   (gate Accept/Decline of triage RouteLog__c records)
 *   - services/sfSync.js        (re-triage decline path — exclude unsafe routes)
 */

const CLOSED_HEADER_REASONS = Object.freeze({
  DRIVER_COMPLETED: 'Driver_Completed__c=true',
  LOCKED: 'isLocked__c=true',
  COMPLETION_IN_PROGRESS: "CompletionStatus__c='In Progress'",
  COMPLETION_COMPLETED: "CompletionStatus__c='Completed'",
  COMPLETION_FAILED: "CompletionStatus__c='Failed'",
});

const STARTED_STOP_REASONS = Object.freeze({
  GALLONS_COLLECTED: 'a stop has Gallons_Collected__c set',
  HAS_SERVICE_ISSUE: 'a stop has Notes2__c (Service Issues) set',
  SERVICE_COMPLETED: 'a stop has Service_Completed__c=true',
  INACTIVE: 'a stop is marked Inactive__c=true',
  TERMINAL_STATUS: 'a stop already has a terminal Status__c',
});

const TERMINAL_STOP_STATUSES = new Set([
  'Driver Complete',
  'Complete',
  'Completed',
  'Passed',
  'Skipped',
  'Active',
]);

const COMPLETION_STATUSES_BLOCKED = new Set(['In Progress', 'Completed', 'Failed']);

/** Error thrown by assertRouteOpen() when the rule rejects a route. */
class RouteClosedError extends Error {
  constructor(message, { googleRouteId, reason } = {}) {
    super(message);
    this.name = 'RouteClosedError';
    this.code = 'ROUTE_CLOSED';
    this.googleRouteId = googleRouteId || null;
    this.reason = reason || null;
  }
}

/**
 * Checks the Google_Route__c header. Returns null if open, or a reason string
 * if the header alone disqualifies the route.
 */
function checkHeader(route) {
  if (!route) return null;
  if (route.Driver_Completed__c === true) return CLOSED_HEADER_REASONS.DRIVER_COMPLETED;
  if (route.isLocked__c === true) return CLOSED_HEADER_REASONS.LOCKED;
  const cs = route.CompletionStatus__c;
  if (cs && COMPLETION_STATUSES_BLOCKED.has(cs)) {
    if (cs === 'In Progress') return CLOSED_HEADER_REASONS.COMPLETION_IN_PROGRESS;
    if (cs === 'Completed') return CLOSED_HEADER_REASONS.COMPLETION_COMPLETED;
    if (cs === 'Failed') return CLOSED_HEADER_REASONS.COMPLETION_FAILED;
  }
  return null;
}

/**
 * Checks each Route__c stop. Returns null if all stops are still untouched,
 * or a reason string if any stop indicates the route has already started.
 */
function checkStops(stops) {
  if (!Array.isArray(stops) || stops.length === 0) return null;
  for (const s of stops) {
    if (!s) continue;
    if (s.Gallons_Collected__c != null && s.Gallons_Collected__c !== '') {
      return STARTED_STOP_REASONS.GALLONS_COLLECTED;
    }
    if (s.Notes2__c) return STARTED_STOP_REASONS.HAS_SERVICE_ISSUE;
    if (s.Service_Completed__c === true) return STARTED_STOP_REASONS.SERVICE_COMPLETED;
    if (s.Inactive__c === true) return STARTED_STOP_REASONS.INACTIVE;
    if (s.Status__c && TERMINAL_STOP_STATUSES.has(s.Status__c)) {
      return STARTED_STOP_REASONS.TERMINAL_STATUS;
    }
  }
  return null;
}

/**
 * Pure predicate. Returns { open, reason } given an in-memory route header
 * and an optional list of its stops.
 */
function evaluateRoute(route, stops) {
  const headerReason = checkHeader(route);
  if (headerReason) return { open: false, reason: headerReason };
  const stopReason = checkStops(stops);
  if (stopReason) return { open: false, reason: stopReason };
  return { open: true, reason: null };
}

/** Convenience boolean for callers that just want a yes/no. */
function isRouteOpen(route, stops) {
  return evaluateRoute(route, stops).open;
}

/**
 * Loads the Google_Route__c header + child stops by id and throws
 * RouteClosedError if the readiness rule rejects it. Returns the loaded
 * { route, stops } on success so callers can reuse the data.
 */
async function assertRouteOpen(conn, googleRouteId) {
  if (!googleRouteId) {
    throw new RouteClosedError('Missing Google_Route__c id', { reason: 'NO_ID' });
  }
  const safeId = String(googleRouteId).replace(/'/g, "\\'");
  const soql = `
    SELECT Id, Name, Driver_Completed__c, isLocked__c, CompletionStatus__c,
           (SELECT Id, Status__c, Gallons_Collected__c, Notes2__c,
                   Service_Completed__c, Inactive__c
            FROM Routes__r)
    FROM Google_Route__c
    WHERE Id = '${safeId}'
    LIMIT 1
  `;
  const res = await conn.query(soql);
  const route = res.records && res.records[0];
  if (!route) {
    throw new RouteClosedError('Route not found', { googleRouteId, reason: 'NOT_FOUND' });
  }
  const stops = (route.Routes__r && route.Routes__r.records) || [];
  const { open, reason } = evaluateRoute(route, stops);
  if (!open) {
    throw new RouteClosedError(`Route is no longer open (${reason})`, { googleRouteId, reason });
  }
  return { route, stops };
}

module.exports = {
  isRouteOpen,
  evaluateRoute,
  assertRouteOpen,
  RouteClosedError,
  CLOSED_HEADER_REASONS,
  STARTED_STOP_REASONS,
  TERMINAL_STOP_STATUSES,
};
