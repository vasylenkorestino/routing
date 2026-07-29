const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const { getConnection } = require('../services/salesforce');
const { optimizeGoogleRoute } = require('../services/sfRoutingApi');
const { logErrorToSalesforce } = require('../services/errorLogger');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const aiJobs = require('../services/aiJobs');
const { publishJobProgress } = require('../services/aiJobPublisher');
const { runEnhancePipeline, ANALYZE_STOPS_SYSTEM } = require('../services/enhancePipeline');
const { saveEnhanceLogs } = require('../services/saveEnhanceLogs');
const { loadEnhanceAddCandidates } = require('../services/enhanceAddCandidates');
const {
  ACCOUNT_DUE_FIELDS,
  SERVICE_HISTORY_SUBQUERY,
  evaluateAccount,
  daysBetween,
} = require('../modules/serviceDue');
const {
  evaluateMustRemainOnRoute,
  remainReasonLabel,
  applyMustRemainKeepOverride,
} = require('../modules/routeKeepRules');
const { enqueueFeedback } = require('../agent/learning/feedbackObserver');
const logger = require('../utils/logger');

const ANALYZE_SYSTEM = `You are an AI route analyst for a UCO (Used Cooking Oil) collection company. You analyze route stops AND discover new accounts to add.

You will receive a JSON object with:
- route: route header info
- stops: current stops on the route (with account details, service history, tank info)
- nearbyAccounts: PRE-FILTERED due accounts (service-due engine) or must-remain new accounts — not already on this route

YOUR TASKS:
1. Analyze each EXISTING stop — recommend keep/remove/flag
2. Analyze nearbyAccounts — recommend which due accounts should be ADDED

For each item in your output, provide:
- accountId: the Account Id
- accountName: the account name
- action: "keep" | "remove" | "flag" | "add" | "overflow"  (use "overflow" when keeping/adding the stop risks exceeding truck capacity and needs a manager call)
- confidence: 0-100
- reason: 1-2 sentence explanation

Also provide:
- summary: overall route analysis (2-3 sentences)

DECISION FACTORS:
- Tank fill % = (GPD × days_since_last_service) / tank_capacity. ≥80% = must service. <30% = skip.
- VIP/No-fail = always keep
- Fixed points = always keep
- mustRemainOnRoute = true → always keep / strong add (new account <3 UCO, or CDL >14 days with no UCO)
- Overdue = daysOverdue past nextDueDate only. NEVER treat gpdHistorySpanDays (DaysInterval__c) as overdue — it is the GPD history window span.
- nearbyAccounts are already due or must-remain — prefer higher daysOverdue / estimatedGallonsAtDate; cite lastServiceDate and nextDueDate (or remainReasonLabel) in ADD reasons
- Prefer inRouteShape then inNeighborShape; same plaza/street as existing stop strengthens an add
- Open tickets = higher priority to add
- Consider truck capacity (~1800 gal) — don't exceed with additions
- Geographic fit — only suggest adds that are along the route path, not major detours
- Never recommend recently serviced / not-due accounts (already excluded from nearbyAccounts)
- routeNotes / specialInstructions / driverNotes — respect access and scheduling constraints

Return ONLY valid JSON with this structure:
{
  "summary": "...",
  "existingStops": [{ accountId, accountName, action, confidence, reason }],
  "suggestedAdds": [{ accountId, accountName, action: "add", confidence, reason }]
}`;

/** POST /api/enhance-route — analyze route stops with AI */
router.post('/', async (req, res, next) => {
  const t0 = Date.now();
  const recorder = createRecorder();
  try {
    const { googleRouteId } = req.body;
    if (!googleRouteId) return res.status(400).json({ error: 'googleRouteId is required' });

    logger.info('AI Enhance: analyzing route', { googleRouteId });
    const conn = await getConnection();

    const routeQuery = `
      SELECT Id, Name, Service_Date__c, DriverName__c, Total_Distance__c, Total_Time__c,
             Service_Location_Start__c, Service_Location_End__c, Shape__c
      FROM Google_Route__c WHERE Id = '${googleRouteId}'
    `;
    const route = await recorder.wrap('Load Route', 'SOQL', () => conn.query(routeQuery), {
      input: routeQuery,
    });
    if (!route.records.length) return res.status(404).json({ error: 'Route not found' });
    const gRoute = route.records[0];

    const stopsQuery = `
      SELECT Id, AccountId__c, Account_Name__c, Container_Address__c, Priority__c,
             ServiceType__c, ServiceSubType__c, LastGallonsCollected__c, Notes__c,
             Driver_Notes__c, Status__c, Fixed_point__c, Latitude__c, Longitude__c
      FROM Route__c
      WHERE Google_Route_Id__c = '${googleRouteId}' AND AccountId__c != null
      ORDER BY Priority__c ASC
    `;
    const stops = await recorder.wrap('Load Stops', 'SOQL', () => conn.query(stopsQuery), {
      input: stopsQuery,
    });

    const accountIds = stops.records.map((s) => s.AccountId__c).filter(Boolean);
    let accounts = [];
    if (accountIds.length > 0) {
      const ids = accountIds.map((id) => `'${id}'`).join(',');
      const acctQuery = `
        SELECT Id, Name, Last_Service_Date__c, DaysInterval__c,
               Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
               MALatitude__c, MALongitude__c, Ignore_For_Routing__c,
               ${ACCOUNT_DUE_FIELDS},
               ${SERVICE_HISTORY_SUBQUERY}
        FROM Account WHERE Id IN (${ids})
      `;
      const acctResult = await recorder.wrap('Load Accounts', 'SOQL', () => conn.query(acctQuery), {
        input: acctQuery,
      });
      accounts = acctResult.records;
    }

    const acctMap = {};
    accounts.forEach((a) => { acctMap[a.Id] = a; });

    const serviceDate = String(gRoute.Service_Date__c || '').slice(0, 10)
      || new Date().toISOString().slice(0, 10);
    const remainByAccountId = {};

    const stopsData = stops.records.map((s) => {
      const acct = acctMap[s.AccountId__c] || {};
      const services = acct.Services__r?.records || [];
      const svc = evaluateAccount(acct, serviceDate);
      const remain = evaluateMustRemainOnRoute(acct, serviceDate);
      if (s.AccountId__c) remainByAccountId[s.AccountId__c] = remain;
      const daysOverdue = svc.due && svc.nextDueDate
        ? Math.max(0, daysBetween(svc.nextDueDate, serviceDate))
        : 0;
      return {
        stopId: s.Id,
        accountId: s.AccountId__c,
        accountName: s.Account_Name__c,
        priority: s.Priority__c,
        serviceType: s.ServiceType__c,
        lastGallons: s.LastGallonsCollected__c,
        isFixed: s.Fixed_point__c,
        lat: s.Latitude__c,
        lng: s.Longitude__c,
        tankSize: acct.Tank_Size__c,
        secondContainer: acct.Second_Container__c,
        lastServiceDate: svc.lastServiceDate || acct.Last_Service_Date__c,
        nextDueDate: svc.nextDueDate,
        effectiveFrequencyDays: svc.effectiveFrequencyDays,
        daysOverdue,
        dueReason: svc.reason,
        mustRemainOnRoute: remain.mustRemainOnRoute,
        remainReason: remain.remainReason,
        remainReasonLabel: remainReasonLabel(remain.remainReason),
        ucoServiceCount: remain.ucoServiceCount,
        cdlDeliveryDate: remain.cdlDeliveryDate,
        gpdHistorySpanDays: acct.DaysInterval__c,
        priorityTier: acct.Priority_Tier__c,
        routeNotes: acct.Route_Notes__c,
        specialInstructions: acct.Notes__c,
        driverNotes: s.Driver_Notes__c,
        recentServices: services.map((sv) => ({
          gallons: sv.Qty_Gallons__c,
          date: sv.Service_Date__c,
          recordType: sv.RecordType?.Name || null,
        })),
      };
    });

    // Due-aware ADD candidates (shape + neighbors, serviceDue hard filter).
    let nearbyAccounts = [];
    let nearbyResultRaw = {};
    try {
      const addResult = await loadEnhanceAddCandidates(conn, {
        googleRoute: gRoute,
        stops: stops.records,
        recorder,
      });
      nearbyAccounts = addResult.candidates;
      nearbyResultRaw = addResult.rawById;
      logger.info('AI Enhance: due ADD candidates', addResult.stats);
    } catch (err) {
      logger.error('AI Enhance: ADD candidate load failed', { error: err.message });
    }

    const payload = {
      route: { id: gRoute.Id, name: gRoute.Name, date: gRoute.Service_Date__c, driver: gRoute.DriverName__c },
      stops: stopsData,
      nearbyAccounts,
    };

    const client = new Anthropic({ apiKey: config.apiKey });
    const aiResponse = await recorder.wrap(
      'AI Analysis',
      'AI Call',
      () => client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        system: ANALYZE_SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      }),
      { prompt: ANALYZE_SYSTEM, input: payload },
    );

    const aiText = aiResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    recorder.record({
      skill: 'AI Analysis (parsed text)',
      type: 'System',
      status: 'Success',
      output: aiText,
    });
    let analysis;
    try {
      const cleaned = aiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch {
      logger.error('AI Enhance: failed to parse AI response', { text: aiText.substring(0, 500) });
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: aiText.substring(0, 1000) });
    }

    const existingStops = applyMustRemainKeepOverride(
      analysis.existingStops || analysis.stops || [],
      remainByAccountId,
    );
    const suggestedAdds = analysis.suggestedAdds || analysis.suggestedAccounts || [];
    const summary = analysis.summary || '';

    const allRecs = [
      ...existingStops.map((r) => ({ ...r, _section: 'existing' })),
      ...suggestedAdds.map((r) => ({ ...r, action: 'add', _section: 'add' })),
    ];

    let savedRecs = [];
    try {
      savedRecs = await saveEnhanceLogs(conn, googleRouteId, allRecs, recorder);
    } catch (err) {
      logger.error('AI Enhance: failed to save RouteLog__c', { error: err.message });
      logErrorToSalesforce({ errorType: 'AIEnhanceLogError', errorMessage: err.message, source: 'enhance-route', requestBody: JSON.stringify(allRecs).substring(0, 30000) });
      savedRecs = allRecs;
    }

    // Address is no longer sent to the AI (token savings) — re-attach it server-side for the UI.
    const addressMap = {};
    for (const s of stops.records) {
      if (s.AccountId__c) addressMap[s.AccountId__c] = s.Container_Address__c || '';
    }
    for (const a of nearbyAccounts) {
      if (a.accountId && !addressMap[a.accountId]) {
        const raw = nearbyResultRaw[a.accountId];
        addressMap[a.accountId] = raw
          ? [raw.ShippingStreet, raw.ShippingCity, raw.ShippingState].filter(Boolean).join(', ')
          : '';
      }
    }

    const result = savedRecs.map((rec) => ({
      ...rec,
      address: addressMap[rec.accountId] || '',
    }));

    const existing = result.filter((r) => r._section === 'existing');
    const additions = result.filter((r) => r._section === 'add');

    const responsePayload = { summary, existingStops: existing, suggestedAdds: additions, totalStops: stops.records.length, nearbyCount: nearbyAccounts.length };
    logAction({ action: 'AI Enhance', status: 'Success', requestBody: payload, responseBody: responsePayload, aiPrompt: ANALYZE_SYSTEM, aiResponse: aiText, durationMs: Date.now() - t0, userInfo: req.driver?.name, googleRouteId, source: 'POST /enhance-route', steps: recorder.steps });
    res.json(responsePayload);
  } catch (err) {
    logAction({ action: 'AI Enhance', status: 'Error', requestBody: req.body, responseBody: err.message, durationMs: Date.now() - t0, userInfo: req.driver?.name, googleRouteId: req.body?.googleRouteId, source: 'POST /enhance-route', steps: recorder.steps });
    logErrorToSalesforce({ errorType: 'AIEnhanceError', errorMessage: err.message, stackTrace: err.stack, source: 'enhance-route' });
    next(err);
  }
});

/**
 * POST /api/enhance-route/async — start async enhance job; progress via SSE ai-progress.
 */
router.post('/async', (req, res) => {
  const { googleRouteId } = req.body || {};
  if (!googleRouteId) return res.status(400).json({ error: 'googleRouteId is required' });

  const owner = aiJobs.resolveOwner(req);
  const job = aiJobs.create({ type: 'enhance', params: { googleRouteId }, owner });
  res.status(202).json({ jobId: job.id, status: job.status });
  publishJobProgress(job.id);

  const t0 = Date.now();
  const userName = req.driver?.name;

  setImmediate(async () => {
    try {
      const { responsePayload, recorder, aiTexts } = await runEnhancePipeline(googleRouteId, job.id, userName);
      aiJobs.complete(job.id, responsePayload);
      publishJobProgress(job.id, { status: 'complete' });
      logAction({
        action: 'AI Enhance',
        status: 'Success',
        requestBody: { googleRouteId },
        responseBody: responsePayload,
        aiPrompt: ANALYZE_STOPS_SYSTEM,
        aiResponse: aiTexts.stopsText,
        durationMs: Date.now() - t0,
        userInfo: userName,
        googleRouteId,
        source: 'POST /enhance-route/async',
        steps: recorder.steps,
      });
    } catch (err) {
      aiJobs.fail(job.id, err);
      publishJobProgress(job.id, { status: 'error', error: err.message });
      logAction({
        action: 'AI Enhance',
        status: 'Error',
        requestBody: req.body,
        responseBody: err.message,
        durationMs: Date.now() - t0,
        userInfo: userName,
        googleRouteId,
        source: 'POST /enhance-route/async',
      });
      logErrorToSalesforce({ errorType: 'AIEnhanceError', errorMessage: err.message, stackTrace: err.stack, source: 'enhance-route/async' });
      logger.error('[enhance/async] job failed', { jobId: job.id, error: err.message });
    }
  });
});

const TICKET_CANDIDATES_SYSTEM = `You are an AI route analyst for a UCO (Used Cooking Oil) collection company.
You will receive a JSON object with:
- route: route header info (name, date, driver)
- stops: current stops on the route (ordered, with lat/lng, service type, gallons)
- openTickets: open service tickets near the route area (with account name, ticket type, lat/lng, notes, opened date)

TASK: Identify which openTickets are GOOD CANDIDATES to add to this route.

DECISION FACTORS:
- Geographic fit — the ticket should be along or near the route path, not a major detour
- Same plaza/street as an existing stop = strong candidate
- Older tickets = higher priority
- Ticket type compatibility with the route's service types
- Truck capacity (~1800 gal) — don't recommend more than the route can absorb

Return ONLY valid JSON:
{
  "summary": "1-2 sentence overview",
  "candidates": [{ "accountId": "...", "caseId": "...", "accountName": "...", "confidence": 0-100, "reason": "1 short sentence" }]
}
Only include tickets that genuinely fit (typically the top 3-10). Empty array if none fit.`;

/**
 * POST /api/enhance-route/ticket-candidates — async AI job that scores open
 * tickets in the route's area as add-candidates. Returns { jobId }; poll
 * GET /ai-jobs/:id for the result: { summary, candidates: [...] }.
 */
router.post('/ticket-candidates', (req, res) => {
  const { googleRouteId, recordTypeName } = req.body || {};
  if (!googleRouteId) return res.status(400).json({ error: 'googleRouteId is required' });

  const owner = aiJobs.resolveOwner(req);
  const job = aiJobs.create({ type: 'ticket-candidates', params: { googleRouteId }, owner });
  res.status(202).json({ jobId: job.id, status: job.status });
  publishJobProgress(job.id);

  const t0 = Date.now();
  const userName = req.driver?.name;

  setImmediate(async () => {
    const recorder = createRecorder();
    try {
      const conn = await getConnection();

      aiJobs.updateProgress(job.id, { step: 'load', label: 'Loading route…', percent: 10 });
      publishJobProgress(job.id);

      const routeQuery = `
        SELECT Id, Name, Service_Date__c, DriverName__c
        FROM Google_Route__c WHERE Id = '${googleRouteId}'
      `;
      const routeRes = await recorder.wrap('Load Route', 'SOQL', () => conn.query(routeQuery), { input: routeQuery });
      if (!routeRes.records.length) throw new Error('Route not found');
      const gRoute = routeRes.records[0];

      const stopsQuery = `
        SELECT Id, AccountId__c, Account_Name__c, Priority__c, ServiceType__c,
               LastGallonsCollected__c, Latitude__c, Longitude__c
        FROM Route__c
        WHERE Google_Route_Id__c = '${googleRouteId}' AND AccountId__c != null
        ORDER BY Priority__c ASC
      `;
      const stopsRes = await recorder.wrap('Load Stops', 'SOQL', () => conn.query(stopsQuery), { input: stopsQuery });
      const stops = stopsRes.records;
      if (!stops.length) throw new Error('Route has no stops to analyze');

      const lats = stops.map((s) => Number(s.Latitude__c)).filter(Number.isFinite);
      const lngs = stops.map((s) => Number(s.Longitude__c)).filter(Number.isFinite);
      if (!lats.length) throw new Error('Route stops have no coordinates');

      const PAD = 0.15; // ~10 miles bounding box padding
      const minLat = Math.min(...lats) - PAD;
      const maxLat = Math.max(...lats) + PAD;
      const minLng = Math.min(...lngs) - PAD;
      const maxLng = Math.max(...lngs) + PAD;
      const stopAccountIds = stops.map((s) => s.AccountId__c).filter(Boolean);
      const excludeIds = stopAccountIds.map((id) => `'${id}'`).join(',');

      aiJobs.updateProgress(job.id, { step: 'tickets', label: 'Finding open tickets in the route area…', percent: 30 });
      publishJobProgress(job.id);

      const rtFilter = recordTypeName
        ? `AND RecordType.Name = '${String(recordTypeName).replace(/'/g, '')}'`
        : `AND RecordType.Name IN ('LRS', 'EZG', 'LNC', 'ENJ')`;
      const ticketsQuery = `
        SELECT Id, CaseNumber, AccountId, Type, Notes__c, isFuture__c, CreatedDate,
               Account.Name, Account.ShippingStreet, Account.ShippingCity, Account.ShippingState,
               Account.MALatitude__c, Account.MALongitude__c
        FROM Case
        WHERE Status = 'Open'
          AND (Account.Account_Status__c = 'Active' OR Account.Account_Status__c = 'GTC Only' OR Account.Account_Status__c = 'Service-to-Service')
          ${rtFilter}
          AND Type = 'UCO Collection'
          AND isFuture__c = false
          AND Account.MALatitude__c >= ${minLat} AND Account.MALatitude__c <= ${maxLat}
          AND Account.MALongitude__c >= ${minLng} AND Account.MALongitude__c <= ${maxLng}
          ${excludeIds ? `AND AccountId NOT IN (${excludeIds})` : ''}
        ORDER BY CreatedDate ASC
        LIMIT 80
      `;
      const ticketsRes = await recorder.wrap('Find Area Tickets', 'SOQL', () => conn.query(ticketsQuery), { input: ticketsQuery });
      const openTickets = (ticketsRes.records || []).map((c) => ({
        caseId: c.Id,
        accountId: c.AccountId,
        accountName: c.Account?.Name,
        ticketType: c.isFuture__c ? 'Future Services' : c.Type,
        openedAt: c.CreatedDate,
        notes: c.Notes__c,
        lat: c.Account?.MALatitude__c,
        lng: c.Account?.MALongitude__c,
        address: [c.Account?.ShippingStreet, c.Account?.ShippingCity, c.Account?.ShippingState].filter(Boolean).join(', '),
      }));

      if (!openTickets.length) {
        const empty = { summary: 'No open tickets found in the route area.', candidates: [], areaTickets: 0 };
        aiJobs.complete(job.id, empty);
        publishJobProgress(job.id, { status: 'complete' });
        return;
      }

      aiJobs.updateProgress(job.id, { step: 'ai', label: `Scoring ${openTickets.length} tickets with AI…`, percent: 55 });
      publishJobProgress(job.id);

      const payload = {
        route: { id: gRoute.Id, name: gRoute.Name, date: gRoute.Service_Date__c, driver: gRoute.DriverName__c },
        stops: stops.map((s) => ({
          accountId: s.AccountId__c,
          accountName: s.Account_Name__c,
          priority: s.Priority__c,
          serviceType: s.ServiceType__c,
          lastGallons: s.LastGallonsCollected__c,
          lat: s.Latitude__c,
          lng: s.Longitude__c,
        })),
        openTickets,
      };

      const client = new Anthropic({ apiKey: config.apiKey });
      const aiResponse = await recorder.wrap(
        'AI Ticket Scoring',
        'AI Call',
        () => client.messages.create({
          model: config.model,
          max_tokens: config.maxTokens,
          system: TICKET_CANDIDATES_SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify(payload) }],
        }),
        { prompt: TICKET_CANDIDATES_SYSTEM, input: payload },
      );

      const aiText = aiResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let analysis;
      try {
        const cleaned = aiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        analysis = JSON.parse(cleaned);
      } catch {
        throw new Error('AI returned invalid JSON');
      }

      // Only keep candidates that refer to real area tickets.
      const byAccount = new Map(openTickets.map((t) => [t.accountId, t]));
      const candidates = (analysis.candidates || [])
        .filter((c) => c?.accountId && byAccount.has(c.accountId))
        .map((c) => ({
          accountId: c.accountId,
          caseId: c.caseId || byAccount.get(c.accountId).caseId,
          accountName: c.accountName || byAccount.get(c.accountId).accountName,
          confidence: c.confidence ?? 0,
          reason: c.reason || '',
        }));

      const result = { summary: analysis.summary || '', candidates, areaTickets: openTickets.length };
      aiJobs.complete(job.id, result);
      publishJobProgress(job.id, { status: 'complete' });
      logAction({ action: 'AI Ticket Candidates', status: 'Success', requestBody: { googleRouteId }, responseBody: result, aiPrompt: TICKET_CANDIDATES_SYSTEM, aiResponse: aiText, durationMs: Date.now() - t0, userInfo: userName, googleRouteId, source: 'POST /enhance-route/ticket-candidates', steps: recorder.steps });
    } catch (err) {
      aiJobs.fail(job.id, err);
      publishJobProgress(job.id, { status: 'error', error: err.message });
      logAction({ action: 'AI Ticket Candidates', status: 'Error', requestBody: req.body, responseBody: err.message, durationMs: Date.now() - t0, userInfo: userName, googleRouteId, source: 'POST /enhance-route/ticket-candidates', steps: recorder.steps });
      logErrorToSalesforce({ errorType: 'AITicketCandidatesError', errorMessage: err.message, stackTrace: err.stack, source: 'enhance-route/ticket-candidates' });
      logger.error('[ticket-candidates] job failed', { jobId: job.id, error: err.message });
    }
  });
});

/**
 * POST /api/enhance-route/approve — apply manager decisions to RouteLog__c.
 *
 * Outcome semantics (resolved on the client from each log's flag + decision):
 *   add    -> Status Accepted (Salesforce trigger inserts the Route__c stop)
 *   keep   -> Status Accepted (no-op for an existing stop)
 *   remove -> Status Declined (so the trigger never re-adds) + delete the Route__c stop
 *   ignore -> Status Declined (leave the route unchanged)
 *
 * Accepts the new `resolutions: [{ logId, outcome }]` payload, or the legacy
 * `{ logIds, status }` payload (Accepted -> add, Declined -> ignore).
 */
router.post('/approve', async (req, res, next) => {
  try {
    const { logIds, status, resolutions } = req.body;

    let items;
    if (Array.isArray(resolutions) && resolutions.length) {
      items = resolutions
        .filter((r) => r?.logId && r?.outcome)
        .map((r) => ({
          logId: r.logId,
          outcome: r.outcome,
          // Optional manager note (mainly used when declining).
          comment: typeof r.comment === 'string' ? r.comment.trim() : '',
        }));
    } else if (logIds?.length && status) {
      const outcome = status === 'Accepted' ? 'add' : 'ignore';
      items = logIds.map((id) => ({ logId: id, outcome, comment: '' }));
    }

    if (!items?.length) {
      return res.status(400).json({ error: 'resolutions or logIds+status required' });
    }

    const userName = req.driver?.name || 'Unknown';
    const now = new Date().toISOString();
    const conn = await getConnection();

    const statusFor = (o) => (o === 'add' || o === 'keep' ? 'Accepted' : 'Declined');

    // Look up account + route for any removals so we can delete the matching stop.
    const removeIds = items.filter((i) => i.outcome === 'remove').map((i) => i.logId);
    const logsById = {};
    if (removeIds.length) {
      const idList = removeIds.map((id) => `'${id}'`).join(',');
      const q = await conn.query(`SELECT Id, Account__c, Google_Route__c FROM RouteLog__c WHERE Id IN (${idList})`);
      (q.records || []).forEach((r) => { logsById[r.Id] = r; });
    }

    const updates = items.map((i) => ({
      Id: i.logId,
      Status__c: statusFor(i.outcome),
      Accepted_By__c: userName,
      Accepted_Date__c: now,
    }));
    await conn.sobject('RouteLog__c').update(updates);

    for (const i of items) {
      enqueueFeedback({
        type: 'route_log_status',
        logId: i.logId,
        status: statusFor(i.outcome),
        outcome: i.outcome,
        source: 'enhance_approve',
        detail: i.comment || undefined,
      });

      // Persist optional decline/decision notes as RouteLogComment__c (no AI reply)
      // so accountRouteHistory / future generation can recall why managers disagreed.
      if (i.comment) {
        try {
          const created = await conn.sobject('RouteLogComment__c').create({
            Route_Log__c: i.logId,
            Body__c: i.comment.slice(0, 32000),
            Author__c: userName,
            Is_AI__c: false,
          });
          enqueueFeedback({
            type: 'route_log_comment',
            logId: i.logId,
            commentId: created.id,
            source: 'decline_comment',
            detail: i.comment.slice(0, 2000),
          });
        } catch (err) {
          logger.warn('[enhance/approve] decline comment save failed', { logId: i.logId, error: err.message });
        }
      }
    }

    const removed = [];
    for (const id of removeIds) {
      const log = logsById[id];
      if (!log?.Account__c || !log?.Google_Route__c) continue;
      const pts = await conn.query(
        `SELECT Id FROM Route__c WHERE GRoute_Id__c = '${log.Google_Route__c}' AND AccountId__c = '${log.Account__c}'`
      );
      if (pts.records?.length) {
        await conn.sobject('Route__c').destroy(pts.records.map((p) => p.Id));
        removed.push(id);
      }
    }

    const added = items.filter((i) => i.outcome === 'add').map((i) => i.logId);

    // When the route membership changed (a stop was added or removed), re-optimize
    // the affected route(s) synchronously so the client refresh shows the correct
    // stop order. Best-effort: routes without start/end Service Locations can't be
    // optimized (the optimizer throws) — skip those without failing the approve.
    if (added.length || removed.length) {
      const changedLogIds = [...new Set([...added, ...removed])];
      const idList = changedLogIds.map((id) => `'${id}'`).join(',');
      const changed = await conn.query(`SELECT Id, Google_Route__c FROM RouteLog__c WHERE Id IN (${idList})`);
      const routeIds = [...new Set((changed.records || []).map((r) => r.Google_Route__c).filter(Boolean))];
      for (const routeId of routeIds) {
        try {
          await reoptimizeRoute(conn, routeId);
        } catch (err) {
          logger.warn('[enhance/approve] re-optimize skipped', { routeId, error: err.message });
        }
      }
    }

    res.json({ success: true, updated: items.length, added, removed });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/enhance-route/undo — reverse an accept/decline back to Proposed.
 *
 * Body: { logIds: string[], outcomes?: { [logId]: 'add'|'keep'|'remove'|'ignore' } }
 * Client `_outcome` is preferred when present; otherwise outcome is inferred from
 * Status + Reason flag + whether the Account stop still exists on the route.
 */
router.post('/undo', async (req, res, next) => {
  try {
    const logIds = Array.isArray(req.body?.logIds) ? req.body.logIds.filter(Boolean) : [];
    const outcomes = req.body?.outcomes && typeof req.body.outcomes === 'object' ? req.body.outcomes : {};
    if (!logIds.length) return res.status(400).json({ error: 'logIds required' });

    const conn = await getConnection();
    const idList = logIds.map((id) => `'${id}'`).join(',');
    const q = await conn.query(
      `SELECT Id, Status__c, Account__c, Google_Route__c, Reason__c
       FROM RouteLog__c WHERE Id IN (${idList})`
    );
    const logs = q.records || [];
    if (!logs.length) return res.status(404).json({ error: 'No RouteLog__c found' });

    const routeIds = [...new Set(logs.map((l) => l.Google_Route__c).filter(Boolean))];
    const accountIds = [...new Set(logs.map((l) => l.Account__c).filter(Boolean))];

    // Existing stops for these accounts on the affected routes.
    const stopKeys = new Set();
    if (routeIds.length && accountIds.length) {
      const rList = routeIds.map((id) => `'${id}'`).join(',');
      const aList = accountIds.map((id) => `'${id}'`).join(',');
      const stops = await conn.query(
        `SELECT Id, AccountId__c, GRoute_Id__c FROM Route__c
         WHERE GRoute_Id__c IN (${rList}) AND AccountId__c IN (${aList})`
      );
      (stops.records || []).forEach((p) => {
        stopKeys.add(`${p.AccountId__c}_${p.GRoute_Id__c}`);
      });
    }

    const undidAdd = [];
    const undidRemove = [];
    const resetIds = [];

    for (const log of logs) {
      if (log.Status__c === 'Proposed') continue;
      const flag = flagFromReason(log.Reason__c);
      const key = log.Account__c && log.Google_Route__c
        ? `${log.Account__c}_${log.Google_Route__c}`
        : null;
      const stopExists = key ? stopKeys.has(key) : false;
      const outcome = outcomes[log.Id] || inferUndoOutcome(log.Status__c, flag, stopExists);

      if (outcome === 'add' && stopExists && log.Account__c && log.Google_Route__c) {
        const pts = await conn.query(
          `SELECT Id FROM Route__c
           WHERE GRoute_Id__c = '${log.Google_Route__c}' AND AccountId__c = '${log.Account__c}'`
        );
        if (pts.records?.length) {
          await conn.sobject('Route__c').destroy(pts.records.map((p) => p.Id));
          stopKeys.delete(key);
          undidAdd.push(log.Id);
        }
      } else if (outcome === 'remove' && !stopExists && log.Account__c && log.Google_Route__c) {
        const inserted = await insertAiRouteStop(conn, log.Account__c, log.Google_Route__c);
        if (inserted) {
          stopKeys.add(key);
          undidRemove.push(log.Id);
        }
      }

      resetIds.push(log.Id);
    }

    if (resetIds.length) {
      // Clear Accepted_* via fieldsToNull so undo leaves a clean Proposed row.
      const updates = resetIds.map((id) => ({
        Id: id,
        Status__c: 'Proposed',
        fieldsToNull: ['Accepted_By__c', 'Accepted_Date__c'],
      }));
      await conn.sobject('RouteLog__c').update(updates);

      for (const id of resetIds) {
        enqueueFeedback({
          type: 'route_log_status',
          logId: id,
          status: 'Proposed',
          outcome: 'undo',
          source: 'enhance_undo',
        });
      }
    }

    const membershipChanged = undidAdd.length || undidRemove.length;
    if (membershipChanged) {
      const changedRouteIds = [...new Set(
        logs
          .filter((l) => undidAdd.includes(l.Id) || undidRemove.includes(l.Id))
          .map((l) => l.Google_Route__c)
          .filter(Boolean)
      )];
      for (const routeId of changedRouteIds) {
        try {
          await reoptimizeRoute(conn, routeId);
        } catch (err) {
          logger.warn('[enhance/undo] re-optimize skipped', { routeId, error: err.message });
        }
      }
    }

    res.json({
      success: true,
      updated: resetIds.length,
      undidAdd,
      undidRemove,
    });
  } catch (err) {
    next(err);
  }
});

/** Parses [FLAG] prefix from RouteLog Reason__c. */
function flagFromReason(reason) {
  if (!reason) return 'FLAG';
  const m = String(reason).match(/^\[(\w+)\]/);
  if (!m) return 'FLAG';
  const token = m[1].toUpperCase();
  return ['ADD', 'KEEP', 'REMOVE', 'FLAG', 'OVERFLOW'].includes(token) ? token : 'FLAG';
}

/**
 * Infers prior approve outcome when the client did not send `_outcome`.
 * Accepted+ADD+stop → add; Declined+(REMOVE|KEEP)+no stop → remove; else keep/ignore.
 */
function inferUndoOutcome(status, flag, stopExists) {
  if (status === 'Accepted' && flag === 'ADD' && stopExists) return 'add';
  if (status === 'Declined' && (flag === 'REMOVE' || flag === 'KEEP') && !stopExists) return 'remove';
  if (status === 'Accepted') return 'keep';
  return 'ignore';
}

/** Inserts an AI Route__c stop for undo-remove (mirrors RouteLogTriggerHelper fields). */
async function insertAiRouteStop(conn, accountId, googleRouteId) {
  const existing = await conn.query(
    `SELECT Id FROM Route__c
     WHERE GRoute_Id__c = '${googleRouteId}' AND AccountId__c = '${accountId}' LIMIT 1`
  );
  if (existing.records?.length) return false;

  const acctQ = await conn.query(
    `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState,
            MALatitude__c, MALongitude__c, Rotisserie_Collection__c
     FROM Account WHERE Id = '${accountId}' LIMIT 1`
  );
  const routeQ = await conn.query(
    `SELECT Id, Name, Service_Date__c FROM Google_Route__c WHERE Id = '${googleRouteId}' LIMIT 1`
  );
  const acct = acctQ.records?.[0];
  const gRoute = routeQ.records?.[0];
  if (!acct || !gRoute) return false;

  const addr = [
    acct.ShippingStreet || '',
    [acct.ShippingCity, acct.ShippingState].filter(Boolean).join(', '),
  ].join(' ').trim();

  await conn.sobject('Route__c').create({
    Account__c: acct.Id,
    AccountId__c: acct.Id,
    Account_Name__c: acct.Name,
    Container_Address__c: addr,
    Latitude__c: acct.MALatitude__c,
    Longitude__c: acct.MALongitude__c,
    Google_Route_Id__c: gRoute.Id,
    GRoute_Id__c: gRoute.Id,
    Name: gRoute.Name,
    DateOfService__c: gRoute.Service_Date__c,
    Status__c: 'New',
    Notes__c: '',
    Driver_Name__c: '',
    isAI__c: true,
    ServiceType__c: acct.Rotisserie_Collection__c === true ? 'Rotisserie Water' : 'UCO Collection',
  });
  return true;
}

/**
 * Re-optimizes a route in place via the Apex optimize-route endpoint (the same
 * optimizer used elsewhere in the app). Throws if the route has no start/end
 * Service Location, which callers handle as a best-effort skip.
 */
async function reoptimizeRoute(conn, routeId) {
  const header = await conn.query(
    `SELECT Id, Driver__c, Service_Location_Start__c, Service_Location_End__c
     FROM Google_Route__c WHERE Id = '${routeId}'`
  );
  const googleRoute = header.records?.[0];
  if (!googleRoute) return;

  const stops = await conn.query(
    `SELECT Id, AccountId__c, Fixed_point__c FROM Route__c
     WHERE Google_Route_Id__c = '${routeId}' AND AccountId__c != null`
  );
  const routePoints = stops.records || [];
  if (!routePoints.length) return;

  await optimizeGoogleRoute(googleRoute, routePoints);
}

module.exports = router;
