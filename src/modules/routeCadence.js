/**
 * Route cadence / "next visit opportunity" engine (pure — no Salesforce I/O).
 *
 * Answers "when will this truck realistically be back at this account?" so the
 * planner can tell "due in 3 days" apart from "due in 3 months". An account that
 * comes due before the route returns has to be serviced on this run — there is
 * no second trip.
 *
 * Cadence is measured from completed runs of the same route (see
 * routeCompare.fetchCompletedRoutesByName), newest first:
 *
 *   account_route_history : median gap between runs that included the account
 *                           (>= 3 runs — an account served on alternate runs
 *                           gets double the route horizon)
 *   route_history         : median gap between all completed runs (>= 2 runs)
 *   shape_interval        : Shape__c.Interval__c picklist on the territory
 *   default               : 14 days
 *
 * Google_Route__c.Interval__c is intentionally ignored — it is empty org-wide.
 */

const { addDaysISO, daysBetween } = require('./serviceDue');

/** Fallback horizon when neither run history nor a shape interval is available. */
const DEFAULT_CADENCE_DAYS = 14;

/** Cadence bounds — absorbs one-off gaps (holiday weeks, month-long pauses). */
const MIN_CADENCE_DAYS = 7;
const MAX_CADENCE_DAYS = 56;

/** Runs needed before a median gap is trustworthy. */
const MIN_ROUTE_RUNS = 2;
const MIN_ACCOUNT_RUNS = 3;

/** Trims a Salesforce Id to the 15-char case-sensitive key for cross-Id joins. */
function sfKey(id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  return s.length >= 15 ? s.slice(0, 15) : s || null;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clampCadence(days) {
  return Math.min(MAX_CADENCE_DAYS, Math.max(MIN_CADENCE_DAYS, Math.round(days)));
}

/**
 * The date a route was actually driven: Last_Route_Serviced_Date__c, falling
 * back to the planned Service_Date__c. The serviced date is blank until the run
 * completes, which is exactly what we want — an unrun route is not history.
 */
function runDate(route) {
  const served = route?.Last_Route_Serviced_Date__c || route?.runDate;
  const planned = route?.Service_Date__c || route?.serviceDate;
  const value = served || planned;
  return value ? String(value).slice(0, 10) : null;
}

/**
 * Parses a Shape__c.Interval__c picklist label into days.
 * "Weekly" => 7, "N Weeks" => N*7. Unknown labels return null.
 */
function parseIntervalDays(label) {
  if (!label) return null;
  const t = String(label).trim();
  if (/^weekly$/i.test(t)) return 7;
  const weeks = /^(\d+)\s*weeks?$/i.exec(t);
  if (weeks) return Number(weeks[1]) * 7;
  return null;
}

/**
 * Normalizes historical Google_Route__c records into cadence input rows
 * [{ runDate, accountIds }], newest first, undated runs dropped.
 * @param {object[]} routes - route records with a stops accessor result
 * @param {(route: object) => string[]} getAccountIds - extracts stop account Ids
 */
function toRunHistory(routes = [], getAccountIds = () => []) {
  return routes
    .map((r) => ({ runDate: runDate(r), accountIds: getAccountIds(r).filter(Boolean) }))
    .filter((r) => r.runDate)
    .sort((a, b) => (a.runDate < b.runDate ? 1 : -1));
}

/** Median gap in days across a newest-first list of run dates. Needs >= 2. */
function medianGapDays(dates, minRuns) {
  const unique = [...new Set(dates.filter(Boolean))].sort().reverse();
  if (unique.length < minRuns) return null;
  const gaps = [];
  for (let i = 0; i < unique.length - 1; i += 1) {
    const gap = daysBetween(unique[i + 1], unique[i]);
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return null;
  return { days: clampCadence(median(gaps)), sampleSize: gaps.length };
}

/**
 * Median gap between completed runs of the route.
 * @returns {{ days: number, sampleSize: number }|null}
 */
function resolveRouteCadenceDays(runs = []) {
  return medianGapDays(runs.map((r) => r.runDate), MIN_ROUTE_RUNS);
}

/**
 * Median gap between the runs that actually included this account. Captures
 * accounts served on alternate passes rather than every run.
 * @returns {{ days: number, sampleSize: number }|null}
 */
function resolveAccountCadenceDays(accountId, runs = []) {
  const key = sfKey(accountId);
  if (!key) return null;
  const dates = runs
    .filter((r) => r.accountIds.some((id) => sfKey(id) === key))
    .map((r) => r.runDate);
  return medianGapDays(dates, MIN_ACCOUNT_RUNS);
}

/**
 * Resolves the next realistic service opportunity for an account on this route.
 *
 * @param {object} opts
 * @param {string} opts.serviceDate - route date YYYY-MM-DD
 * @param {string} [opts.accountId] - account to measure; omit for route-level
 * @param {{ runDate: string, accountIds: string[] }[]} [opts.runs] - completed runs
 * @param {string} [opts.shapeInterval] - Shape__c.Interval__c picklist label
 * @returns {{ nextVisitDate: string|null, cadenceDays: number,
 *             cadenceSource: string, sampleSize: number|null }}
 */
function resolveNextVisit({ serviceDate, accountId = null, runs = [], shapeInterval = null } = {}) {
  const byAccount = accountId ? resolveAccountCadenceDays(accountId, runs) : null;
  const byRoute = byAccount ? null : resolveRouteCadenceDays(runs);
  const fromShape = (byAccount || byRoute) ? null : parseIntervalDays(shapeInterval);

  let cadenceDays = DEFAULT_CADENCE_DAYS;
  let cadenceSource = 'default';
  let sampleSize = null;

  if (byAccount) {
    cadenceDays = byAccount.days;
    cadenceSource = 'account_route_history';
    sampleSize = byAccount.sampleSize;
  } else if (byRoute) {
    cadenceDays = byRoute.days;
    cadenceSource = 'route_history';
    sampleSize = byRoute.sampleSize;
  } else if (fromShape) {
    cadenceDays = clampCadence(fromShape);
    cadenceSource = 'shape_interval';
  }

  return {
    nextVisitDate: serviceDate ? addDaysISO(serviceDate, cadenceDays) : null,
    cadenceDays,
    cadenceSource,
    sampleSize,
  };
}

module.exports = {
  DEFAULT_CADENCE_DAYS,
  MIN_CADENCE_DAYS,
  MAX_CADENCE_DAYS,
  MIN_ROUTE_RUNS,
  MIN_ACCOUNT_RUNS,
  runDate,
  parseIntervalDays,
  toRunHistory,
  resolveRouteCadenceDays,
  resolveAccountCadenceDays,
  resolveNextVisit,
};
