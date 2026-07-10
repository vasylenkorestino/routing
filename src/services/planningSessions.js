/**
 * Durable persistence for AI Route Planning sessions.
 *
 * Stores sessions in the NEW Salesforce objects Route_Plan_Session__c (header)
 * and Route_Plan_Route__c (mock routes). These are completely separate from
 * Google_Route__c / Route__c — nothing here touches the real routing objects.
 * The full mock-route JSON (including stops + coordinates) is stored on
 * Route_Plan_Route__c.Metrics_JSON__c so a session can be reopened and rendered
 * without re-querying accounts.
 */

const sf = require('./salesforce');
const logger = require('../utils/logger');

const MAX_LONGTEXT = 131000;

/** Validates a Salesforce Id (15/18-char alphanumeric) for safe interpolation. */
function safeId(id) {
  const s = String(id || '');
  if (!/^[a-zA-Z0-9]{15,18}$/.test(s)) throw new Error(`Invalid Salesforce Id: ${s}`);
  return s;
}

function nowIso() {
  return new Date().toISOString();
}

/** Creates a new Planning session record. */
async function createSession(params, owner = null) {
  const record = {
    Status__c: 'Planning',
    Plan_Date_From__c: params.dateFrom,
    Plan_Date_To__c: params.dateTo || params.dateFrom,
    Record_Type_Scope__c: params.recordType || null,
    Params_JSON__c: JSON.stringify({ ...params, owner }).slice(0, MAX_LONGTEXT),
    Admin_Notes__c: '',
    Last_Opened__c: nowIso(),
    Edit_Version__c: 0,
  };
  if (params.serviceLocationId) record.Service_Location__c = params.serviceLocationId;

  const [res] = await sf.insert('Route_Plan_Session__c', [record]);
  if (!res.success) throw new Error('Failed to create planning session');
  logger.info('[planningSessions] created', { id: res.id });
  return { id: res.id, editVersion: 0, status: 'Planning', ...params };
}

/** Lists resumable (Planning) sessions with route counts. */
async function listSessions() {
  const rows = await sf.query(
    'SELECT Id, Name, Status__c, Plan_Date_From__c, Plan_Date_To__c, Record_Type_Scope__c, ' +
    'Service_Location__c, Service_Location__r.Name, Last_Opened__c, Edit_Version__c, ' +
    '(SELECT Id, Committed__c FROM Route_Plan_Routes__r) ' +
    "FROM Route_Plan_Session__c WHERE Status__c = 'Planning' " +
    'ORDER BY Last_Opened__c DESC NULLS LAST LIMIT 50',
  );
  return rows.map((r) => {
    const child = r.Route_Plan_Routes__r?.records || [];
    return {
      id: r.Id,
      name: r.Name,
      status: r.Status__c,
      dateFrom: r.Plan_Date_From__c,
      dateTo: r.Plan_Date_To__c,
      recordType: r.Record_Type_Scope__c,
      serviceLocationId: r.Service_Location__c,
      serviceLocationName: r.Service_Location__r?.Name || null,
      lastOpened: r.Last_Opened__c,
      editVersion: r.Edit_Version__c || 0,
      routeCount: child.length,
      committedCount: child.filter((c) => c.Committed__c).length,
    };
  });
}

/** Loads a full session (header + mock routes reconstructed from Metrics_JSON__c). */
async function getSession(id, { bumpLastOpened = false } = {}) {
  const sid = safeId(id);
  const [session] = await sf.query(
    'SELECT Id, Name, Status__c, Plan_Date_From__c, Plan_Date_To__c, Record_Type_Scope__c, ' +
    'Service_Location__c, Service_Location__r.Name, Admin_Notes__c, Params_JSON__c, ' +
    'Committed_Google_Route_Ids__c, Edit_Version__c, Last_Opened__c ' +
    `FROM Route_Plan_Session__c WHERE Id = '${sid}' LIMIT 1`,
  );
  if (!session) return null;

  const childRows = await sf.query(
    'SELECT Id, Route_Name__c, Ordered_Account_Ids__c, Service_Date__c, Service_Location__c, ' +
    'Metrics_JSON__c, Explanation__c, Admin_Notes__c, Sort_Order__c, Committed__c, ' +
    'Committed_Route_Id__c, Keep_Order__c ' +
    `FROM Route_Plan_Route__c WHERE Plan_Session__c = '${sid}' ` +
    'ORDER BY Service_Date__c ASC NULLS FIRST, Sort_Order__c ASC',
  );

  const routes = childRows.map((row) => {
    let route = {};
    try { route = JSON.parse(row.Metrics_JSON__c || '{}'); } catch { route = {}; }
    return {
      ...route,
      sfId: row.Id,
      routeName: row.Route_Name__c || route.routeName,
      serviceDate: row.Service_Date__c || route.serviceDate,
      serviceLocationId: row.Service_Location__c || route.serviceLocationId,
      explanation: row.Explanation__c || route.explanation || '',
      adminNotes: row.Admin_Notes__c || '',
      committed: !!row.Committed__c,
      committedRouteId: row.Committed_Route_Id__c || null,
      keepOrder: !!row.Keep_Order__c,
    };
  });

  if (bumpLastOpened) {
    try {
      await sf.update('Route_Plan_Session__c', [{ Id: sid, Last_Opened__c: nowIso() }]);
    } catch (err) {
      logger.warn('[planningSessions] failed to bump Last_Opened', { id: sid, error: err.message });
    }
  }

  let params = {};
  try { params = JSON.parse(session.Params_JSON__c || '{}'); } catch { params = {}; }

  return {
    session: {
      id: session.Id,
      name: session.Name,
      status: session.Status__c,
      dateFrom: session.Plan_Date_From__c,
      dateTo: session.Plan_Date_To__c,
      recordType: session.Record_Type_Scope__c,
      serviceLocationId: session.Service_Location__c,
      serviceLocationName: session.Service_Location__r?.Name || null,
      adminNotes: session.Admin_Notes__c || '',
      committedGoogleRouteIds: session.Committed_Google_Route_Ids__c || '',
      editVersion: session.Edit_Version__c || 0,
      params,
    },
    routes,
  };
}

/** Builds a Route_Plan_Route__c record from a client mock-route object. */
function childRecordFrom(route, index, sessionId) {
  return {
    Plan_Session__c: sessionId,
    Route_Name__c: (route.routeName || '').slice(0, 255),
    Ordered_Account_Ids__c: (route.accountIds || []).join(',').slice(0, MAX_LONGTEXT),
    Service_Date__c: route.serviceDate || null,
    Service_Location__c: route.serviceLocationId || null,
    Metrics_JSON__c: JSON.stringify(route).slice(0, MAX_LONGTEXT),
    Explanation__c: (route.explanation || '').slice(0, 4096),
    Admin_Notes__c: (route.adminNotes || '').slice(0, 4096),
    Sort_Order__c: index,
    Committed__c: false,
    Keep_Order__c: !!route.keepOrder,
  };
}

/**
 * Replaces the working (non-committed) mock routes for a session and updates
 * session-level fields. Committed rows are preserved for idempotent retries.
 * Uses optimistic concurrency on Edit_Version__c.
 * @returns {Promise<{editVersion:number, saved:{index:number, sfId:string}[]}>}
 */
async function saveSession(id, { routes = [], adminNotes, params, editVersion } = {}) {
  const sid = safeId(id);
  const [current] = await sf.query(
    `SELECT Id, Edit_Version__c, Status__c FROM Route_Plan_Session__c WHERE Id = '${sid}' LIMIT 1`,
  );
  if (!current) { const e = new Error('Session not found'); e.code = 'NOT_FOUND'; throw e; }
  if (current.Status__c !== 'Planning') { const e = new Error('Session is not editable'); e.code = 'LOCKED'; throw e; }

  const currentVersion = current.Edit_Version__c || 0;
  if (editVersion != null && Number(editVersion) !== currentVersion) {
    const e = new Error('Session was modified elsewhere');
    e.code = 'VERSION_CONFLICT';
    e.currentVersion = currentVersion;
    throw e;
  }

  const existing = await sf.query(
    `SELECT Id, Committed__c FROM Route_Plan_Route__c WHERE Plan_Session__c = '${sid}'`,
  );
  const toDelete = existing.filter((r) => !r.Committed__c).map((r) => r.Id);
  if (toDelete.length > 0) {
    const conn = await sf.getConnection();
    await conn.sobject('Route_Plan_Route__c').destroy(toDelete);
  }

  const working = routes.filter((r) => !r.committed);
  const inserts = working.map((r, i) => childRecordFrom(r, i, sid));
  let saved = [];
  if (inserts.length > 0) {
    const results = await sf.insert('Route_Plan_Route__c', inserts);
    saved = results.map((res, i) => ({ index: i, sfId: res.success ? res.id : null }));
  }

  const sessionUpdate = { Id: sid, Last_Opened__c: nowIso(), Edit_Version__c: currentVersion + 1 };
  if (adminNotes != null) sessionUpdate.Admin_Notes__c = String(adminNotes).slice(0, MAX_LONGTEXT);
  if (params) sessionUpdate.Params_JSON__c = JSON.stringify(params).slice(0, MAX_LONGTEXT);
  await sf.update('Route_Plan_Session__c', [sessionUpdate]);

  return { editVersion: currentVersion + 1, saved };
}

/** Marks specific mock routes committed with their created Google_Route__c ids. */
async function markRoutesCommitted(sessionId, committed) {
  if (!committed || committed.length === 0) return;
  const updates = committed
    .filter((c) => c.sfId)
    .map((c) => ({ Id: safeId(c.sfId), Committed__c: true, Committed_Route_Id__c: c.googleRouteId || null }));
  if (updates.length > 0) await sf.update('Route_Plan_Route__c', updates);
}

/** Records session-level commit outcome and flips the session to Committed. */
async function finalizeCommit(sessionId, googleRouteIds, { markCommitted = true } = {}) {
  const sid = safeId(sessionId);
  const update = {
    Id: sid,
    Committed_Google_Route_Ids__c: (googleRouteIds || []).join(',').slice(0, MAX_LONGTEXT),
  };
  if (markCommitted) update.Status__c = 'Committed';
  await sf.update('Route_Plan_Session__c', [update]);
}

/** Soft-archives a session so it drops off the resume list. */
async function archiveSession(id) {
  const sid = safeId(id);
  await sf.update('Route_Plan_Session__c', [{ Id: sid, Status__c: 'Archived' }]);
}

module.exports = {
  createSession,
  listSessions,
  getSession,
  saveSession,
  markRoutesCommitted,
  finalizeCommit,
  archiveSession,
  safeId,
};
