/**
 * Enhance stop facts: Account Id join, reasonFacts, and plain-English log reasons.
 * Keeps AI Enhance reasons accurate from UCO history and manager-readable.
 */

const {
  evaluateAccount,
  extractServiceHistory,
  tankReachingServices,
  daysBetween,
} = require('./serviceDue');
const {
  evaluateMustRemainOnRoute,
  remainReasonLabel,
} = require('./routeKeepRules');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Trims a Salesforce Id to the 15-char case-insensitive key. */
function normalizeSfId(id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  if (s.length >= 15) return s.slice(0, 15);
  return s || null;
}

/** Indexes accounts by full Id and 15-char key for Route.AccountId__c joins. */
function indexAccountsById(accounts = []) {
  const map = new Map();
  for (const a of accounts) {
    if (!a?.Id) continue;
    map.set(String(a.Id), a);
    const key = normalizeSfId(a.Id);
    if (key) map.set(key, a);
  }
  return map;
}

/** Looks up an account by 15- or 18-char Id. */
function lookupAccount(acctMap, id) {
  if (!id || !acctMap) return null;
  return acctMap.get(String(id)) || acctMap.get(normalizeSfId(id)) || null;
}

/** Prefer lookup Account__c, else text AccountId__c. */
function resolveStopAccountId(stop) {
  return stop?.Account__c || stop?.AccountId__c || null;
}

/** Unwraps Services__r as jsforce { records } or a plain array. */
function rawServiceRows(account) {
  return account?.Services__r?.records || account?.Services__r || [];
}

/** True when reason dumps camelCase engine fields or empty. */
function looksCrypticReason(reason) {
  if (!reason || !String(reason).trim()) return true;
  return /lastServiceDate|nextDueDate|ucoServiceCount|lastGallons|dueReason|mustRemainOnRoute|gpdHistorySpanDays|hasUcoHistory|reasonFacts/i
    .test(String(reason));
}

/** Formats YYYY-MM-DD as "Jun 8, 2026". */
function formatShortDate(iso) {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Capitalizes Keep/Remove/Flag for the reason verb. */
function actionVerb(action) {
  const a = String(action || 'flag').toLowerCase();
  if (a === 'keep') return 'Keep';
  if (a === 'remove') return 'Remove';
  if (a === 'overflow') return 'Flag';
  if (a === 'add') return 'Add';
  return 'Flag';
}

/** Reason text when the account row never arrived, so history is unknown. */
const HISTORY_UNAVAILABLE_REASON =
  'Service history unavailable. Flag — verify in Salesforce before routing.';

/** AI phrasings that claim there is no history — never valid when unverified. */
const NO_HISTORY_CLAIM_RE = /no uco pickups|no service (date|history)/i;

/** Short why clause from engine facts (no field names). */
function deriveWhy(facts, action) {
  if (!facts) return 'needs manager review';
  if (facts.historyUnavailable) return 'verify in Salesforce before routing';
  if (facts.mustRemainOnRoute) {
    if (facts.remainReasonLabel?.toLowerCase().includes('cdl')) {
      return 'awaiting first UCO pickup';
    }
    return 'new account — remain on route';
  }
  if (facts.isFixed) return 'fixed stop';
  if (facts.isVip) return 'VIP / no-fail';
  const a = String(action || '').toLowerCase();
  if (a === 'keep' || a === 'overflow') {
    if (facts.daysOverdue > 0) return 'overdue';
    if (facts.due) return 'due for service';
    return 'keep on route';
  }
  if (a === 'remove') {
    if (facts.hasUcoHistory && facts.nextDueDate && !facts.due) return 'not due yet';
    return 'remove from route';
  }
  if (!facts.hasUcoHistory) return 'verify before committing to route';
  return 'needs manager review';
}

/**
 * Builds manager-facing reason from reasonFacts.
 * Example: "Last UCO: Jun 8, 2026 (0 gal). Next due ~Jul 6. Keep — overdue."
 */
function formatManagerReason(facts, action, whyOverride) {
  // Unknown history must never be reported as "no pickups on record".
  if (facts?.historyUnavailable) return HISTORY_UNAVAILABLE_REASON;

  const verb = actionVerb(action);
  const why = (whyOverride && String(whyOverride).trim()) || deriveWhy(facts, action);

  if (!facts?.hasUcoHistory) {
    return `No UCO pickups on record. ${verb} — ${why}.`;
  }

  const lastDate = formatShortDate(facts.lastUcoDate);
  const galPart = facts.lastUcoGallons == null || Number.isNaN(Number(facts.lastUcoGallons))
    ? 'gal unknown'
    : `${Number(facts.lastUcoGallons)} gal`;
  const lastPart = lastDate
    ? `Last UCO: ${lastDate} (${galPart}).`
    : `Last UCO on record (${galPart}).`;

  const nextDate = formatShortDate(facts.nextDueDate);
  const nextPart = nextDate ? ` Next due ~${nextDate}.` : '';

  return `${lastPart}${nextPart} ${verb} — ${why}.`.replace(/\s+/g, ' ').trim();
}

/** Builds reasonFacts + enhance stop payload fields from Route + Account. */
function buildEnhanceStopRow(stop, account, serviceDate) {
  const acct = account || {};
  const services = rawServiceRows(acct);
  const svc = evaluateAccount(acct, serviceDate);
  const remain = evaluateMustRemainOnRoute(acct, serviceDate);
  const history = extractServiceHistory(acct);
  const hasUcoHistory = history.length > 0;
  // No account row means the join failed (or the record was not returned), so
  // history was never read — that is not the same as "this account has none".
  const historyUnavailable = !acct.Id;

  // Newest gallons from the same visit the due engine measures from (including
  // 0); else Route LastGallonsCollected__c.
  const lastReached = tankReachingServices(history)[0];
  let lastGallons = stop?.LastGallonsCollected__c;
  if (lastReached && lastReached.gallons != null) {
    lastGallons = lastReached.gallons;
  }

  const daysOverdue = svc.due && svc.nextDueDate
    ? Math.max(0, daysBetween(svc.nextDueDate, serviceDate))
    : 0;

  const lastServiceDate = svc.lastServiceDate || null;
  const isVip = /vip/i.test(String(acct.Priority_Tier__c || ''));

  const reasonFacts = {
    lastUcoDate: lastServiceDate,
    lastUcoGallons: lastGallons != null && lastGallons !== '' && Number.isFinite(Number(lastGallons))
      ? Number(lastGallons)
      : null,
    nextDueDate: svc.nextDueDate || null,
    daysOverdue,
    due: !!svc.due,
    hasUcoHistory,
    historyUnavailable,
    mustRemainOnRoute: !!remain.mustRemainOnRoute,
    isFixed: !!stop?.Fixed_point__c,
    isVip,
    dueReason: svc.reason || null,
    remainReasonLabel: remainReasonLabel(remain.remainReason),
  };

  const accountId = resolveStopAccountId(stop);

  return {
    stopId: stop?.Id,
    accountId,
    accountName: stop?.Account_Name__c,
    priority: stop?.Priority__c,
    serviceType: stop?.ServiceType__c,
    lastGallons,
    isFixed: !!stop?.Fixed_point__c,
    lat: stop?.Latitude__c,
    lng: stop?.Longitude__c,
    tankSize: acct.Tank_Size__c,
    secondContainer: acct.Second_Container__c,
    lastServiceDate,
    nextDueDate: svc.nextDueDate || null,
    effectiveFrequencyDays: svc.effectiveFrequencyDays,
    daysOverdue,
    due: !!svc.due,
    dueReason: svc.reason || null,
    hasUcoHistory,
    historyUnavailable,
    mustRemainOnRoute: remain.mustRemainOnRoute,
    remainReason: remain.remainReason,
    remainReasonLabel: remainReasonLabel(remain.remainReason),
    ucoServiceCount: remain.ucoServiceCount,
    cdlDeliveryDate: remain.cdlDeliveryDate,
    gpdHistorySpanDays: acct.DaysInterval__c,
    priorityTier: acct.Priority_Tier__c,
    routeNotes: acct.Route_Notes__c,
    specialInstructions: acct.Notes__c,
    driverNotes: stop?.Driver_Notes__c,
    reasonFacts,
    recentServices: services.map((sv) => ({
      gallons: sv.Qty_Gallons__c,
      date: sv.Service_Date__c,
      recordType: sv.RecordType?.Name || null,
      recordTypeDeveloperName: sv.RecordType?.DeveloperName || null,
    })),
    _remain: remain,
  };
}

/**
 * Indexes reasonFacts (and remain) by account Id for post-AI overrides.
 * Keys both full and 15-char Ids.
 */
function indexStopFactsByAccountId(stopsData = []) {
  const map = {};
  for (const s of stopsData) {
    if (!s?.accountId) continue;
    const entry = {
      reasonFacts: s.reasonFacts,
      remain: s._remain || {
        mustRemainOnRoute: s.mustRemainOnRoute,
        remainReason: s.remainReason,
        ucoServiceCount: s.ucoServiceCount,
      },
      due: s.due,
      hasUcoHistory: s.hasUcoHistory,
      historyUnavailable: s.historyUnavailable,
      isFixed: s.isFixed,
      isVip: s.reasonFacts?.isVip,
    };
    map[s.accountId] = entry;
    const key = normalizeSfId(s.accountId);
    if (key) map[key] = entry;
  }
  return map;
}

function lookupStopFacts(factsByAccountId, accountId) {
  if (!accountId || !factsByAccountId) return null;
  return factsByAccountId[accountId] || factsByAccountId[normalizeSfId(accountId)] || null;
}

/**
 * True when engine facts leave no justification for keeping the stop:
 * serviced history exists, a next due date was computed and it is still ahead,
 * and no remain/fixed/VIP rule applies. A missing nextDueDate means the engine
 * could not resolve a cadence (no_frequency) — a data gap, not a "not due".
 */
function shouldForceNotDue(facts) {
  if (!facts) return false;
  return !!facts.hasUcoHistory
    && !!facts.nextDueDate
    && !facts.due
    && !(Number(facts.daysOverdue) > 0)
    && !facts.mustRemainOnRoute
    && !facts.isFixed
    && !facts.isVip;
}

/**
 * Post-AI safety net: force KEEP when history + due/remain/VIP/fixed, force
 * REMOVE when nothing justifies keeping a not-due stop, and rewrite cryptic /
 * false “no history” reasons into plain English.
 */
function applyServiceHistoryReasonOverride(existingStops = [], factsByAccountId = {}) {
  return existingStops.map((rec) => {
    const entry = lookupStopFacts(factsByAccountId, rec.accountId);
    const facts = entry?.reasonFacts;
    if (!facts) {
      if (looksCrypticReason(rec.reason)) {
        return {
          ...rec,
          reason: 'Needs manager review — service details unavailable.',
          _historyReasonOverride: true,
        };
      }
      return rec;
    }

    // History was never read — the AI cannot be allowed to claim there is none.
    if (facts.historyUnavailable) {
      if (NO_HISTORY_CLAIM_RE.test(String(rec.reason || '')) || looksCrypticReason(rec.reason)) {
        return {
          ...rec,
          action: 'flag',
          reason: HISTORY_UNAVAILABLE_REASON,
          _historyReasonOverride: true,
        };
      }
      return rec;
    }

    const forceKeep = facts.hasUcoHistory
      && (facts.due || facts.mustRemainOnRoute || facts.isFixed || facts.isVip);

    let action = String(rec.action || 'flag').toLowerCase();
    if (forceKeep && action !== 'keep' && action !== 'overflow') {
      action = 'keep';
    }

    // "Not due yet" is never a reason to keep a stop. Rebuild the reason from
    // engine facts so the model's soft rationale cannot trail a Remove verb.
    if (!forceKeep && (action === 'keep' || action === 'overflow') && shouldForceNotDue(facts)) {
      return {
        ...rec,
        action: 'remove',
        confidence: Math.max(Number(rec.confidence) || 0, 90),
        reason: formatManagerReason(facts, 'remove', deriveWhy(facts, 'remove')),
        _notDueOverride: true,
        _historyReasonOverride: true,
      };
    }

    const cryptic = looksCrypticReason(rec.reason);
    const falseNoHistory = facts.hasUcoHistory
      && /no lastServiceDate|no service history|ucoServiceCount\s*=\s*0/i.test(String(rec.reason || ''));

    if (forceKeep || cryptic || falseNoHistory || !rec.reason) {
      const why = (!cryptic && !falseNoHistory && rec.reason && !forceKeep)
        ? stripFieldNames(rec.reason)
        : deriveWhy(facts, action);
      return {
        ...rec,
        action,
        confidence: forceKeep
          ? Math.max(Number(rec.confidence) || 0, 90)
          : rec.confidence,
        reason: formatManagerReason(facts, action, why),
        _historyReasonOverride: true,
      };
    }

    // Soft AI reason kept — still normalize if it lacks the Last UCO prefix.
    if (facts.hasUcoHistory && !/^Last UCO:/i.test(String(rec.reason).trim())) {
      const softWhy = stripFieldNames(rec.reason) || deriveWhy(facts, action);
      return {
        ...rec,
        action,
        reason: formatManagerReason(facts, action, softWhy),
        _historyReasonOverride: true,
      };
    }

    if (!facts.hasUcoHistory && !/^No UCO pickups/i.test(String(rec.reason).trim())) {
      return {
        ...rec,
        action,
        reason: formatManagerReason(facts, action, deriveWhy(facts, action)),
        _historyReasonOverride: true,
      };
    }

    return rec;
  });
}

/** Strips camelCase field dumps from free-text AI why clauses. */
function stripFieldNames(text) {
  if (!text) return null;
  let t = String(text)
    .replace(/\b(lastServiceDate|nextDueDate|ucoServiceCount|lastGallons|dueReason|mustRemainOnRoute|gpdHistorySpanDays)\s*=\s*[^,;.]+[,;.]?\s*/gi, '')
    .replace(/\bNo lastServiceDate\b[,;.]?\s*/gi, '')
    .replace(/\bno nextDueDate\b[,;.]?\s*/gi, '')
    .replace(/\bNo service history[^.]*\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || looksCrypticReason(t) || t.length < 3) return null;
  // Prefer a short trailing clause after em-dash if present.
  const dash = t.split(/—|-/).map((s) => s.trim()).filter(Boolean);
  if (dash.length >= 2) t = dash[dash.length - 1];
  return t.replace(/\.$/, '');
}

module.exports = {
  HISTORY_UNAVAILABLE_REASON,
  normalizeSfId,
  indexAccountsById,
  lookupAccount,
  resolveStopAccountId,
  rawServiceRows,
  looksCrypticReason,
  formatShortDate,
  formatManagerReason,
  deriveWhy,
  buildEnhanceStopRow,
  indexStopFactsByAccountId,
  shouldForceNotDue,
  applyServiceHistoryReasonOverride,
};
