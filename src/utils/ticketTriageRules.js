/** Record types used for route ↔ ticket matching (Google_Route__c / Case). */
const ROUTING_RECORD_TYPES = new Set(['EZG', 'ENJ']);

/** True when the Case is a UCO Collection ticket (only these trigger AWS triage/notifications). */
function isUcoTicket(ticket) {
  if (!ticket) return false;
  const type = String(ticket.type || ticket.Type || ticket.typeName || '').trim();
  return type === 'UCO Collection';
}

/** Case record type name (EZG, ENJ, …) from webhook or RouteLog payload. */
function ticketRecordTypeName(ticket) {
  const rt = String(ticket?.recordType || ticket?.caseRecordType || '').trim();
  return ROUTING_RECORD_TYPES.has(rt) ? rt : null;
}

/** Account depot — RelatedServiceLocation__c (Service_Location__c Id). */
function accountServiceLocationId(account, ticket) {
  return account?.RelatedServiceLocation__c
    || account?.relatedServiceLocationId
    || ticket?.accountServiceLocationId
    || null;
}

/** Whether a candidate route matches ticket record type and account service location. */
function routeMatchesTicketContext(route, ticketRecordType, serviceLocationId) {
  if (ticketRecordType && route.recordTypeName && route.recordTypeName !== ticketRecordType) {
    return false;
  }
  if (serviceLocationId) {
    const start = route.serviceLocationStartId || route.serviceLocationStart || null;
    const end = route.serviceLocationEndId || route.serviceLocationEnd || null;
    if (start !== serviceLocationId && end !== serviceLocationId) {
      return false;
    }
  }
  return true;
}

function escapeSoql(value) {
  return String(value).replace(/'/g, "\\'");
}

module.exports = {
  ROUTING_RECORD_TYPES,
  isUcoTicket,
  ticketRecordTypeName,
  accountServiceLocationId,
  routeMatchesTicketContext,
  escapeSoql,
};
