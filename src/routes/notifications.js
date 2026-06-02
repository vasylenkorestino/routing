const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { getConnection } = require('../services/salesforce');
const { subscribe } = require('../services/notificationBus');
const { assertRouteOpen, RouteClosedError } = require('../skills/routeReadiness');
const { triageTicket } = require('../services/ticketTriage');
const logger = require('../utils/logger');

const TRIAGE_SKILL = 'Ticket Triage';
const HEARTBEAT_MS = 25000;

/**
 * GET /api/notifications/stream
 * Server-Sent Events stream of triage notifications.
 * EventSource cannot send custom headers, so the JWT is accepted via `?token=...`.
 */
router.get('/stream', (req, res) => {
  const token = req.query.token || extractBearer(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: ready\ndata: ${JSON.stringify({ user: user?.email || user?.name || 'unknown' })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, HEARTBEAT_MS);

  const unsubscribe = subscribe((message) => {
    try {
      res.write(`event: ${message.event}\n`);
      res.write(`data: ${JSON.stringify(message.payload)}\n\n`);
    } catch (err) {
      logger.warn('[notifications] write failed, closing stream', { error: err.message });
    }
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

/**
 * GET /api/notifications
 * Initial unread list: triage RouteLog__c records the user has not yet dismissed.
 */
router.get('/', async (req, res, next) => {
  try {
    const conn = await getConnection();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const soql = `
      SELECT Id, Name, CreatedDate, Read_Date__c, Status__c, Type__c, Skill__c,
             Confidence__c, Reason__c, Input_Data__c,
             Account__c, Account__r.Name, Account__r.MALatitude__c, Account__r.MALongitude__c,
             Google_Route__c, Google_Route__r.Name,
             Ticket__c, Ticket__r.CaseNumber, Ticket__r.Subject, Ticket__r.Type,
             Ticket__r.CreatedDate, Ticket__r.RecordType.Name,
             Accepted_By__c, Accepted_Date__c
      FROM RouteLog__c
      WHERE Skill__c = '${TRIAGE_SKILL}' AND Read_Date__c = null
      ORDER BY CreatedDate DESC
      LIMIT ${limit}
    `;
    const result = await conn.query(soql);
    const notifications = (result.records || []).map(toNotification);
    res.json({ notifications, unreadCount: notifications.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/:id/accept
 * Accept a triage proposal. Updates RouteLog__c.Status__c to 'Accepted'; the
 * existing RouteLogTriggerHelper Apex creates the Route__c stop and triggers
 * async optimization. Rejected with 409 if the target route is closed/started.
 */
router.post('/:id/accept', async (req, res, next) => {
  try {
    const conn = await getConnection();
    const log = await loadTriageLog(conn, req.params.id);
    if (!log) return res.status(404).json({ error: 'Notification not found' });
    if (log.Status__c !== 'Proposed') {
      return res.status(409).json({ error: `Notification already ${log.Status__c}`, reason: 'NOT_PROPOSED' });
    }

    if (log.Google_Route__c) {
      try {
        await assertRouteOpen(conn, log.Google_Route__c);
      } catch (err) {
        if (err instanceof RouteClosedError) {
          return res.status(409).json({ error: err.message, reason: err.reason, code: 'ROUTE_CLOSED' });
        }
        throw err;
      }
    }

    const acceptedBy = req.driver?.name || req.driver?.email || 'AWS Agent';
    const now = new Date().toISOString();
    await conn.sobject('RouteLog__c').update({
      Id: log.Id,
      Status__c: 'Accepted',
      Accepted_By__c: acceptedBy,
      Accepted_Date__c: now,
      Read_Date__c: now,
    });

    res.json({ success: true, status: 'Accepted', acceptedBy, acceptedAt: now });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/:id/decline
 * Decline a triage proposal. Marks RouteLog__c as 'Declined' and re-triages
 * the same ticket with the declined Google_Route__c excluded so the AI picks
 * a different candidate. The retry log is linked back via Parent_Log__c.
 */
router.post('/:id/decline', async (req, res, next) => {
  try {
    const conn = await getConnection();
    const log = await loadTriageLog(conn, req.params.id);
    if (!log) return res.status(404).json({ error: 'Notification not found' });
    if (log.Status__c !== 'Proposed') {
      return res.status(409).json({ error: `Notification already ${log.Status__c}`, reason: 'NOT_PROPOSED' });
    }

    if (log.Google_Route__c) {
      try {
        await assertRouteOpen(conn, log.Google_Route__c);
      } catch (err) {
        if (err instanceof RouteClosedError) {
          return res.status(409).json({ error: err.message, reason: err.reason, code: 'ROUTE_CLOSED' });
        }
        throw err;
      }
    }

    const now = new Date().toISOString();
    await conn.sobject('RouteLog__c').update({
      Id: log.Id,
      Status__c: 'Declined',
      Read_Date__c: now,
    });

    const ticket = parseStoredTicket(log.Input_Data__c);
    if (ticket && ticket.id) {
      const exclude = log.Google_Route__c ? [log.Google_Route__c] : [];
      setImmediate(() => {
        triageTicket(ticket, { excludeRouteIds: exclude, parentLogId: log.Id }).catch((err) =>
          logger.error('[notifications] re-triage after decline failed', { error: err.message, logId: log.Id }),
        );
      });
    } else {
      logger.warn('[notifications] decline could not re-triage: missing ticket payload', { logId: log.Id });
    }

    res.json({ success: true, status: 'Declined', declinedAt: now });
  } catch (err) {
    next(err);
  }
});

/** POST /api/notifications/:id/read — marks a triage RouteLog__c as read. */
router.post('/:id/read', async (req, res, next) => {
  try {
    const conn = await getConnection();
    await conn.sobject('RouteLog__c').update({ Id: req.params.id, Read_Date__c: new Date().toISOString() });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** POST /api/notifications/read-all — marks all unread triage logs as read. */
router.post('/read-all', async (req, res, next) => {
  try {
    const conn = await getConnection();
    const soql = `
      SELECT Id FROM RouteLog__c
      WHERE Skill__c = '${TRIAGE_SKILL}' AND Read_Date__c = null
      LIMIT 200
    `;
    const result = await conn.query(soql);
    const updates = (result.records || []).map((r) => ({ Id: r.Id, Read_Date__c: new Date().toISOString() }));
    if (updates.length > 0) {
      await conn.sobject('RouteLog__c').update(updates);
    }
    res.json({ success: true, updated: updates.length });
  } catch (err) {
    next(err);
  }
});

function toNotification(r) {
  const stored = parseStoredTicket(r.Input_Data__c);
  const ticketType = r.Ticket__r?.Type || stored?.typeName || stored?.ticket?.typeName || null;
  const caseRecordType = r.Ticket__r?.RecordType?.Name || stored?.recordType || stored?.ticket?.recordType || null;
  const ticketOpenedAt = r.Ticket__r?.CreatedDate || stored?.createdDate || stored?.ticket?.createdDate || null;
  const accountLat = r.Account__r?.MALatitude__c ?? stored?.accountLat ?? stored?.ticket?.accountLat ?? null;
  const accountLng = r.Account__r?.MALongitude__c ?? stored?.accountLng ?? stored?.ticket?.accountLng ?? null;

  return {
    id: r.Id,
    name: r.Name,
    createdAt: r.CreatedDate,
    readAt: r.Read_Date__c,
    status: r.Status__c,
    type: r.Type__c,
    skill: r.Skill__c,
    confidence: r.Confidence__c,
    reason: r.Reason__c,
    accountId: r.Account__c,
    accountName: r.Account__r?.Name || null,
    accountLat,
    accountLng,
    googleRouteId: r.Google_Route__c,
    googleRouteName: r.Google_Route__r?.Name || null,
    ticketId: r.Ticket__c,
    caseNumber: r.Ticket__r?.CaseNumber || null,
    ticketSubject: r.Ticket__r?.Subject || null,
    ticketType,
    caseRecordType,
    ticketOpenedAt,
    acceptedBy: r.Accepted_By__c || null,
    acceptedAt: r.Accepted_Date__c || null,
  };
}

function extractBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.replace('Bearer ', '') : null;
}

/** Loads the minimal RouteLog fields needed to gate accept/decline + reconstruct the ticket. */
async function loadTriageLog(conn, id) {
  if (!id) return null;
  const safeId = String(id).replace(/'/g, "\\'");
  const soql = `
    SELECT Id, Status__c, Skill__c, Google_Route__c, Account__c, Ticket__c, Input_Data__c
    FROM RouteLog__c
    WHERE Id = '${safeId}' AND Skill__c = '${TRIAGE_SKILL}'
    LIMIT 1
  `;
  const result = await conn.query(soql);
  return result.records?.[0] || null;
}

/** Pulls the ticket payload that triageTicket originally received out of Input_Data__c. */
function parseStoredTicket(inputData) {
  if (!inputData) return null;
  try {
    const parsed = JSON.parse(inputData);
    return parsed?.ticket || null;
  } catch (err) {
    logger.warn('[notifications] could not parse Input_Data__c', { error: err.message });
    return null;
  }
}

module.exports = router;
