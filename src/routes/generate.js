const router = require('express').Router();
const { createOrchestrator } = require('../services/anthropic');
const skillRegistry = require('../skills');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const logger = require('../utils/logger');

/** POST /api/generate-routes — Case 2: generate new routes for a date range. */
router.post('/', async (req, res, next) => {
  const t0 = Date.now();
  const recorder = createRecorder();
  try {
    const { dateRange, message, recordType, serviceLocationId, routeParams } = req.body;

    if (!dateRange?.from) {
      return res.status(400).json({ error: 'dateRange.from is required' });
    }

    logger.info('Generate routes request', { dateRange, recordType });

    const orchestrator = createOrchestrator(skillRegistry.getToolDefinitions(), skillRegistry, recorder);
    const prompt = `Generate optimized routes for the date range from ${dateRange.from} to ${dateRange.to || dateRange.from}. ` +
      `Record type: ${recordType || 'EZG'}. ` +
      (serviceLocationId ? `Service location ID: ${serviceLocationId}. ` : '') +
      (routeParams ? `Route parameters: ${JSON.stringify(routeParams)}. ` : '') +
      `Analyze historical completed routes, find accounts needing service, cluster them geographically, ` +
      `and create Google_Route__c + Route__c records. All records must be marked as AI-generated. ` +
      `Create RouteLog__c records explaining the reasoning for each route and stop. ` +
      (message ? `Additional context from user: ${message}` : '');
    const result = await orchestrator.run(prompt);

    logAction({
      action: 'Generate Routes',
      status: 'Success',
      requestBody: req.body,
      responseBody: result,
      durationMs: Date.now() - t0,
      userInfo: req.driver?.name,
      source: 'POST /generate-routes',
      steps: recorder.steps,
    });

    res.json(result);
  } catch (err) {
    logAction({
      action: 'Generate Routes',
      status: 'Error',
      requestBody: req.body,
      responseBody: err.message,
      durationMs: Date.now() - t0,
      userInfo: req.driver?.name,
      source: 'POST /generate-routes',
      steps: recorder.steps,
    });
    next(err);
  }
});

module.exports = router;
