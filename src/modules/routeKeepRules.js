/**
 * New-account / CDL "remain on route" rules (pure — no Salesforce I/O).
 *
 * KEEP if on route / ADD-eligible if missing when:
 *   1. 1–2 UCO Collection services completed (first three services window), OR
 *   2. Zero UCO services and newest Deliver Container (CDL) is >14 days before route date.
 *
 * CDL younger than 14 days with no UCO does not force remain (tank too new).
 * Mature accounts (3+ UCO) use normal service-due logic.
 */

const { daysBetween, isUcoCollectionService } = require('./serviceDue');

const CDL_REMAIN_AFTER_DAYS = 14;
const NEW_ACCOUNT_UCO_SERVICE_CAP = 3;

/** True when a Service__c row is Deliver Container / CDL. */
function isCdlService(service) {
  const code = service?.Code__c || '';
  if (code === 'CDL') return true;
  if (code === 'UCO') return false;
  const name = service?.RecordType?.Name || service?.RecordTypeName__c || '';
  const dev = service?.RecordType?.DeveloperName || service?.RecordTypeDeveloperName__c || '';
  return name === 'Deliver Container' || dev === 'Tank_Delivered';
}
/** Normalizes Services__r into raw service rows (jsforce wrapper or array). */
function rawServices(account) {
  return account?.Services__r?.records || account?.Services__r || [];
}

/** Counts dated UCO Collection services (CDL excluded). */
function countUcoServices(account) {
  return rawServices(account).filter((s) => s?.Service_Date__c && isUcoCollectionService(s)).length;
}

/** Newest Deliver Container (CDL) service date as YYYY-MM-DD, or null. */
function resolveCdlDeliveryDate(account) {
  const dates = rawServices(account)
    .filter((s) => s?.Service_Date__c && isCdlService(s))
    .map((s) => String(s.Service_Date__c).slice(0, 10))
    .sort((a, b) => (a < b ? 1 : -1));
  return dates[0] || null;
}

/**
 * Evaluates whether an account must remain on / be added to the route.
 *
 * @param {object} account - Account with Services__r (UCO + Deliver Container)
 * @param {string} routeDate - Route service date YYYY-MM-DD
 * @returns {{
 *   mustRemainOnRoute: boolean,
 *   remainReason: string|null,
 *   ucoServiceCount: number,
 *   cdlDeliveryDate: string|null,
 *   cdlAgeDays: number|null
 * }}
 */
function evaluateMustRemainOnRoute(account, routeDate) {
  const ucoServiceCount = countUcoServices(account);
  const cdlDeliveryDate = resolveCdlDeliveryDate(account);
  const cdlAgeDays = cdlDeliveryDate && routeDate
    ? daysBetween(cdlDeliveryDate, routeDate)
    : null;

  // First three UCO services: remain while fewer than 3 collections exist.
  if (ucoServiceCount > 0 && ucoServiceCount < NEW_ACCOUNT_UCO_SERVICE_CAP) {
    return {
      mustRemainOnRoute: true,
      remainReason: `new_account_fewer_than_${NEW_ACCOUNT_UCO_SERVICE_CAP}_uco_services`,
      ucoServiceCount,
      cdlDeliveryDate,
      cdlAgeDays,
    };
  }

  // New tank: after CDL wait, remain for first pickup.
  if (ucoServiceCount === 0 && cdlAgeDays != null && cdlAgeDays > CDL_REMAIN_AFTER_DAYS) {
    return {
      mustRemainOnRoute: true,
      remainReason: `cdl_delivery_older_than_${CDL_REMAIN_AFTER_DAYS}_days`,
      ucoServiceCount,
      cdlDeliveryDate,
      cdlAgeDays,
    };
  }

  return {
    mustRemainOnRoute: false,
    remainReason: null,
    ucoServiceCount,
    cdlDeliveryDate,
    cdlAgeDays,
  };
}

/** Human-readable keep reason for road logs / AI override. */
function remainReasonLabel(remainReason) {
  if (!remainReason) return null;
  if (remainReason.startsWith('new_account_fewer_than_')) {
    return 'New account: fewer than 3 UCO services — remain on route';
  }
  if (remainReason.startsWith('cdl_delivery_older_than_')) {
    return 'CDL delivery more than 14 days ago — remain on route';
  }
  return remainReason;
}

/**
 * Forces Claude stop recommendations to keep when mustRemainOnRoute.
 * Leaves keep/overflow/add actions unchanged.
 */
function applyMustRemainKeepOverride(existingStops = [], remainByAccountId = {}) {
  return existingStops.map((rec) => {
    const remain = remainByAccountId[rec.accountId];
    if (!remain?.mustRemainOnRoute) return rec;
    if (rec.action === 'keep' || rec.action === 'overflow') return rec;
    return {
      ...rec,
      action: 'keep',
      confidence: Math.max(Number(rec.confidence) || 0, 95),
      reason: remainReasonLabel(remain.remainReason) || rec.reason,
      _remainOverride: true,
    };
  });
}

module.exports = {
  CDL_REMAIN_AFTER_DAYS,
  NEW_ACCOUNT_UCO_SERVICE_CAP,
  isCdlService,
  countUcoServices,
  resolveCdlDeliveryDate,
  evaluateMustRemainOnRoute,
  remainReasonLabel,
  applyMustRemainKeepOverride,
};
