/** Inactive stop row background (admin / map view). */
const INACTIVE_STYLE = 'background: rgba(237, 197, 85, 0.815)';
/** Serviced stop row background. */
const COMPLETE_STYLE = 'background: rgba(140,217,179,1)';

/**
 * Applies row style and display Status__c for a Route__c stop.
 * Mirrors routingApplicationHelper.js preparePoints status logic.
 */
export function applyPointStatusStyle(point) {
  if (point.Status__c == 'New') {
    point.style = 'background: none;';
  } else if (point.Inactive__c == true) {
    point.style = INACTIVE_STYLE;
  } else if (point.Inactive__c == false) {
    point.style = COMPLETE_STYLE;
    point.Status__c = 'Complete';
  } else if (point.Status__c != 'New' && point.Inactive__c != true) {
    point.style = COMPLETE_STYLE;
    point.Status__c = 'Complete';
  }
}

/** Normalises Routes__r to an array of stop records. */
function toStopList(routesR) {
  if (!routesR) return [];
  if (Array.isArray(routesR)) return routesR;
  if (Array.isArray(routesR.records)) return routesR.records;
  return [];
}

/** Applies display fields and status styling to route stops (LWC preparePoints parity). */
export function preparePoints(points) {
  const list = toStopList(points).map((p) => ({ ...p }));

  list.forEach((point) => {
    if (point.AccountId__c) {
      point.accountLink = `/${point.AccountId__c}`;
    }
    point.specialInstructions = point?.Account__r?.Notes__c;
    applyPointStatusStyle(point);
  });

  list.sort((a, b) => (a.Priority__c ?? 9999) - (b.Priority__c ?? 9999));
  list.forEach((point, index) => {
    point.order = index + 1;
  });

  return list;
}

/** Applies preparePoints to each route's Routes__r child stops. */
export function prepareGoogleRoutes(routes) {
  return (routes || []).map((route) => {
    const prepared = preparePoints(route.Routes__r);
    return {
      ...route,
      points: prepared,
      Routes__r: Array.isArray(route.Routes__r)
        ? prepared
        : { ...(route.Routes__r || {}), records: prepared },
    };
  });
}
