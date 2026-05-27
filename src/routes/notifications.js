const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { getConnection } = require('../services/salesforce');
const { subscribe } = require('../services/notificationBus');
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
             Confidence__c, Reason__c, Account__c, Account__r.Name,
             Google_Route__c, Google_Route__r.Name, Ticket__c, Ticket__r.CaseNumber, Ticket__r.Subject
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
    googleRouteId: r.Google_Route__c,
    googleRouteName: r.Google_Route__r?.Name || null,
    ticketId: r.Ticket__c,
    caseNumber: r.Ticket__r?.CaseNumber || null,
    ticketSubject: r.Ticket__r?.Subject || null,
  };
}

function extractBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.replace('Bearer ', '') : null;
}

module.exports = router;
