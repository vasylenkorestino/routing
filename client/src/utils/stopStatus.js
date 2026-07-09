/**
 * Stop status classification for map markers.
 *
 * Precedence (first match wins):
 *   1. completed      — stop already serviced on this route
 *   2. needsAttention — still New/Skipped although a later stop was completed (passed over)
 *   3. overdue        — next expected service (last service + pickup frequency) is in the past
 *   4. scheduled      — everything else (not visited yet)
 */

/** Ordered for legend display; precedence is handled in getStopStatus. */
export const STOP_STATUSES = {
  scheduled: { key: 'scheduled', label: 'Scheduled', color: '#2563eb' },
  completed: { key: 'completed', label: 'Completed', color: '#22c55e' },
  needsAttention: { key: 'needsAttention', label: 'Needs Attention', color: '#f59e0b' },
  overdue: { key: 'overdue', label: 'Overdue', color: '#ef4444' },
};

/** Same completed values as the data table badge (RouteDataTable / StopRow). */
const COMPLETED_VALUES = new Set(['Complete', 'Completed', 'Driver Complete']);

/** Estimated_Pickup_Frequency__c picklist → days. */
const FREQUENCY_LABEL_DAYS = {
  'Bi-Annually': 182,
  'Anually': 365,
};

/** True for any Status__c value that means the stop was serviced. */
export function isCompletedStatus(raw) {
  return COMPLETED_VALUES.has(raw || '');
}

/**
 * Pickup frequency in days for a stop's account, or null when unknown/on-call.
 * Prefers the numeric Pickup_Frequency_in_Days__c, falls back to parsing the
 * Estimated_Pickup_Frequency__c picklist ("4 Weeks", "Bi-Annually", ...).
 */
export function frequencyDays(stop) {
  const acct = stop?.Account__r;
  if (!acct) return null;

  const days = Number(acct.Pickup_Frequency_in_Days__c);
  if (Number.isFinite(days) && days > 0) return days;

  const label = acct.Estimated_Pickup_Frequency__c;
  if (!label || label === 'On-Call') return null;
  if (FREQUENCY_LABEL_DAYS[label]) return FREQUENCY_LABEL_DAYS[label];

  const weeks = /^(\d+)\s*Weeks?$/i.exec(label.trim());
  return weeks ? Number(weeks[1]) * 7 : null;
}

/** Parses a Salesforce date (YYYY-MM-DD) as a local Date, or null. */
function parseSfDate(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

/** True when last service + pickup frequency is before today. */
export function isStopOverdue(stop, today = new Date()) {
  const freq = frequencyDays(stop);
  if (!freq) return false;
  const last = parseSfDate(stop?.Account__r?.Last_Service_Date__c) ?? parseSfDate(stop?.Last_Route_Serviced_Date__c);
  if (!last) return false;
  const next = new Date(last);
  next.setDate(next.getDate() + freq);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return next < startOfToday;
}

/**
 * Classifies one stop given all stops of its route (sorted by Priority__c).
 * Returns one of the STOP_STATUSES entries.
 */
export function getStopStatus(stop, allStops = []) {
  if (isCompletedStatus(stop?.Status__c)) return STOP_STATUSES.completed;

  const pending = !stop?.Status__c || stop.Status__c === 'New' || stop.Status__c === 'Skipped';
  if (pending) {
    const priority = stop?.Priority__c ?? Infinity;
    const passedOver = allStops.some(
      (s) => s !== stop && (s.Priority__c ?? Infinity) > priority && isCompletedStatus(s.Status__c),
    );
    if (passedOver) return STOP_STATUSES.needsAttention;
    if (isStopOverdue(stop)) return STOP_STATUSES.overdue;
  }

  return STOP_STATUSES.scheduled;
}
