/**
 * Service-due evaluation engine (shared, pure — no Salesforce reads or writes).
 *
 * Single source of truth for "does this account need UCO service by date X?".
 * Used by the Planning Workspace planner, the account_discovery skill and the
 * service_due_analysis skill so every planning path applies the same rules:
 *
 *   last service date : newest UCO Collection Service__c.Service_Date__c only
 *                       (UCOLastServiceDate__c is ignored for due math)
 *   frequency (days)  : Estimated_Pickup_Frequency__c picklist ("3 Weeks" = 21),
 *                       falling back to Pickup_Frequency_in_Days__c, falling back
 *                       to the median interval of the account's service history
 *   fill-rate model   : avg Gross Gallons (Qty_Gallons__c) per service divided by
 *                       the median interval => gallons/day; with tank capacity
 *                       (Tank_Size__c) this caps the effective frequency at
 *                       "days until the tank is full"
 *
 * due <=> lastServiceDate + effectiveFrequencyDays <= target date.
 */

/** Estimated_Pickup_Frequency__c picklist buckets, in days (for snapping estimates). */
const FREQUENCY_BUCKETS = [7, 14, 21, 28, 35, 42, 56, 70, 84, 112, 182, 365];

/** Bucket days -> picklist label (used to report estimated frequencies). */
const BUCKET_LABELS = {
  7: '1 Week', 14: '2 Weeks', 21: '3 Weeks', 28: '4 Weeks', 35: '5 Weeks',
  42: '6 Weeks', 56: '8 Weeks', 70: '10 Weeks', 84: '12 Weeks', 112: '16 Weeks',
  182: 'Bi-Annually', 365: 'Anually',
};

/** Fields the engine reads from Account (add to any discovery SOQL). */
const ACCOUNT_DUE_FIELDS =
  'UCOLastServiceDate__c, Estimated_Pickup_Frequency__c, Pickup_Frequency_in_Days__c, ' +
  'Tank_Size__c, ContainerCapacity__c, Container_Size_number__c, Estimated_GPM__c';

/* ── date helpers ─────────────────────────────────────────── */

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

/** Adds N days to a YYYY-MM-DD (or ISO) date, returns YYYY-MM-DD. */
function addDaysISO(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

/** Whole days from dateA to dateB (positive when B is after A). */
function daysBetween(dateA, dateB) {
  const a = new Date(`${String(dateA).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(dateB).slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/* ── field parsing ────────────────────────────────────────── */

/**
 * Parses an Estimated_Pickup_Frequency__c picklist label into days.
 * "N Week(s)" => N*7, "Bi-Annually" => 182, "Anually"/"Annually" => 365.
 * Returns null for "On-Call", empty or unrecognized labels.
 */
function parsePicklistFrequencyDays(label) {
  if (!label) return null;
  const t = String(label).trim();
  if (/^bi-?annual/i.test(t)) return 182;
  if (/^an+ual/i.test(t)) return 365;
  const weeks = /^(\d+)\s*weeks?$/i.exec(t);
  if (weeks) return Number(weeks[1]) * 7;
  return null;
}

/** True when the account's declared frequency is the "On-Call" picklist value. */
function isOnCall(account) {
  return /^on-?call$/i.test(String(account?.Estimated_Pickup_Frequency__c || '').trim());
}

/**
 * Declared pickup frequency in days: Estimated_Pickup_Frequency__c picklist first,
 * then the numeric Pickup_Frequency_in_Days__c. Returns { days, source } or null.
 */
function parseFrequencyDays(account) {
  const fromPicklist = parsePicklistFrequencyDays(account?.Estimated_Pickup_Frequency__c);
  if (fromPicklist) return { days: fromPicklist, source: 'picklist' };
  const days = Number(account?.Pickup_Frequency_in_Days__c);
  if (Number.isFinite(days) && days > 0) return { days, source: 'pickup_frequency_in_days' };
  return null;
}

/**
 * True when the driver could not reach the tank. Code__c is the formula
 * IF(isInaccessible__c, 'UCO-INC', ServiceCode__c), so an inaccessible visit of
 * any record type reports UCO-INC.
 */
function isInaccessibleService(service) {
  return service?.isInaccessible__c === true || service?.Code__c === 'UCO-INC';
}

/** True when a Service__c row is a UCO Collection (excludes CDL / Deliver Container). */
function isUcoCollectionService(service) {
  const code = service?.Code__c || '';
  if (code === 'UCO') return true;
  if (code === 'CDL') return false;
  const name = service?.RecordType?.Name || service?.RecordTypeName__c || '';
  const dev = service?.RecordType?.DeveloperName || service?.RecordTypeDeveloperName__c || '';
  // UCO-INC masks the real code, so record type is the only classifier left.
  if (dev === 'Tank_Delivered' || name === 'Deliver Container') return false;
  if (dev === 'WVO_Collection' || name === 'UCO Collection') return true;
  // Unclassifiable inaccessible rows count as UCO visits; they are excluded from
  // due and fill-rate math anyway, so keeping them cannot inflate a due date.
  if (isInaccessibleService(service)) return true;
  // Legacy SOQL without Code/RecordType defaults to UCO-only history.
  if (!code && !name && !dev) return true;
  return false;
}

/**
 * Normalizes attached service history (jsforce { records } wrapper or a plain
 * array) into UCO Collection rows [{ date, gallons, inaccessible }], newest first.
 * Deliver Container (CDL) rows are excluded from due/fill-rate math.
 * History is attached by serviceHistoryLoader.attachServiceHistory.
 */
function extractServiceHistory(account) {
  const raw = account?.Services__r?.records || account?.Services__r || [];
  return raw
    .filter((s) => s && s.Service_Date__c && isUcoCollectionService(s))
    .map((s) => ({
      date: String(s.Service_Date__c).slice(0, 10),
      gallons: Number.isFinite(Number(s.Qty_Gallons__c)) && s.Qty_Gallons__c != null
        ? Number(s.Qty_Gallons__c)
        : null,
      inaccessible: isInaccessibleService(s),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * Visits where the driver actually reached the tank, newest first. An
 * inaccessible visit removed no oil, so it neither resets the accumulation
 * clock nor contributes to cadence or fill-rate math.
 */
function tankReachingServices(services = []) {
  return services.filter((s) => !s.inaccessible);
}

/**
 * Estimates a pickup frequency from service history: median interval between
 * consecutive UCO service dates, clamped to 7-365 days and snapped to the nearest
 * Estimated_Pickup_Frequency__c bucket. Needs >= 2 dated services.
 * Returns { days, label, sampleSize } or null.
 */
function estimateFrequencyFromHistory(services) {
  const dates = [...new Set(tankReachingServices(services).map((s) => s.date))].sort().reverse();
  if (dates.length < 2) return null;
  const intervals = [];
  for (let i = 0; i < dates.length - 1; i += 1) {
    const gap = daysBetween(dates[i + 1], dates[i]);
    if (gap > 0) intervals.push(gap);
  }
  if (!intervals.length) return null;
  const med = Math.min(365, Math.max(7, median(intervals)));
  const days = FREQUENCY_BUCKETS.reduce((best, b) =>
    (Math.abs(b - med) < Math.abs(best - med) ? b : best), FREQUENCY_BUCKETS[0]);
  return { days, label: BUCKET_LABELS[days], sampleSize: intervals.length };
}

/**
 * Tank capacity in gallons: Tank_Size__c picklist ("250 Gallon" => 250; "Jugs"
 * has no capacity), falling back to ContainerCapacity__c / Container_Size_number__c.
 * Returns { gallons, source } or null.
 */
function parseTankCapacity(account) {
  const m = /^(\d+(?:\.\d+)?)\s*gallon/i.exec(String(account?.Tank_Size__c || '').trim());
  if (m && Number(m[1]) > 0) return { gallons: Number(m[1]), source: 'tank_size' };
  const cap = Number(account?.ContainerCapacity__c);
  if (Number.isFinite(cap) && cap > 0) return { gallons: cap, source: 'container_capacity' };
  const num = Number(account?.Container_Size_number__c);
  if (Number.isFinite(num) && num > 0) return { gallons: num, source: 'container_size_number' };
  return null;
}

/**
 * Fill rate in gallons/day: everything collected across the span between the
 * oldest and newest tank-reaching visit, divided by that span.
 *
 * Measuring over elapsed days rather than averaging successful pickups keeps
 * zero-gallon visits honest — a run of empty tanks lowers the rate instead of
 * shortening the interval and inflating it. Gallons from the oldest visit are
 * excluded because they accrued before the measured span.
 *
 * Needs >= 2 dated tank-reaching visits and >= 1 positive reading after the
 * oldest. Returns number or null.
 */
function estimateFillRate(services) {
  const reached = tankReachingServices(services);
  const dates = [...new Set(reached.map((s) => s.date))].sort().reverse();
  if (dates.length < 2) return null;

  const oldest = dates[dates.length - 1];
  const span = daysBetween(oldest, dates[0]);
  if (!(span > 0)) return null;

  const gallons = reached
    .filter((s) => s.date !== oldest && Number.isFinite(s.gallons) && s.gallons > 0)
    .reduce((sum, s) => sum + s.gallons, 0);
  if (!(gallons > 0)) return null;

  return round2(gallons / span);
}

/**
 * Last UCO service date: newest UCO Collection where the driver reached the tank.
 * UCOLastServiceDate__c is ignored (can be stale). Empty history → null.
 * When every recorded visit was inaccessible the tank has never been verified
 * empty, so the oldest visit is used — oil has been accruing at least that long.
 * Returns { date, source } or null.
 */
function resolveLastServiceDate(account, services = extractServiceHistory(account)) {
  const reached = tankReachingServices(services)[0];
  if (reached) return { date: reached.date, source: 'service_history' };
  const oldest = services.length > 0 ? services[services.length - 1] : null;
  if (oldest) return { date: oldest.date, source: 'oldest_inaccessible_visit' };
  return null;
}

/* ── gallons estimation (load planning) ───────────────────── */

/**
 * Expected gallons in the tank on targetDate, capped at capacity.
 * Prefers the history fill-rate model; falls back to Estimated_GPM__c accrual,
 * then the last collected amount, then 75% of capacity, then defaultGallons.
 */
function estimateGallonsAtDate(account, targetDate, opts = {}) {
  const defaultGallons = Number.isFinite(opts.defaultGallons) ? opts.defaultGallons : 40;
  const services = extractServiceHistory(account);
  const last = resolveLastServiceDate(account, services);
  const capacity = parseTankCapacity(account);
  const capGal = capacity ? capacity.gallons : null;
  const cap = (g) => (capGal ? Math.min(g, capGal) : g);

  const fillRate = estimateFillRate(services);
  if (fillRate && last) {
    const days = Math.max(0, daysBetween(last.date, targetDate));
    const est = cap(fillRate * days);
    if (est > 0) return round2(est);
  }

  const gpm = parseFloat(account?.Estimated_GPM__c);
  if (Number.isFinite(gpm) && gpm > 0 && last) {
    const months = Math.max(0, daysBetween(last.date, targetDate) / 30);
    const est = cap(gpm * months);
    if (est > 0) return round2(est);
  }

  const lastGallons = services.find((s) => Number.isFinite(s.gallons) && s.gallons > 0)?.gallons;
  if (lastGallons) return round2(lastGallons);
  if (capGal) return round2(capGal * 0.75);
  return defaultGallons;
}

/* ── main evaluation ──────────────────────────────────────── */

/**
 * Decides whether an account needs UCO service within [dateFrom, dateTo].
 *
 * @param {object} account - Account row incl. ACCOUNT_DUE_FIELDS + Services__r subquery.
 * @param {string} dateFrom - YYYY-MM-DD start of the planning window.
 * @param {string} [dateTo] - YYYY-MM-DD end of the window (defaults to dateFrom).
 * @returns {{
 *   due: boolean, reason: string, nextDueDate: string|null, daysUntilDue: number|null,
 *   lastServiceDate: string|null, lastDateSource: string|null,
 *   frequencyDays: number|null, frequencySource: string|null, frequencyLabel: string|null,
 *   effectiveFrequencyDays: number|null, capacityGallons: number|null,
 *   fillRatePerDay: number|null, daysToFull: number|null, estimatedGallonsAtDate: number|null
 * }}
 */
function evaluateAccount(account, dateFrom, dateTo) {
  const target = dateTo || dateFrom;
  const services = extractServiceHistory(account);
  const last = resolveLastServiceDate(account, services);
  const capacity = parseTankCapacity(account);
  const fillRate = estimateFillRate(services);
  const daysToFull = capacity && fillRate ? Math.round(capacity.gallons / fillRate) : null;

  const base = {
    due: false,
    reason: '',
    nextDueDate: null,
    // Days from the target date to the due date; negative once overdue.
    daysUntilDue: null,
    lastServiceDate: last ? last.date : null,
    lastDateSource: last ? last.source : null,
    frequencyDays: null,
    frequencySource: null,
    frequencyLabel: null,
    effectiveFrequencyDays: null,
    capacityGallons: capacity ? capacity.gallons : null,
    fillRatePerDay: fillRate,
    daysToFull,
    estimatedGallonsAtDate: null,
  };

  if (isOnCall(account)) {
    return { ...base, reason: 'on_call_frequency' };
  }

  let frequency = parseFrequencyDays(account);
  if (!frequency) {
    const estimated = estimateFrequencyFromHistory(services);
    if (estimated) {
      frequency = { days: estimated.days, source: 'estimated_from_history', label: estimated.label };
    }
  }
  if (frequency) {
    base.frequencyDays = frequency.days;
    base.frequencySource = frequency.source;
    base.frequencyLabel = frequency.label
      || (frequency.source === 'picklist' ? account.Estimated_Pickup_Frequency__c : null);
  }

  // Effective cadence: the tank filling up (daysToFull, floored at 7 days to
  // absorb noisy history) can only pull service earlier, never delay it.
  let effective = frequency ? frequency.days : null;
  if (daysToFull != null) {
    const flooredDaysToFull = Math.max(7, daysToFull);
    effective = effective == null ? flooredDaysToFull : Math.min(effective, flooredDaysToFull);
    if (frequency == null) base.frequencySource = 'fill_rate';
  }
  base.effectiveFrequencyDays = effective;

  if (!last) {
    return { ...base, reason: 'no_last_service_date' };
  }
  if (effective == null) {
    return { ...base, reason: 'no_frequency' };
  }

  const nextDueDate = addDaysISO(last.date, effective);
  const due = nextDueDate <= target;
  return {
    ...base,
    due,
    nextDueDate,
    daysUntilDue: daysBetween(target, nextDueDate),
    estimatedGallonsAtDate: estimateGallonsAtDate(account, target),
    reason: due ? `due_on_${nextDueDate}` : `not_due_until_${nextDueDate}`,
  };
}

module.exports = {
  FREQUENCY_BUCKETS,
  ACCOUNT_DUE_FIELDS,
  parsePicklistFrequencyDays,
  parseFrequencyDays,
  isOnCall,
  isUcoCollectionService,
  isInaccessibleService,
  extractServiceHistory,
  tankReachingServices,
  estimateFrequencyFromHistory,
  parseTankCapacity,
  estimateFillRate,
  resolveLastServiceDate,
  estimateGallonsAtDate,
  evaluateAccount,
  addDaysISO,
  daysBetween,
};
