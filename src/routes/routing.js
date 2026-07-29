const { Router } = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { requireDriver } = require('../middleware/auth');
const { getConnection: getSalesforceConnection } = require('../services/salesforce');
const { apexPost } = require('../services/sfRoutingApi');
const { logErrorToSalesforce } = require('../services/errorLogger');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const anthropicConfig = require('../config/anthropic');
const { enqueueFeedback } = require('../agent/learning/feedbackObserver');
const logger = require('../utils/logger');
const accountSelector = require('../modules/accountSelector');
const routeOptimizer = require('../modules/routeOptimizer');
const { fetchCompletedRoutesByName } = require('../modules/routeCompare');

const router = Router();
router.use(requireDriver);

/** Helper: call the Apex REST controller. */
async function apexGet(conn, path, params = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ''));
  const qs = new URLSearchParams(clean).toString();
  const url = `/services/apexrest/routing/${path}${qs ? '?' + qs : ''}`;
  logger.info(`[apexGet] ${url}`);
  const res = await conn.request({ method: 'GET', url });
  logger.info(`[apexGet] response type: ${typeof res}, length: ${typeof res === 'string' ? res.length : JSON.stringify(res).substring(0, 200)}`);
  return typeof res === 'string' ? JSON.parse(res) : res;
}

/** Helper: call the Apex REST controller (POST). */
async function apexPostRoute(path, body) {
  return apexPost(path, body);
}

async function apexDelete(conn, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `/services/apexrest/routing/${path}${qs ? '?' + qs : ''}`;
  const res = await conn.request({ method: 'DELETE', url });
  return typeof res === 'string' ? JSON.parse(res) : res;
}

/** Wraps an async handler — logs errors to SF and forwards to Express error handler. */
function wrap(fn) {
  return (req, res, next) => fn(req, res, next).catch((err) => {
    logger.error(`[routing] ${req.method} ${req.path} error:`, { error: err.message, stack: err.stack?.split('\n').slice(0, 3).join(' | ') });
    logErrorToSalesforce({
      errorType: err.name || 'ServerError',
      errorMessage: err.message,
      stackTrace: err.stack,
      source: `routing ${req.method} ${req.path}`,
      requestBody: req.body ? JSON.stringify(req.body).substring(0, 30000) : JSON.stringify(req.query).substring(0, 30000),
      userInfo: req.driver?.Name || 'unknown',
    });
    next(err);
  });
}

router.get('/sf-instance-url', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json({ instanceUrl: conn.instanceUrl });
}));

router.get('/data', wrap(async (req, res) => {
  logger.info('[/api/routing/data] query params:', req.query);
  const conn = await getSalesforceConnection();
  const data = await apexGet(conn, 'routing-data', req.query);
  logger.info(`[/api/routing/data] result keys: ${typeof data === 'object' ? Object.keys(data) : typeof data}`);
  res.json(data);
}));

router.get('/routes', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'routes', req.query));
}));

router.get('/drivers', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'drivers'));
}));

router.get('/service-locations', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'service-locations', req.query));
}));

router.get('/route-by-driver', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'route-by-driver', req.query));
}));

router.get('/shapes', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'shapes', req.query));
}));

router.get('/custom-routes', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'custom-routes', req.query));
}));

router.get('/google-route-templates', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'google-route-templates', req.query));
}));

router.get('/last-services/:accountId', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'last-services', { accountId: req.params.accountId }));
}));

router.get('/tank-sensor-data/:accountId', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'tank-sensor-data', { accountId: req.params.accountId }));
}));

router.get('/haztrack-data', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'haztrack-data'));
}));

router.get('/search-accounts', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'search-accounts', req.query));
}));

router.get('/waypoints', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'waypoints', req.query));
}));

router.get('/map-data', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'map-data', req.query));
}));

/** Clamps a numeric query param to a range; returns undefined when absent/invalid. */
function clampNumber(value, min, max) {
  const n = Number(value);
  if (value == null || value === '' || Number.isNaN(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

router.get('/tickets', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const params = {
    ...req.query,
    minLat: clampNumber(req.query.minLat, -90, 90),
    maxLat: clampNumber(req.query.maxLat, -90, 90),
    minLng: clampNumber(req.query.minLng, -180, 180),
    maxLng: clampNumber(req.query.maxLng, -180, 180),
    limit: clampNumber(req.query.limit, 1, 1000),
  };
  res.json(await apexGet(conn, 'tickets', params));
}));

router.get('/shape-accounts', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'shape-accounts', req.query));
}));

router.get('/ai-pending', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexGet(conn, 'ai-pending', req.query));
}));

router.get('/route-logs/:googleRouteId', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const id = req.params.googleRouteId;
  const result = await conn.query(
    `SELECT Id, Name, Account__c, Account__r.Name, Account__r.MALatitude__c, Account__r.MALongitude__c, Type__c, Reason__c, Confidence__c, Status__c, Skill__c, Accepted_By__c, Accepted_Date__c, CreatedDate,
            (SELECT Id FROM Comments__r)
     FROM RouteLog__c WHERE Google_Route__c = '${id}' ORDER BY CreatedDate DESC LIMIT 100`
  );
  const logs = (result.records || []).map((r) => ({
    ...r,
    CommentCount__c: r.Comments__r?.totalSize ?? 0,
    Comments__r: undefined,
  }));
  res.json(logs);
}));

/**
 * GET /routing/compare-routes — completed routes available for comparison.
 * Uses normalized base route name (through "Route") with LIKE filter.
 */
router.get('/compare-routes', wrap(async (req, res) => {
  const { routeName, search, date, excludeId } = req.query;
  const records = await fetchCompletedRoutesByName({
    routeName,
    search,
    date,
    excludeId,
    limit: 50,
  });
  res.json(records);
}));

router.get('/error-logs', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const limit = parseInt(req.query.limit, 10) || 50;
  const result = await conn.query(
    `SELECT Id, Name, Error_Type__c, Error_Message__c, Stack_Trace__c, Source__c, Request_Body__c, User_Info__c, Severity__c, Google_Route__c, CreatedDate FROM Routing_Error_Log__c ORDER BY CreatedDate DESC LIMIT ${limit}`
  );
  res.json(result.records || []);
}));

router.get('/action-logs', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const limit = parseInt(req.query.limit, 10) || 50;
  const result = await conn.query(
    `SELECT Id, Name, Action__c, Status__c, Request_Body__c, Response_Body__c, AI_Prompt__c, AI_Response__c, Duration_Ms__c, User_Info__c, Source__c, Google_Route__c, CreatedDate,
            (SELECT Id, Name, Step_Number__c, Skill__c, Type__c, Status__c, Prompt__c, Input__c, Output__c, Duration_Ms__c, Error_Message__c
             FROM Routing_Action_Steps__r
             ORDER BY Step_Number__c ASC)
     FROM Routing_Action_Log__c ORDER BY CreatedDate DESC LIMIT ${limit}`
  );
  res.json(result.records || []);
}));

router.post('/update-route', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const t0 = Date.now();
  const recorder = createRecorder();
  const result = await recorder.wrap(
    'Save Route (Apex)',
    'Skill',
    () => apexPostRoute('update-route', req.body),
    { input: req.body },
  );
  logAction({ action: 'Save', status: 'Success', requestBody: req.body, responseBody: result, durationMs: Date.now() - t0, userInfo: req.driver?.name, googleRouteId: req.body.googleRoute?.Id, source: 'POST /routing/update-route', steps: recorder.steps });
  res.json(result);
}));

router.post('/optimize-route', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const t0 = Date.now();
  const recorder = createRecorder();
  const result = await recorder.wrap(
    'Optimize Route (Apex)',
    'Skill',
    () => apexPostRoute('optimize-route', req.body),
    { input: req.body },
  );
  logAction({ action: 'Optimize', status: 'Success', requestBody: req.body, responseBody: result, durationMs: Date.now() - t0, userInfo: req.driver?.name, googleRouteId: req.body.googleRoute?.Id, source: 'POST /routing/optimize-route', steps: recorder.steps });
  res.json(result);
}));

router.post('/split-route', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('split-route', req.body));
}));

router.post('/combine-routes', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('combine-routes', req.body));
}));

router.post('/complete-route', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('complete-route', req.body));
}));

router.post('/update-point', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('update-point', req.body));
}));

router.post('/create-routes', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('create-routes', req.body));
}));

router.post('/generate-route-by-shape', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('generate-route-by-shape', req.body));
}));

router.post('/add-point', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('add-point', req.body));
}));

router.post('/update-shape', wrap(async (req, res) => {
  res.json(await apexPostRoute('update-shape', req.body));
}));

router.post('/ai-approve', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('ai-approve', req.body));
}));

router.post('/ai-decline', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexPostRoute('ai-decline', req.body));
}));

router.delete('/delete-route/:id', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexDelete(conn, 'delete-route', { routeId: req.params.id }));
}));

router.delete('/delete-point/:id', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  res.json(await apexDelete(conn, 'delete-point', { pointId: req.params.id }));
}));

/** GET comments for a RouteLog__c entry. */
router.get('/route-log-comments/:routeLogId', wrap(async (req, res) => {
  const conn = await getSalesforceConnection();
  const result = await conn.query(
    `SELECT Id, Name, Body__c, Author__c, Is_AI__c, Parent_Comment__c, CreatedDate
     FROM RouteLogComment__c
     WHERE Route_Log__c = '${req.params.routeLogId}'
     ORDER BY CreatedDate ASC`
  );
  res.json(result.records || []);
}));

/** POST a human comment on a RouteLog__c and trigger an AI reply. */
router.post('/route-log-comments', wrap(async (req, res) => {
  const { routeLogId, body } = req.body;
  if (!routeLogId || !body) return res.status(400).json({ error: 'routeLogId and body are required' });

  const conn = await getSalesforceConnection();
  const authorName = req.driver?.name || 'Unknown User';

  const humanComment = await conn.sobject('RouteLogComment__c').create({
    Route_Log__c: routeLogId,
    Body__c: body,
    Author__c: authorName,
    Is_AI__c: false,
  });

  enqueueFeedback({
    type: 'route_log_comment',
    logId: routeLogId,
    commentId: humanComment.id,
    source: 'manager_comment',
    detail: body,
  });

  let aiReply = null;
  try {
    const logResult = await conn.query(
      `SELECT Id, Account__c, Reason__c, Confidence__c, Status__c, Type__c, Skill__c
       FROM RouteLog__c WHERE Id = '${routeLogId}' LIMIT 1`
    );
    const routeLog = logResult.records?.[0];

    const threadResult = await conn.query(
      `SELECT Id, Body__c, Author__c, Is_AI__c, CreatedDate
       FROM RouteLogComment__c
       WHERE Route_Log__c = '${routeLogId}'
       ORDER BY CreatedDate ASC`
    );
    const thread = threadResult.records || [];

    const conversationHistory = thread.map((c) =>
      `[${c.Is_AI__c ? 'AI Agent' : c.Author__c}]: ${c.Body__c}`
    ).join('\n');

    const client = new Anthropic({ apiKey: anthropicConfig.apiKey });
    const aiResponse = await client.messages.create({
      model: anthropicConfig.model,
      max_tokens: 1024,
      system: `You are an AI routing assistant replying to a comment about a route log entry. Be concise and helpful.
Context — Route Log: ${JSON.stringify(routeLog || {})}`,
      messages: [{ role: 'user', content: `Conversation so far:\n${conversationHistory}\n\nRespond to the latest comment.` }],
    });

    const aiText = aiResponse.content?.[0]?.text || 'No response generated.';

    const aiRecord = await conn.sobject('RouteLogComment__c').create({
      Route_Log__c: routeLogId,
      Body__c: aiText,
      Author__c: 'AI Agent',
      Is_AI__c: true,
      Parent_Comment__c: humanComment.id,
    });

    aiReply = { Id: aiRecord.id, Body__c: aiText, Author__c: 'AI Agent', Is_AI__c: true, Parent_Comment__c: humanComment.id };
  } catch (aiErr) {
    logger.error('[route-log-comments] AI reply failed:', { error: aiErr.message });
  }

  res.json({
    humanComment: { Id: humanComment.id, Body__c: body, Author__c: authorName, Is_AI__c: false },
    aiReply,
  });
}));

/**
 * POST /api/routing/smart-optimize — chains Module 1 (account selection) + Module 2 (TSP).
 * Body: { googleRouteId, recordType?, serviceDate?, skipAI?, strategy? }
 * strategy: 'haversine' | 'osrm' | 'google' | 'combined' (default: 'haversine')
 */
router.post('/smart-optimize', wrap(async (req, res) => {
  const { googleRouteId, recordType, serviceDate, skipAI, strategy } = req.body;
  if (!googleRouteId) return res.status(400).json({ error: 'googleRouteId is required' });

  logger.info('[smart-optimize] starting', { googleRouteId, strategy });
  const t0 = Date.now();
  const recorder = createRecorder();

  const optimizerOpts = buildOptimizerOpts(strategy);

  const selection = await recorder.wrap(
    'Account Selection',
    'Skill',
    () => accountSelector.selectAccounts({ googleRouteId, recordType, serviceDate, skipAI }),
    { input: { googleRouteId, recordType, serviceDate, skipAI } },
  );
  const optimization = await recorder.wrap(
    'Route Optimization (TSP)',
    'Skill',
    () => routeOptimizer.optimizeExistingRoute(googleRouteId, optimizerOpts),
    { input: { googleRouteId, ...optimizerOpts } },
  );

  const responsePayload = {
    selection: {
      summary: selection.summary,
      accountsToKeep: selection.accountsToKeep?.length || 0,
      accountsToAdd: selection.accountsToAdd?.length || 0,
      accountsToRemove: selection.accountsToRemove?.length || 0,
      accountsToFlag: selection.accountsToFlag?.length || 0,
      details: selection._raw,
    },
    optimization: {
      stopCount: optimization.stopCount,
      totalDistance: optimization.totalDistance,
      originalDistance: optimization.originalDistance,
      improvement: optimization.improvement,
      ...(optimization.traffic && { traffic: optimization.traffic }),
    },
  };

  logAction({ action: 'Smart Optimize', status: 'Success', requestBody: req.body, responseBody: responsePayload, durationMs: Date.now() - t0, userInfo: req.driver?.name, googleRouteId, source: 'POST /routing/smart-optimize', steps: recorder.steps });
  res.json(responsePayload);
}));

/**
 * POST /api/routing/local-optimize — run only the local TSP solver on existing stops.
 * Body: { googleRouteId, strategy? }
 */
router.post('/local-optimize', wrap(async (req, res) => {
  const { googleRouteId, strategy } = req.body;
  if (!googleRouteId) return res.status(400).json({ error: 'googleRouteId is required' });

  const t0 = Date.now();
  const recorder = createRecorder();
  const opts = buildOptimizerOpts(strategy);
  const result = await recorder.wrap(
    'Local Optimize (TSP)',
    'Skill',
    () => routeOptimizer.optimizeExistingRoute(googleRouteId, opts),
    { input: { googleRouteId, ...opts } },
  );
  logAction({ action: 'Local Optimize', status: 'Success', requestBody: req.body, responseBody: result, durationMs: Date.now() - t0, userInfo: req.driver?.name, googleRouteId, source: 'POST /routing/local-optimize', steps: recorder.steps });
  res.json(result);
}));

/** Build strategy options from env vars and requested strategy. */
function buildOptimizerOpts(strategy) {
  return {
    strategy: strategy || process.env.TSP_STRATEGY || 'haversine',
    osrmUrl: process.env.OSRM_URL || null,
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
  };
}

module.exports = router;
