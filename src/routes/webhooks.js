const router = require('express').Router();
const logger = require('../utils/logger');
const sfSync = require('../services/sfSync');

/** Restricts inbound webhooks to API_KEY (server-to-server) callers. */
function requireApiKey(req, res, next) {
  if (req.authType !== 'apikey') {
    return res.status(403).json({ error: 'Webhook requires API_KEY auth' });
  }
  next();
}

const SUPPORTED_OBJECTS = new Set(['case', 'route', 'google_route']);
const SUPPORTED_EVENTS = new Set(['created', 'updated', 'deleted']);

/**
 * POST /api/webhooks/sf/:object-:event
 *
 * Generic inbound webhook endpoint covering every object/event combination
 * sent by the Apex `OutboundWebhookService` (case-created, case-updated,
 * case-deleted, route-*, google_route-*). The handler returns 202 immediately
 * so the Apex callout doesn't sit waiting on Salesforce → AWS work, then runs
 * the actual sync via `sfSync.dispatch` out-of-band.
 *
 * Express splits the path on '-' so we re-stitch when the object key contains
 * underscores (`google_route`).
 */
router.post('/sf/:object-:event', requireApiKey, (req, res) => {
  const { object, event } = req.params;
  const records = Array.isArray(req.body?.records) ? req.body.records : [];

  if (!SUPPORTED_OBJECTS.has(object) || !SUPPORTED_EVENTS.has(event)) {
    logger.warn('[webhook] unsupported event', { object, event, count: records.length });
    return res.status(202).json({ accepted: records.length, dispatched: false });
  }

  res.status(202).json({ accepted: records.length, dispatched: true });

  setImmediate(async () => {
    try {
      await sfSync.dispatch(object, event, records);
    } catch (err) {
      logger.error('[webhook] sfSync.dispatch failed', { object, event, error: err.message });
    }
  });
});

module.exports = router;
