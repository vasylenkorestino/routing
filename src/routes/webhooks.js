const router = require('express').Router();
const logger = require('../utils/logger');
const { triageTicket } = require('../services/ticketTriage');

/** Restricts inbound webhooks to API_KEY (server-to-server) callers. */
function requireApiKey(req, res, next) {
  if (req.authType !== 'apikey') {
    return res.status(403).json({ error: 'Webhook requires API_KEY auth' });
  }
  next();
}

/**
 * POST /api/webhooks/sf/case-created
 * Inbound webhook from Salesforce CaseTrigger → WebhookQueueable.
 * Body: { object, event, orgId, timestamp, records: [{ id, accountId, ... }] }
 * Acks 202 immediately and runs triage out-of-band so the Apex callout returns fast.
 */
router.post('/sf/case-created', requireApiKey, (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  const accepted = records.length;
  res.status(202).json({ accepted });

  if (accepted === 0) {
    logger.warn('[webhook] sf/case-created received with no records');
    return;
  }

  for (const ticket of records) {
    setImmediate(async () => {
      try {
        await triageTicket(ticket);
      } catch (err) {
        logger.error('[webhook] triage failed', { error: err.message, ticketId: ticket?.id });
      }
    });
  }
});

/**
 * POST /api/webhooks/sf/:object-:event
 * Generic placeholder for future objects (google_route-updated, account-created, ...).
 */
router.post('/sf/:object-:event', requireApiKey, (req, res) => {
  const { object, event } = req.params;
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  logger.info('[webhook] generic event received', { object, event, count: records.length });
  res.status(202).json({ accepted: records.length, dispatched: false });
});

module.exports = router;
