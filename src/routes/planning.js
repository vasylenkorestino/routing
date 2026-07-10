/**
 * AI Route Planning API (NEW, ADDITIVE).
 *
 * Powers the full-screen planning workspace. Produces temporary mock routes in
 * the new Route_Plan_Session__c / Route_Plan_Route__c objects and only converts
 * them into real Google_Route__c / Route__c on commit — by CALLING the existing
 * route_generation skill and Apex optimize-route unchanged. No existing routing
 * logic is modified.
 */

const router = require('express').Router();
const planner = require('../modules/planningPlanner');
const sessions = require('../services/planningSessions');
const planningJobs = require('../services/planningJobs');
const skillRegistry = require('../skills');
const sf = require('../services/salesforce');
const { optimizeGoogleRoute } = require('../services/sfRoutingApi');
const { publish, EVENT_PLANNING_PROGRESS } = require('../services/notificationBus');
const { logAction } = require('../services/actionLogger');
const logger = require('../utils/logger');

/** Derives the record type name from a service location (scopes planning to that RT). */
async function recordTypeForLocation(serviceLocationId) {
  if (!serviceLocationId) return null;
  const id = planner.safeId(serviceLocationId);
  const [row] = await sf.query(
    `SELECT RecordType.Name FROM Service_Location__c WHERE Id = '${id}' LIMIT 1`,
  );
  return row?.RecordType?.Name || null;
}

/** Normalizes/validates the planner params coming from the client. */
function buildParams(body = {}) {
  return {
    dateFrom: body.dateFrom,
    dateTo: body.dateTo || body.dateFrom,
    recordType: body.recordType || null,
    serviceLocationId: body.serviceLocationId || null,
    maxRadiusMiles: body.maxRadiusMiles ?? null,
    maxStops: body.maxStops,
    minStopsPerRoute: body.minStopsPerRoute,
    maxGallons: body.maxGallons,
    maxDurationMin: body.maxDurationMin ?? null,
    serviceTimeMin: body.serviceTimeMin,
  };
}

/**
 * Merges preserved manual routes with freshly-generated ones for a re-plan,
 * de-duplicating ids and grouping by service date so the working set stays valid.
 * Preserved routes keep their manual edits; generated routes fill the rest.
 */
function mergeWorkingRoutes(preserved = [], generated = []) {
  const seen = new Set();
  const out = [];
  for (const r of [...preserved, ...generated]) {
    let id = r.id;
    let n = 1;
    while (seen.has(id)) id = `${r.id}-r${n++}`;
    seen.add(id);
    out.push(id === r.id ? r : { ...r, id });
  }
  return out.sort((a, b) => String(a.serviceDate || '').localeCompare(String(b.serviceDate || '')));
}

/* ── Session CRUD ─────────────────────────────────────────── */

/** POST /api/planning/sessions — create a new planning session. */
router.post('/sessions', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.dateFrom) return res.status(400).json({ error: 'dateFrom is required' });
    const params = buildParams(body);
    // Anchor the record-type scope to the selected service location when provided.
    if (params.serviceLocationId && !params.recordType) {
      params.recordType = await recordTypeForLocation(params.serviceLocationId);
    }
    const session = await sessions.createSession(params, req.driver?.name || req.driver?.email || null);
    res.status(201).json({ session });
  } catch (err) { next(err); }
});

/** GET /api/planning/sessions — list resumable sessions. */
router.get('/sessions', async (req, res, next) => {
  try {
    res.json({ sessions: await sessions.listSessions() });
  } catch (err) { next(err); }
});

/** GET /api/planning/sessions/:id — load a full session (routes + admin notes). */
router.get('/sessions/:id', async (req, res, next) => {
  try {
    const data = await sessions.getSession(req.params.id, { bumpLastOpened: true });
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json(data);
  } catch (err) { next(err); }
});

/** PATCH /api/planning/sessions/:id — autosave mock routes / admin notes (optimistic version). */
router.patch('/sessions/:id', async (req, res, next) => {
  try {
    const { routes, adminNotes, params, editVersion } = req.body || {};
    const result = await sessions.saveSession(req.params.id, { routes, adminNotes, params, editVersion });
    res.json(result);
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT') {
      return res.status(409).json({ error: 'Session was modified elsewhere', code: 'VERSION_CONFLICT', currentVersion: err.currentVersion });
    }
    if (err.code === 'LOCKED') return res.status(409).json({ error: 'Session is not editable', code: 'LOCKED' });
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: 'Session not found' });
    next(err);
  }
});

/** DELETE /api/planning/sessions/:id — archive a session. */
router.delete('/sessions/:id', async (req, res, next) => {
  try {
    await sessions.archiveSession(req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── Planning run (trace + live progress) ─────────────────── */

/**
 * POST /api/planning/sessions/:id/plan
 * Runs the planner asynchronously, streams planning-progress SSE snapshots, then
 * persists the resulting mock routes onto the session. Returns a jobId to poll.
 */
router.post('/sessions/:id/plan', async (req, res, next) => {
  try {
    const sessionId = sessions.safeId(req.params.id);
    const loaded = await sessions.getSession(sessionId);
    if (!loaded) return res.status(404).json({ error: 'Session not found' });

    const params = buildParams({ ...loaded.session.params, ...(req.body || {}) });
    if (!params.dateFrom) params.dateFrom = loaded.session.dateFrom;
    if (!params.dateTo) params.dateTo = loaded.session.dateTo;
    if (params.serviceLocationId && !params.recordType) {
      params.recordType = loaded.session.recordType || await recordTypeForLocation(params.serviceLocationId);
    }

    // Re-plan preservation: committed routes are always kept; manually-edited
    // routes are kept when keepEdited (default true). Their accounts are excluded
    // from discovery so the fresh plan cannot steal those stops.
    const keepEdited = req.body?.keepEdited !== false;
    const committedRoutes = loaded.routes.filter((r) => r.committed);
    const preservedRoutes = keepEdited
      ? loaded.routes.filter((r) => !r.committed && r._edited)
      : [];
    params.excludeAccountIds = [
      ...committedRoutes,
      ...preservedRoutes,
    ].flatMap((r) => r.accountIds || []);

    const job = planningJobs.create(sessionId, params, req.driver?.name || null);
    res.status(202).json({ jobId: job.id, status: job.status });

    const t0 = Date.now();
    const onProgress = (snapshot) => {
      planningJobs.updateProgress(job.id, snapshot);
      publish(EVENT_PLANNING_PROGRESS, { jobId: job.id, sessionId, status: 'running', ...snapshot });
    };

    setImmediate(async () => {
      try {
        const result = await planner.plan(params, onProgress);
        planningJobs.complete(job.id, result);
        // Persist the generated working set onto the session (replaces prior working
        // routes) while keeping preserved manual routes intact.
        const merged = mergeWorkingRoutes(preservedRoutes, result.routes);
        const persistParams = { ...params, excludeAccountIds: undefined };
        await sessions.saveSession(sessionId, { routes: merged, params: persistParams, editVersion: null });
        publish(EVENT_PLANNING_PROGRESS, {
          jobId: job.id, sessionId, status: 'complete', step: 'complete', percent: 100,
          summary: result.summary, counters: result.summary?.counters || {},
        });
        logAction({
          action: 'Plan Routes (Workspace)', status: 'Success', requestBody: params,
          responseBody: result.summary, durationMs: Date.now() - t0, userInfo: req.driver?.name,
          source: 'POST /planning/sessions/:id/plan',
        });
      } catch (err) {
        planningJobs.fail(job.id, err);
        publish(EVENT_PLANNING_PROGRESS, { jobId: job.id, sessionId, status: 'error', error: err.message });
        logger.error('[planning] plan run failed', { jobId: job.id, error: err.message });
        logAction({
          action: 'Plan Routes (Workspace)', status: 'Error', requestBody: params,
          responseBody: err.message, durationMs: Date.now() - t0, userInfo: req.driver?.name,
          source: 'POST /planning/sessions/:id/plan',
        });
      }
    });
  } catch (err) { next(err); }
});

/** GET /api/planning/jobs/:id — current planning run status + trace (SSE fallback). */
router.get('/jobs/:id', (req, res) => {
  const job = planningJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(planningJobs.toView(job));
});

/**
 * POST /api/planning/sessions/:id/regenerate-route
 * Rebuilds a single route from a fixed account pool (its stops + optional tray
 * accounts). Other routes are untouched. Returns the rebuilt mock route.
 * Body: { routeId, serviceDate, recordType, depot, accountIds, index, ...guidance }
 */
router.post('/sessions/:id/regenerate-route', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.depot || !Array.isArray(body.accountIds) || body.accountIds.length === 0) {
      return res.status(400).json({ error: 'depot and accountIds are required' });
    }
    const pool = await planner.fetchAccountsByIds(body.accountIds);
    const route = await planner.regenerateRoute(
      {
        routeId: body.routeId,
        serviceDate: body.serviceDate,
        recordType: body.recordType || null,
        depot: body.depot,
        accountIds: body.accountIds,
        index: body.index || 1,
        maxStops: body.maxStops,
        minStopsPerRoute: body.minStopsPerRoute,
        maxGallons: body.maxGallons,
        maxDurationMin: body.maxDurationMin ?? null,
        serviceTimeMin: body.serviceTimeMin,
      },
      pool,
    );
    if (!route) return res.status(400).json({ error: 'No valid accounts to regenerate' });
    res.json({ route });
  } catch (err) { next(err); }
});

/* ── Commit ───────────────────────────────────────────────── */

/**
 * POST /api/planning/sessions/:id/commit
 * Converts approved mock routes into real Google_Route__c / Route__c via the
 * existing route_generation skill + Apex optimize-route. Idempotent (skips rows
 * already committed) and stale-safe (drops accounts already routed for the date).
 * Body: { routeIds?: string[] }  (omit = commit all non-committed routes)
 */
router.post('/sessions/:id/commit', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const sessionId = sessions.safeId(req.params.id);
    const loaded = await sessions.getSession(sessionId);
    if (!loaded) return res.status(404).json({ error: 'Session not found' });

    const routeIdFilter = Array.isArray(req.body?.routeIds) ? new Set(req.body.routeIds) : null;
    const candidates = loaded.routes.filter((r) =>
      !r.committed &&
      (r.accountIds || []).length > 0 &&
      (!routeIdFilter || routeIdFilter.has(r.id) || routeIdFilter.has(r.sfId)));

    if (candidates.length === 0) {
      return res.status(409).json({ error: 'No uncommitted routes to create' });
    }

    // Stale-safety: drop accounts already on an incomplete Route__c for the date.
    const dates = [...new Set(candidates.map((r) => r.serviceDate).filter(Boolean))];
    const alreadyRouted = new Set();
    if (dates.length > 0) {
      const dateList = dates.join(',');
      const routed = await sf.query(
        `SELECT AccountId__c FROM Route__c WHERE DateOfService__c IN (${dateList}) ` +
        `AND AccountId__c != null AND Status__c != 'Complete'`,
      );
      routed.forEach((r) => alreadyRouted.add(r.AccountId__c));
    }

    const routeDefs = [];
    const defToRoute = [];
    const skipped = [];
    for (const r of candidates) {
      const accountIds = (r.accountIds || []).filter((id) => !alreadyRouted.has(id));
      if (accountIds.length === 0) {
        skipped.push({ id: r.id, routeName: r.routeName, reason: 'All stops already routed for this date' });
        continue;
      }
      routeDefs.push({
        routeName: r.routeName,
        serviceDate: r.serviceDate,
        recordTypeName: r.recordType || loaded.session.recordType,
        serviceLocationId: r.serviceLocationId || loaded.session.serviceLocationId || null,
        serviceLocationStartId: r.serviceLocationId || loaded.session.serviceLocationId || null,
        serviceLocationEndId: r.serviceLocationId || loaded.session.serviceLocationId || null,
        accountIds,
      });
      defToRoute.push(r);
    }

    if (routeDefs.length === 0) {
      return res.status(409).json({ error: 'All selected routes were already routed', skipped });
    }

    const skill = skillRegistry.get('route_generation');
    const created = await skill.execute({ routes: routeDefs });

    // Map created Google routes back to mock routes by name to record commit state.
    const createdByName = new Map((created.googleRoutes || []).map((g) => [g.name, g]));
    const committedMarks = [];
    const committedIds = [];
    for (const r of defToRoute) {
      const g = createdByName.get(r.routeName);
      if (!g) continue;
      committedMarks.push({ sfId: r.sfId, googleRouteId: g.id });
      committedIds.push(g.id);
      // Honor "keep my order": re-pin the manual order for routes the user hand-edited.
      if (r.keepOrder) {
        // eslint-disable-next-line no-await-in-loop
        await preserveManualOrder(g, r).catch((e) => logger.warn('[planning] keep-order failed', { route: r.routeName, error: e.message }));
      }
    }

    await sessions.markRoutesCommitted(sessionId, committedMarks);

    // Flip the session to Committed only when everything (this call) is done and nothing pending remains.
    const remaining = loaded.routes.filter((r) => !r.committed && !committedMarks.some((c) => c.sfId === r.sfId));
    const fullyCommitted = remaining.length === 0 && skipped.length === 0;
    await sessions.finalizeCommit(sessionId, committedIds, { markCommitted: fullyCommitted });

    logAction({
      action: 'Commit Planned Routes', status: 'Success', requestBody: { sessionId, count: routeDefs.length },
      responseBody: { created: created.created, totalStops: created.totalStops }, durationMs: Date.now() - t0,
      userInfo: req.driver?.name, source: 'POST /planning/sessions/:id/commit',
    });

    res.json({
      success: true,
      created: created.created,
      totalStops: created.totalStops,
      googleRoutes: created.googleRoutes,
      skipped,
      sessionCommitted: fullyCommitted,
    });
  } catch (err) {
    logAction({
      action: 'Commit Planned Routes', status: 'Error', requestBody: { sessionId: req.params.id },
      responseBody: err.message, durationMs: Date.now() - t0, userInfo: req.driver?.name,
      source: 'POST /planning/sessions/:id/commit',
    });
    next(err);
  }
});

/**
 * Re-applies the user's manual stop order to a freshly-created route by pinning
 * every stop as a fixed point and re-running the existing Apex optimize-route.
 * With all points fixed, the optimizer preserves order while recomputing geometry.
 */
async function preserveManualOrder(googleRoute, mockRoute) {
  const stops = await sf.query(
    `SELECT Id, AccountId__c, Google_Route_Id__c, GRoute_Id__c ` +
    `FROM Route__c WHERE Google_Route_Id__c = '${sessions.safeId(googleRoute.id)}' AND AccountId__c != null`,
  );
  const byAccount = new Map(stops.map((s) => [s.AccountId__c, s]));
  const routePoints = (mockRoute.accountIds || [])
    .map((accountId, i) => {
      const s = byAccount.get(accountId);
      if (!s) return null;
      return {
        Id: s.Id,
        AccountId__c: accountId,
        Fixed_point__c: true,
        Priority__c: i + 1,
        Google_Route_Id__c: googleRoute.id,
        GRoute_Id__c: googleRoute.id,
      };
    })
    .filter(Boolean);
  if (routePoints.length === 0) return;
  await optimizeGoogleRoute(
    {
      Id: googleRoute.id,
      Driver__c: null,
      Service_Location_Start__c: googleRoute.serviceLocationStartId,
      Service_Location_End__c: googleRoute.serviceLocationEndId,
    },
    routePoints,
  );
}

module.exports = router;
