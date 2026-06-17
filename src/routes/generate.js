const router = require('express').Router();
const { createOrchestrator } = require('../services/anthropic');
const skillRegistry = require('../skills');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const { plan } = require('../modules/serviceLocationPlanner');
const generationJobs = require('../services/generationJobs');
const { publish, EVENT_GENERATION_PROGRESS } = require('../services/notificationBus');
const sf = require('../services/salesforce');
const { composeSystemPrompt } = require('../agent/prompts/composer');
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

    const { staticPrompt, dynamicPrompt } = composeSystemPrompt('generate', {});

    const orchestrator = createOrchestrator(
      skillRegistry.getToolDefinitions(),
      skillRegistry,
      recorder,
      { staticPrompt, dynamicPrompt, maxIterations: 20 },
    );
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

/**
 * POST /api/generate-routes/by-location
 * Starts an async deterministic "Generate by Service Location" job and returns its id.
 * Progress streams over SSE (event: generation-progress); results are fetched via GET /jobs/:id.
 */
router.post('/by-location', (req, res) => {
  const { date, recordType, serviceLocationId } = req.body || {};
  if (!date) {
    return res.status(400).json({ error: 'date is required' });
  }

  const params = {
    date,
    recordType: recordType || null,
    serviceLocationId: serviceLocationId || null,
    maxRadiusMiles: req.body?.maxRadiusMiles ?? null,
    maxStops: req.body?.maxStops,
    maxGallons: req.body?.maxGallons,
    maxDurationMin: req.body?.maxDurationMin,
    serviceTimeMin: req.body?.serviceTimeMin,
  };

  const job = generationJobs.create(params, req.driver?.name || req.driver?.email || null);
  res.status(202).json({ jobId: job.id, status: job.status });

  const t0 = Date.now();
  const onProgress = (progress) => {
    generationJobs.updateProgress(job.id, progress);
    publish(EVENT_GENERATION_PROGRESS, { jobId: job.id, status: 'running', ...progress });
  };

  setImmediate(async () => {
    try {
      const result = await plan(params, onProgress);
      generationJobs.complete(job.id, result);
      publish(EVENT_GENERATION_PROGRESS, {
        jobId: job.id,
        status: 'complete',
        step: 'complete',
        percent: 100,
        counters: result.summary?.counters || {},
        summary: result.summary,
      });
      logAction({
        action: 'Generate Routes by Service Location',
        status: 'Success',
        requestBody: params,
        responseBody: result.summary,
        durationMs: Date.now() - t0,
        userInfo: req.driver?.name,
        source: 'POST /generate-routes/by-location',
      });
    } catch (err) {
      generationJobs.fail(job.id, err);
      publish(EVENT_GENERATION_PROGRESS, { jobId: job.id, status: 'error', error: err.message });
      logAction({
        action: 'Generate Routes by Service Location',
        status: 'Error',
        requestBody: params,
        responseBody: err.message,
        durationMs: Date.now() - t0,
        userInfo: req.driver?.name,
        source: 'POST /generate-routes/by-location',
      });
      logger.error('[generate/by-location] job failed', { jobId: job.id, error: err.message });
    }
  });
});

/** GET /api/generate-routes/jobs/:id — current status, progress and (when complete) result. */
router.get('/jobs/:id', (req, res) => {
  const job = generationJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(generationJobs.toView(job));
});

/**
 * POST /api/generate-routes/jobs/:id/commit
 * Creates the selected preview routes in Salesforce (isAI__c=true, isInherit__c=true,
 * Custom_Route__c=false) for the job's service date only. Re-validates that accounts
 * are not already routed that day so committing is idempotent.
 * Body: { routeIds?: string[] } — omit to commit all routes.
 */
router.post('/jobs/:id/commit', async (req, res, next) => {
  try {
    const job = generationJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'complete' || !job.result) {
      return res.status(409).json({ error: 'Job is not complete', status: job.status });
    }

    // Prefer client-supplied route definitions (reflect any combine/split edits
    // made on the review screen); fall back to the stored job result by id.
    let selected;
    if (Array.isArray(req.body?.routes) && req.body.routes.length > 0) {
      selected = req.body.routes;
    } else {
      const allRoutes = job.result.routes || [];
      const selectedIds = Array.isArray(req.body?.routeIds) ? new Set(req.body.routeIds) : null;
      selected = selectedIds ? allRoutes.filter((r) => selectedIds.has(r.id)) : allRoutes;
    }

    if (selected.length === 0) {
      return res.status(400).json({ error: 'No routes selected to create' });
    }

    const serviceDate = job.params.date;

    // Idempotency: drop accounts already routed (incomplete) for the service date.
    const routedRows = await sf.query(
      `SELECT AccountId__c FROM Route__c ` +
      `WHERE DateOfService__c = ${serviceDate} ` +
      `AND AccountId__c != null AND Status__c != 'Complete'`
    );
    const alreadyRouted = new Set(routedRows.map((r) => r.AccountId__c));

    const routeDefs = [];
    const skipped = [];
    for (const r of selected) {
      const accountIds = r.accountIds.filter((id) => !alreadyRouted.has(id));
      if (accountIds.length === 0) {
        skipped.push({ id: r.id, routeName: r.routeName, reason: 'All stops already routed for this date' });
        continue;
      }
      routeDefs.push({
        routeName: r.routeName,
        serviceDate,
        recordTypeName: r.recordType || job.params.recordType,
        serviceLocationId: r.serviceLocationId || null,
        accountIds,
      });
    }

    if (routeDefs.length === 0) {
      return res.status(409).json({ error: 'All selected routes were already committed or routed', skipped });
    }

    const skill = skillRegistry.get('route_generation');
    const created = await skill.execute({ routes: routeDefs });

    const committed = { created: created.created, totalStops: created.totalStops, googleRoutes: created.googleRoutes, skipped };
    generationJobs.markCommitted(job.id, committed);

    res.json({ success: true, ...committed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
