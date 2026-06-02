/**
 * SF → AWS sync handlers.
 *
 * Receives webhook payloads from Salesforce triggers (Case, Route__c, Google_Route__c)
 * and:
 *   1. Patches RouteLog__c lifecycle fields when the related ticket changes/deletes.
 *   2. Republishes route/google_route events through the in-process notificationBus
 *      so connected SSE clients can apply selective patches to their stores
 *      without re-querying.
 *
 * Each handler returns a Promise that resolves once the work for the chunk is done
 * (best-effort; errors are logged but never throw to the HTTP layer).
 */

const { getConnection } = require('./salesforce');
const { triageTicket, isUcoTicket } = require('./ticketTriage');
const { ticketRecordTypeName } = require('../utils/ticketTriageRules');
const { publish, EVENT_SF_CHANGED } = require('./notificationBus');
const logger = require('../utils/logger');

/* ── Case (ticket) lifecycle ───────────────────────────────────────────── */

/** Triage every newly created Case; existing flow, kept here so the dispatcher is uniform. */
async function handleCaseCreated(records) {
  for (const ticket of records) {
    if (!ticket?.id) continue;
    if (!isUcoTicket(ticket)) {
      logger.info('[sfSync] skipping triage for non-UCO ticket', {
        ticketId: ticket.id,
        type: ticket.type || ticket.typeName,
      });
      continue;
    }
    if (!ticketRecordTypeName(ticket)) {
      logger.info('[sfSync] skipping triage for unsupported record type', {
        ticketId: ticket.id,
        recordType: ticket.recordType,
      });
      continue;
    }
    setImmediate(async () => {
      try {
        await triageTicket(ticket);
      } catch (err) {
        logger.error('[sfSync] triage failed', { error: err.message, ticketId: ticket.id });
      }
    });
  }
}

/**
 * Mark RouteLog__c records linked to the changed ticket with the new
 * last-modified metadata so the routing UI can show ticket-was-edited badges.
 */
async function handleCaseUpdated(records) {
  if (!records.length) return;
  try {
    const conn = await getConnection();
    const ticketIds = records.map((r) => r.id).filter(Boolean);
    if (!ticketIds.length) return;

    const logs = await fetchLogsByTicket(conn, ticketIds);
    if (!logs.length) {
      logger.info('[sfSync] case-updated: no related RouteLogs', { ticketIds: ticketIds.length });
      return;
    }

    const ticketByid = new Map(records.map((r) => [r.id, r]));
    const updates = logs.map((log) => {
      const t = ticketByid.get(log.Ticket__c) || {};
      return {
        Id: log.Id,
        Ticket_Last_Modified_Date__c: t.lastModifiedDate || new Date().toISOString(),
        Ticket_Last_Modified_By__c: (t.lastModifiedBy || '').toString().slice(0, 80) || null,
      };
    });
    await conn.sobject('RouteLog__c').update(updates);
    logger.info('[sfSync] case-updated patched RouteLogs', { count: updates.length });
  } catch (err) {
    logger.error('[sfSync] case-updated failed', { error: err.message });
  }
}

/**
 * Mark every RouteLog__c that referenced the deleted ticket as Ticket_Deleted__c=true
 * so users can audit which proposals/accepts pointed at a now-removed Case.
 */
async function handleCaseDeleted(records) {
  if (!records.length) return;
  try {
    const conn = await getConnection();
    const ticketIds = records.map((r) => r.id).filter(Boolean);
    if (!ticketIds.length) return;

    const logs = await fetchLogsByTicket(conn, ticketIds);
    if (!logs.length) {
      logger.info('[sfSync] case-deleted: no related RouteLogs', { ticketIds: ticketIds.length });
      return;
    }

    const ticketById = new Map(records.map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const updates = logs.map((log) => {
      const t = ticketById.get(log.Ticket__c) || {};
      return {
        Id: log.Id,
        Ticket_Deleted__c: true,
        Ticket_Last_Modified_Date__c: t.lastModifiedDate || now,
        Ticket_Last_Modified_By__c: (t.lastModifiedBy || '').toString().slice(0, 80) || null,
      };
    });
    await conn.sobject('RouteLog__c').update(updates);
    logger.info('[sfSync] case-deleted marked RouteLogs', { count: updates.length });
  } catch (err) {
    logger.error('[sfSync] case-deleted failed', { error: err.message });
  }
}

/* ── Route__c (route stop) ─────────────────────────────────────────────── */

async function handleRouteChanged(event, records) {
  if (!records.length) return;
  for (const record of records) {
    publish(EVENT_SF_CHANGED, { object: 'route', event, record });
  }
  logger.info('[sfSync] broadcast route change', { event, count: records.length });
}

/* ── Google_Route__c (route header) ────────────────────────────────────── */

async function handleGoogleRouteChanged(event, records) {
  if (!records.length) return;
  for (const record of records) {
    publish(EVENT_SF_CHANGED, { object: 'google_route', event, record });
  }
  logger.info('[sfSync] broadcast google_route change', { event, count: records.length });
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

async function fetchLogsByTicket(conn, ticketIds) {
  const inList = ticketIds
    .map((id) => `'${String(id).replace(/'/g, "\\'")}'`)
    .join(',');
  const soql = `
    SELECT Id, Ticket__c, Status__c
    FROM RouteLog__c
    WHERE Ticket__c IN (${inList})
    LIMIT 500
  `;
  const result = await conn.query(soql);
  return result.records || [];
}

/**
 * Single dispatcher shared by the webhook router. Maps `${object}-${event}`
 * to a handler so adding a new lifecycle is a one-line change.
 */
async function dispatch(object, event, records) {
  const safeRecords = Array.isArray(records) ? records : [];
  const key = `${object}-${event}`;
  switch (key) {
    case 'case-created':
      return handleCaseCreated(safeRecords);
    case 'case-updated':
      return handleCaseUpdated(safeRecords);
    case 'case-deleted':
      return handleCaseDeleted(safeRecords);
    case 'route-created':
    case 'route-updated':
    case 'route-deleted':
      return handleRouteChanged(event, safeRecords);
    case 'google_route-created':
    case 'google_route-updated':
    case 'google_route-deleted':
      return handleGoogleRouteChanged(event, safeRecords);
    default:
      logger.warn('[sfSync] no handler for event', { object, event });
      return null;
  }
}

module.exports = {
  dispatch,
  handleCaseCreated,
  handleCaseUpdated,
  handleCaseDeleted,
  handleRouteChanged,
  handleGoogleRouteChanged,
};
