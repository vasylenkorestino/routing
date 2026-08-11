const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const { getConnection } = require('./salesforce');
const { createRecorder } = require('./stepRecorder');
const aiJobs = require('./aiJobs');
const { publishJobProgress, progress } = require('./aiJobPublisher');
const { analyzeRouteCompare } = require('../modules/routeCompare');
const { saveEnhanceLogs } = require('./saveEnhanceLogs');
const { loadEnhanceAddCandidates } = require('./enhanceAddCandidates');
const { buildMemoryContext } = require('../agent/memory/recall');
const { ACCOUNT_DUE_FIELDS } = require('../modules/serviceDue');
const { withServiceHistory } = require('../modules/serviceHistoryLoader');
const { resolveNextVisit } = require('../modules/routeCadence');
const { selectWithinCapacity } = require('../modules/routeCapacity');
const { loadAccountFeedback, lookupFeedback } = require('./managerFeedback');
const {
  applyMustRemainKeepOverride,
} = require('../modules/routeKeepRules');
const {
  indexAccountsById,
  lookupAccount,
  resolveStopAccountId,
  buildEnhanceStopRow,
  indexStopFactsByAccountId,
  applyServiceHistoryReasonOverride,
  formatManagerReason,
} = require('../modules/enhanceStopFacts');
const logger = require('../utils/logger');

const TRUCK_CAPACITY_GAL = 1800;

const ANALYZE_STOPS_SYSTEM = `You are an AI route analyst for a UCO collection company. Analyze EXISTING stops only.

Use tank fill %, VIP/fixed points, driver notes, mustRemainOnRoute, reasonFacts, manager comments and truck capacity (~1800 gal).

THE NEXT VISIT RULE (most important):
routeContext.nextVisitDate is when this route realistically runs again, measured from its completed run history. There is no trip in between — nobody creates a separate route for one account. So an account whose due date falls on or before nextVisitDate MUST be serviced on this run, even though it is not due on the route date itself.
Each stop carries dueTier, already computed for you:
- "overdue" → KEEP.
- "due_today" → KEEP.
- "due_before_next_visit" → KEEP. Comes due before the truck returns; removing it guarantees it goes overdue.
- "not_due" → REMOVE unless protected below. Its due date lands after nextVisitDate, so the next run catches it in time. Good volume or long history is NOT a reason to keep it.
- "unknown" → FLAG for review.

HARD RULES:
- VIP/No-fail and fixed points = always keep.
- mustRemainOnRoute = true → always keep (new account: <3 UCO services, or CDL delivery >14 days ago with no UCO yet).
- managerKeepSignal = true means a manager already declined removing this stop → keep it.
- managerComments are instructions from the dispatcher on this account. Honor them and reflect the intent in your reason.
- Overdue means daysOverdue / days past nextDueDate from the service-due engine. NEVER treat gpdHistorySpanDays (DaysInterval__c) as overdue or cadence — it is only the GPD history window span.
- FLAG only for soft operational concerns (access, notes), not invented missing history.
- Never claim missing last UCO when hasUcoHistory is true or reasonFacts.lastUcoDate is set.
- lastGallons / reasonFacts.lastUcoGallons of 0 means last pickup volume was zero — NOT missing history.
- NEVER dump camelCase field names (lastServiceDate, ucoServiceCount, nextDueDate, etc.) in reason text.

REASON FORMAT (required, 1–2 short sentences, plain English for managers):
- Overdue: "Last UCO: Jun 8, 2026 (0 gal). Next due ~Jul 6. Keep — overdue."
- Due before the next run: "Last UCO: Jul 31, 2026 (80 gal). Due Aug 14 — before this route's next run (~Aug 25). Keep — comes due before this route returns."
- Not due: "Last UCO: Aug 3, 2026 (60 gal). Next due ~Sep 14. Remove — not due yet."
- No history: "No UCO pickups on record. Flag — verify before committing to route."
Use reasonFacts for dates/gallons. Action verb must match your action (Keep|Remove|Flag).

CRITICAL: Reply with ONLY a single JSON object. No markdown fences, no preamble, no commentary.
{
  "summary": "2-3 sentence route overview",
  "existingStops": [{ "accountId", "accountName", "action": "keep"|"remove"|"flag"|"overflow", "confidence": 0-100, "reason": "..." }]
}`;

const ANALYZE_ADDS_SYSTEM = `You are an AI route analyst for a UCO collection company. Recommend NEARBY accounts to ADD to the route.

The nearbyAccounts list is PRE-FILTERED: every account is due for service on the route date OR must remain (CDL >14d / first 3 UCO). Do NOT suggest accounts outside this list.

Rules:
- Only recommend from nearbyAccounts. Prefer higher daysOverdue and higher estimatedGallonsAtDate; also prefer mustRemainOnRoute new accounts.
- Prefer inRouteShape, then inNeighborShape; avoid large geographic detours from the current stop path.
- Respect remainingCapacityGal — do not suggest adds that would exceed truck capacity (~1800 gal).
- Never invent overdue from gpdHistorySpanDays — overdue is daysOverdue past nextDueDate only.
- NEVER dump camelCase field names in reason text.
- Reason format (plain English): "Last UCO: Jun 8, 2026 (45 gal). Next due ~Jul 6. Add — overdue." or use remainReasonLabel in plain words for new accounts.
- If Agent Memory rules are provided, follow them unless they conflict with hard due/capacity constraints.
- Return fewer high-quality adds rather than many weak ones. Empty suggestedAdds is OK.
- If nearbyAccounts is empty, return {"suggestedAdds":[]}.

CRITICAL: Reply with ONLY a single JSON object. No markdown fences, no preamble, no commentary.
{
  "suggestedAdds": [{ "accountId", "accountName", "action": "add", "confidence": 0-100, "reason": "..." }]
}`;

const STEP_DEFS = [
  { id: 'load_route', label: 'Loading route data' },
  { id: 'compare_history', label: 'Reviewing historical routes' },
  { id: 'load_locations', label: 'Reviewing service locations' },
  { id: 'analyze_stops', label: 'Analyzing current stops' },
  { id: 'save_stop_logs', label: 'Saving stop recommendations' },
  { id: 'find_adds', label: 'Finding add candidates' },
  { id: 'save_logs', label: 'Saving add recommendations' },
];

/** Initializes step checklist on a job. */
function initSteps(jobId) {
  for (const s of STEP_DEFS) {
    aiJobs.upsertStep(jobId, { id: s.id, label: s.label, status: 'pending' });
  }
  publishJobProgress(jobId);
}

function setStep(jobId, id, status, detail) {
  const def = STEP_DEFS.find((s) => s.id === id);
  aiJobs.upsertStep(jobId, { id, label: def?.label || id, status, detail });
  publishJobProgress(jobId);
}

/**
 * Runs the full AI Enhance pipeline with live progress on jobId.
 * @returns {Promise<object>} response payload for UI
 */
async function runEnhancePipeline(googleRouteId, jobId, userName) {
  initSteps(jobId);
  aiJobs.updateProgress(jobId, { step: 'load_route', label: 'Loading route data…', percent: 5 });
  publishJobProgress(jobId);

  const recorder = createRecorder({
    onStep: () => publishJobProgress(jobId),
  });

  const conn = await getConnection();

  setStep(jobId, 'load_route', 'running');
  // Shape__r.Interval__c is the cadence fallback for routes with no completed
  // runs yet; Google_Route__c.Interval__c is unpopulated org-wide.
  const routeQuery = `
    SELECT Id, Name, Service_Date__c, DriverName__c, Total_Distance__c, Total_Time__c,
           Service_Location_Start__c, Service_Location_End__c, Shape__c, Shape__r.Interval__c
    FROM Google_Route__c WHERE Id = '${googleRouteId}'
  `;
  const stopsQuery = `
    SELECT Id, Account__c, AccountId__c, Account_Name__c, Container_Address__c, Priority__c,
           ServiceType__c, ServiceSubType__c, LastGallonsCollected__c, Notes__c,
           Driver_Notes__c, Status__c, Fixed_point__c, Latitude__c, Longitude__c
    FROM Route__c
    WHERE Google_Route_Id__c = '${googleRouteId}'
      AND (Account__c != null OR AccountId__c != null)
    ORDER BY Priority__c ASC
  `;

  const [route, stops] = await Promise.all([
    recorder.wrap('Load Route', 'SOQL', () => conn.query(routeQuery), { input: routeQuery }),
    recorder.wrap('Load Stops', 'SOQL', () => conn.query(stopsQuery), { input: stopsQuery }),
  ]);

  if (!route.records.length) throw new Error('Route not found');
  const gRoute = route.records[0];
  setStep(jobId, 'load_route', 'done', `${stops.records.length} stops`);
  aiJobs.mergePartialResults(jobId, { totalStops: stops.records.length });
  aiJobs.addFinding(jobId, `Loaded route "${gRoute.Name}" with ${stops.records.length} stops`);

  setStep(jobId, 'compare_history', 'running');
  aiJobs.updateProgress(jobId, { step: 'compare_history', label: 'Reviewing historical routes…', percent: 12 });
  publishJobProgress(jobId);
  let historicalInsights = null;
  try {
    historicalInsights = await analyzeRouteCompare({
      googleRouteId,
      routeName: gRoute.Name,
      limit: 15,
      includeRunHistory: true,
    });
    const histCount = historicalInsights?.historicalRoutes?.length ?? 0;
    setStep(jobId, 'compare_history', 'done', `${histCount} historical routes`);
    aiJobs.addFinding(jobId, `Compared with ${histCount} completed historical runs`);
  } catch (err) {
    logger.warn('Enhance pipeline: compare_history failed', { error: err.message });
    setStep(jobId, 'compare_history', 'done', 'skipped');
  }

  aiJobs.updateProgress(jobId, { step: 'load_locations', label: 'Reviewing service locations…', percent: 20 });
  publishJobProgress(jobId);

  const accountIds = [...new Set(
    stops.records.map((s) => resolveStopAccountId(s)).filter(Boolean),
  )];

  setStep(jobId, 'load_locations', 'running');
  let accounts = [];
  let nearbyAccounts = [];
  let nearbyResultRaw = {};
  let addCandidateStats = null;
  let feedbackByAccountId = {};

  const loadAccounts = async () => {
    if (!accountIds.length) return;
    const ids = accountIds.map((id) => `'${id}'`).join(',');
    // Tank_Size__c comes from ACCOUNT_DUE_FIELDS — do not list it again.
    const acctQuery = `
      SELECT Id, Name, Last_Service_Date__c, DaysInterval__c,
             Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
             MALatitude__c, MALongitude__c, Ignore_For_Routing__c,
             ${ACCOUNT_DUE_FIELDS}
      FROM Account WHERE Id IN (${ids})
    `;
    const acctResult = await recorder.wrap('Load Accounts', 'SOQL', () => conn.query(acctQuery), { input: acctQuery });
    accounts = await recorder.wrap(
      'Load Service History',
      'SOQL',
      () => withServiceHistory(conn, acctResult.records),
      { input: { accounts: acctResult.records.length } },
    );
  };

  const loadNearby = async () => {
    try {
      const result = await loadEnhanceAddCandidates(conn, {
        googleRoute: gRoute,
        stops: stops.records,
        recorder,
      });
      nearbyAccounts = result.candidates;
      nearbyResultRaw = result.rawById;
      addCandidateStats = result.stats;
    } catch (err) {
      logger.error('Enhance pipeline: due-aware ADD candidates failed', { error: err.message });
    }
  };

  const loadFeedback = async () => {
    try {
      feedbackByAccountId = await recorder.wrap(
        'Load Manager Feedback',
        'SOQL',
        () => loadAccountFeedback(conn, accountIds),
        { input: { accounts: accountIds.length } },
      );
    } catch (err) {
      logger.warn('Enhance pipeline: manager feedback load failed', { error: err.message });
    }
  };

  await Promise.all([loadAccounts(), loadNearby(), loadFeedback()]);

  const acctMap = indexAccountsById(accounts);

  const serviceDate = String(gRoute.Service_Date__c || '').slice(0, 10)
    || new Date().toISOString().slice(0, 10);

  // When this route realistically runs again — the horizon that decides whether
  // "not due on the route date" still has to be serviced today.
  const runHistory = historicalInsights?._runHistory || [];
  const shapeInterval = gRoute.Shape__r?.Interval__c || null;
  const routeVisit = resolveNextVisit({ serviceDate, runs: runHistory, shapeInterval });

  const remainByAccountId = {};
  const unjoinedAccountIds = [];
  const noHistoryAccountIds = [];
  const stopsData = stops.records.map((s) => {
    const accountId = resolveStopAccountId(s);
    const acct = lookupAccount(acctMap, accountId) || {};
    if (!acct.Id) unjoinedAccountIds.push(accountId || s.Id);
    // An account served on alternate passes waits longer than the route cadence,
    // so the horizon is measured per account where its history supports it.
    const visit = resolveNextVisit({
      serviceDate,
      accountId,
      runs: runHistory,
      shapeInterval,
    });
    const row = buildEnhanceStopRow(s, acct, serviceDate, {
      ...visit,
      feedback: lookupFeedback(feedbackByAccountId, accountId),
    });
    if (acct.Id && !row.hasUcoHistory) noHistoryAccountIds.push(accountId);
    if (accountId && row._remain) {
      remainByAccountId[accountId] = row._remain;
      const key15 = String(accountId).slice(0, 15);
      if (key15) remainByAccountId[key15] = row._remain;
    }
    // Do not send internal remain object to the model.
    const { _remain, ...publicRow } = row;
    return publicRow;
  });
  const stopFactsByAccountId = indexStopFactsByAccountId(stopsData);

  // Surface data-quality gaps: a failed join or empty history is what previously
  // turned into a silent (and wrong) "No UCO pickups on record".
  if (unjoinedAccountIds.length) {
    logger.warn('Enhance: stop accounts failed to join', {
      googleRouteId: gRoute.Id,
      count: unjoinedAccountIds.length,
      accountIds: unjoinedAccountIds,
    });
    aiJobs.addFinding(
      jobId,
      `${unjoinedAccountIds.length} stop(s) had no Account record — history unverified, flagged for review`,
    );
  }
  if (noHistoryAccountIds.length) {
    logger.info('Enhance: stop accounts with no UCO/CDL history', {
      googleRouteId: gRoute.Id,
      count: noHistoryAccountIds.length,
      accountIds: noHistoryAccountIds,
    });
    aiJobs.addFinding(jobId, `${noHistoryAccountIds.length} stop(s) have no UCO service history on file`);
  }

  const dueDetail = addCandidateStats
    ? `${nearbyAccounts.length} due (of ${addCandidateStats.queried}; ${addCandidateStats.declinedExcluded} declined excluded)`
    : `${nearbyAccounts.length} due candidates`;
  setStep(jobId, 'load_locations', 'done', dueDetail);
  aiJobs.mergePartialResults(jobId, { nearbyCount: nearbyAccounts.length, addCandidateStats });
  aiJobs.addFinding(jobId, `Found ${nearbyAccounts.length} due ADD candidates to evaluate`);
  if (addCandidateStats?.declinedExcluded) {
    aiJobs.addFinding(jobId, `Excluded ${addCandidateStats.declinedExcluded} recently declined ADD accounts`);
  }
  aiJobs.updateProgress(jobId, { step: 'analyze_stops', label: 'Analyzing current stops…', percent: 40 });
  publishJobProgress(jobId);

  const routeHeader = { id: gRoute.Id, name: gRoute.Name, date: gRoute.Service_Date__c, driver: gRoute.DriverName__c };
  const routeContext = {
    serviceDate,
    nextVisitDate: routeVisit.nextVisitDate,
    cadenceDays: routeVisit.cadenceDays,
    cadenceSource: routeVisit.cadenceSource,
    historicalAvgStopCount: historicalInsights?.insights?.trends?.avgStopCount ?? null,
    truckCapacityGal: TRUCK_CAPACITY_GAL,
  };
  // _runHistory is cadence input, not model input.
  const { _runHistory, ...publicInsights } = historicalInsights || {};
  const client = new Anthropic({ apiKey: config.apiKey });

  aiJobs.addFinding(
    jobId,
    `This route runs about every ${routeVisit.cadenceDays} days — next run ~${routeVisit.nextVisitDate}`,
  );

  setStep(jobId, 'analyze_stops', 'running');
  const stopsResponse = await recorder.wrap(
    'AI Analysis (stops)',
    'AI Call',
    () => client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: ANALYZE_STOPS_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          route: routeHeader,
          routeContext,
          stops: stopsData,
          historicalInsights: publicInsights,
        }),
      }],
    }),
    { prompt: ANALYZE_STOPS_SYSTEM, input: { stops: stopsData.length, routeContext } },
  );

  const stopsText = stopsResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const stopsAnalysis = parseJson(stopsText);
  const afterRemain = applyMustRemainKeepOverride(
    stopsAnalysis.existingStops || [],
    remainByAccountId,
  );
  const afterHistory = applyServiceHistoryReasonOverride(afterRemain, stopFactsByAccountId);
  // Keeping every stop that comes due before the next run can outgrow the truck;
  // trim by urgency last, so the cut is made on the final set of keeps.
  const capacityResult = selectWithinCapacity(afterHistory, stopFactsByAccountId, {
    capacityGal: TRUCK_CAPACITY_GAL,
  });
  const existingStops = capacityResult.stops;
  const summary = stopsAnalysis.summary || '';

  setStep(jobId, 'analyze_stops', 'done');
  const flagged = existingStops.filter((s) => s.action === 'remove' || s.action === 'flag').length;
  const remainForced = existingStops.filter((s) => s._remainOverride).length;
  const notDueForced = existingStops.filter((s) => s._notDueOverride).length;
  const historyRewrites = existingStops.filter((s) => s._historyReasonOverride).length;
  aiJobs.addFinding(jobId, `Reviewed ${existingStops.length} stops — ${flagged} flagged for review`);
  if (remainForced) {
    aiJobs.addFinding(jobId, `Forced KEEP on ${remainForced} new-account/CDL stops`);
  }
  if (notDueForced) {
    aiJobs.addFinding(jobId, `Downgraded ${notDueForced} not-due stops from keep to remove`);
  }
  if (capacityResult.stats.deferred) {
    aiJobs.addFinding(
      jobId,
      `Deferred ${capacityResult.stats.deferred} due stop(s) to ~${routeVisit.nextVisitDate} — `
      + `truck full at ~${capacityResult.stats.keptGal} of ${TRUCK_CAPACITY_GAL} gal`,
    );
  }
  if (historyRewrites) {
    aiJobs.addFinding(jobId, `Normalized ${historyRewrites} stop reasons from UCO service history`);
  }

  // Stage 1: persist stop recommendations immediately so the UI/map can show them
  // while add-candidate analysis continues in the background.
  const addressMap = {};
  for (const s of stops.records) {
    const aid = resolveStopAccountId(s);
    if (aid) addressMap[aid] = s.Container_Address__c || '';
  }

  setStep(jobId, 'save_stop_logs', 'running');
  aiJobs.updateProgress(jobId, { step: 'save_stop_logs', label: 'Saving stop recommendations…', percent: 55 });
  publishJobProgress(jobId);

  const stopRecs = existingStops.map((r) => ({ ...r, _section: 'existing' }));
  const savedStops = await saveEnhanceLogs(conn, googleRouteId, stopRecs, recorder);
  const existingWithMeta = savedStops.map((rec) => ({
    ...rec,
    address: addressMap[rec.accountId] || '',
  }));

  aiJobs.mergePartialResults(jobId, {
    existingStops: existingWithMeta,
    summary,
    stage: 'stops_ready',
    stopsSaved: true,
  });
  aiJobs.addFinding(jobId, `Stop recommendations ready — reviewing adds next`);
  setStep(jobId, 'save_stop_logs', 'done', `${existingWithMeta.length} stop logs`);
  aiJobs.updateProgress(jobId, { step: 'find_adds', label: 'Finding add candidates…', percent: 65 });
  publishJobProgress(jobId);

  // Projected gallons for the stops that survived the capacity pass.
  const remainingCapacityGal = Math.max(0, TRUCK_CAPACITY_GAL - capacityResult.stats.keptGal);

  setStep(jobId, 'find_adds', 'running');
  let memoryBlock = '';
  try {
    memoryBlock = await buildMemoryContext({
      context: {
        routeId: googleRouteId,
        stops: stopsData,
        serviceLocationId: gRoute.Service_Location_Start__c || null,
      },
    });
  } catch (err) {
    logger.warn('Enhance pipeline: memory recall failed', { error: err.message });
  }

  let addsText = '';
  let suggestedAdds = [];

  if (!nearbyAccounts.length) {
    addsText = '{"suggestedAdds":[]}';
    setStep(jobId, 'find_adds', 'done', '0 candidates (none due)');
    aiJobs.addFinding(jobId, 'No due ADD candidates — skipped add analysis');
  } else {
    const addsSystem = memoryBlock
      ? `${ANALYZE_ADDS_SYSTEM}\n\n${memoryBlock}\n\nFinal reminder: output ONLY valid JSON, nothing else.`
      : ANALYZE_ADDS_SYSTEM;

    const addsResponse = await recorder.wrap(
      'AI Analysis (adds)',
      'AI Call',
      () => client.messages.create({
        model: config.model,
        max_tokens: config.maxTokens,
        system: addsSystem,
        messages: [{
          role: 'user',
          content: `${JSON.stringify({
            route: routeHeader,
            routeContext,
            stops: stopsData,
            nearbyAccounts,
            remainingCapacityGal,
            historicalInsights: publicInsights,
            addCandidateStats,
          })}\n\nRespond with ONLY the JSON object described in the system prompt.`,
        }],
      }),
      { prompt: ANALYZE_ADDS_SYSTEM, input: { nearby: nearbyAccounts.length, remainingCapacityGal } },
    );

    addsText = addsResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      const addsAnalysis = parseJson(addsText);
      suggestedAdds = Array.isArray(addsAnalysis.suggestedAdds) ? addsAnalysis.suggestedAdds : [];
    } catch (err) {
      // Stops already saved — do not fail the whole job on a chatty ADD reply.
      logger.error('Enhance pipeline: ADD analysis JSON parse failed', {
        error: err.message,
        preview: String(addsText).slice(0, 200),
      });
      aiJobs.addFinding(jobId, 'ADD analysis returned non-JSON — skipped add suggestions');
      suggestedAdds = [];
    }

    setStep(jobId, 'find_adds', 'done', `${suggestedAdds.length} candidates`);
    aiJobs.mergePartialResults(jobId, { suggestedAdds });
    aiJobs.addFinding(jobId, `Found ${suggestedAdds.length} add candidates (${remainingCapacityGal} gal remaining capacity)`);
  }

  // Stage 2: persist add recommendations only (stops already saved above).
  setStep(jobId, 'save_logs', 'running', 'Saving add recommendations…');
  aiJobs.updateProgress(jobId, { step: 'save_logs', label: 'Saving add recommendations…', percent: 90 });
  publishJobProgress(jobId);

  for (const a of nearbyAccounts) {
    if (a.accountId && !addressMap[a.accountId]) {
      const raw = nearbyResultRaw[a.accountId];
      addressMap[a.accountId] = raw
        ? [raw.ShippingStreet, raw.ShippingCity, raw.ShippingState].filter(Boolean).join(', ')
        : '';
    }
  }

  const addRecs = suggestedAdds.map((r) => ({ ...r, action: 'add', _section: 'add' }));
  const savedAdds = await saveEnhanceLogs(conn, googleRouteId, addRecs, recorder);
  const additions = savedAdds.map((rec) => ({
    ...rec,
    address: addressMap[rec.accountId] || '',
  }));

  setStep(jobId, 'save_logs', 'done', `${additions.length} add logs`);
  aiJobs.mergePartialResults(jobId, { suggestedAdds: additions, stage: 'complete' });

  const responsePayload = {
    summary,
    existingStops: existingWithMeta,
    suggestedAdds: additions,
    totalStops: stops.records.length,
    nearbyCount: nearbyAccounts.length,
  };

  return { responsePayload, recorder, aiTexts: { stopsText, addsText }, summary };
}

/**
 * Parses model output that should be JSON, tolerating markdown fences and
 * short prose before/after the object (e.g. "I'll analyze… {…}").
 */
function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new SyntaxError('Empty AI response');

  const withoutFences = raw
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(withoutFences);
  } catch {
    // Fall through — extract first balanced object/array.
  }

  const extracted = extractFirstJsonValue(withoutFences);
  if (extracted == null) {
    throw new SyntaxError(`AI response is not valid JSON: ${withoutFences.slice(0, 80)}…`);
  }
  return JSON.parse(extracted);
}

/** Returns the first balanced JSON object/array substring, or null. */
function extractFirstJsonValue(text) {
  const startObj = text.indexOf('{');
  const startArr = text.indexOf('[');
  let start = -1;
  let open = '';
  let close = '';
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj;
    open = '{';
    close = '}';
  } else if (startArr >= 0) {
    start = startArr;
    open = '[';
    close = ']';
  }
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

module.exports = {
  runEnhancePipeline,
  ANALYZE_STOPS_SYSTEM,
  ANALYZE_ADDS_SYSTEM,
  parseJson,
  applyMustRemainKeepOverride,
  applyServiceHistoryReasonOverride,
  formatManagerReason,
};
