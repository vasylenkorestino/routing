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
const logger = require('../utils/logger');

const TRUCK_CAPACITY_GAL = 1800;

const ANALYZE_STOPS_SYSTEM = `You are an AI route analyst for a UCO collection company. Analyze EXISTING stops only.

Return ONLY valid JSON:
{
  "summary": "2-3 sentence route overview",
  "existingStops": [{ "accountId", "accountName", "action": "keep"|"remove"|"flag"|"overflow", "confidence": 0-100, "reason": "..." }]
}

Use tank fill %, VIP/fixed points, driver notes, and truck capacity (~1800 gal).`;

const ANALYZE_ADDS_SYSTEM = `You are an AI route analyst for a UCO collection company. Recommend NEARBY accounts to ADD to the route.

The nearbyAccounts list is PRE-FILTERED: every account is already due for service on the route date (service-due engine). Do NOT suggest accounts outside this list.

Rules:
- Only recommend from nearbyAccounts. Prefer higher daysOverdue and higher estimatedGallonsAtDate.
- Prefer inRouteShape, then inNeighborShape; avoid large geographic detours from the current stop path.
- Respect remainingCapacityGal — do not suggest adds that would exceed truck capacity (~1800 gal).
- Never recommend recently serviced / not-due accounts (they are already excluded).
- In each reason, cite lastServiceDate, nextDueDate (or effectiveFrequencyDays), and estimated gallons.
- If Agent Memory rules are provided, follow them unless they conflict with hard due/capacity constraints.
- Return fewer high-quality adds rather than many weak ones. Empty suggestedAdds is OK.

Return ONLY valid JSON:
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

/** Estimates gallons committed by stops marked keep/overflow. */
function estimateKeptGallons(existingStops, stopsData) {
  let total = 0;
  for (const rec of existingStops) {
    if (rec.action === 'remove') continue;
    const stop = stopsData.find((s) => s.accountId === rec.accountId);
    const gal = stop?.lastGallons || 0;
    total += Math.max(0, Number(gal) || 0);
  }
  return total;
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
  const routeQuery = `
    SELECT Id, Name, Service_Date__c, DriverName__c, Total_Distance__c, Total_Time__c,
           Service_Location_Start__c, Service_Location_End__c, Shape__c
    FROM Google_Route__c WHERE Id = '${googleRouteId}'
  `;
  const stopsQuery = `
    SELECT Id, AccountId__c, Account_Name__c, Container_Address__c, Priority__c,
           ServiceType__c, ServiceSubType__c, LastGallonsCollected__c, Notes__c,
           Driver_Notes__c, Status__c, Fixed_point__c, Latitude__c, Longitude__c
    FROM Route__c
    WHERE Google_Route_Id__c = '${googleRouteId}' AND AccountId__c != null
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
    historicalInsights = await analyzeRouteCompare({ googleRouteId, routeName: gRoute.Name, limit: 15 });
    const histCount = historicalInsights?.historicalRoutes?.length ?? 0;
    setStep(jobId, 'compare_history', 'done', `${histCount} historical routes`);
    aiJobs.addFinding(jobId, `Compared with ${histCount} completed historical runs`);
  } catch (err) {
    logger.warn('Enhance pipeline: compare_history failed', { error: err.message });
    setStep(jobId, 'compare_history', 'done', 'skipped');
  }

  aiJobs.updateProgress(jobId, { step: 'load_locations', label: 'Reviewing service locations…', percent: 20 });
  publishJobProgress(jobId);

  const accountIds = stops.records.map((s) => s.AccountId__c).filter(Boolean);

  setStep(jobId, 'load_locations', 'running');
  let accounts = [];
  let nearbyAccounts = [];
  let nearbyResultRaw = {};
  let addCandidateStats = null;

  const loadAccounts = async () => {
    if (!accountIds.length) return;
    const ids = accountIds.map((id) => `'${id}'`).join(',');
    const acctQuery = `
      SELECT Id, Name, Last_Service_Date__c, DaysInterval__c, Tank_Size__c,
             Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
             MALatitude__c, MALongitude__c, Ignore_For_Routing__c,
             (SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ORDER BY CreatedDate DESC LIMIT 5)
      FROM Account WHERE Id IN (${ids})
    `;
    const acctResult = await recorder.wrap('Load Accounts', 'SOQL', () => conn.query(acctQuery), { input: acctQuery });
    accounts = acctResult.records;
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

  await Promise.all([loadAccounts(), loadNearby()]);

  const acctMap = {};
  accounts.forEach((a) => { acctMap[a.Id] = a; });

  const stopsData = stops.records.map((s) => {
    const acct = acctMap[s.AccountId__c] || {};
    const services = acct.Services__r?.records || [];
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
      lastServiceDate: acct.Last_Service_Date__c,
      interval: acct.DaysInterval__c,
      priorityTier: acct.Priority_Tier__c,
      routeNotes: acct.Route_Notes__c,
      specialInstructions: acct.Notes__c,
      driverNotes: s.Driver_Notes__c,
      recentServices: services.map((sv) => ({ gallons: sv.Qty_Gallons__c, date: sv.Service_Date__c })),
    };
  });

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
  const client = new Anthropic({ apiKey: config.apiKey });

  setStep(jobId, 'analyze_stops', 'running');
  const stopsResponse = await recorder.wrap(
    'AI Analysis (stops)',
    'AI Call',
    () => client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: ANALYZE_STOPS_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ route: routeHeader, stops: stopsData, historicalInsights }) }],
    }),
    { prompt: ANALYZE_STOPS_SYSTEM, input: { stops: stopsData.length } },
  );

  const stopsText = stopsResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const stopsAnalysis = parseJson(stopsText);
  const existingStops = stopsAnalysis.existingStops || [];
  const summary = stopsAnalysis.summary || '';

  setStep(jobId, 'analyze_stops', 'done');
  const flagged = existingStops.filter((s) => s.action === 'remove' || s.action === 'flag').length;
  aiJobs.addFinding(jobId, `Reviewed ${existingStops.length} stops — ${flagged} flagged for review`);

  // Stage 1: persist stop recommendations immediately so the UI/map can show them
  // while add-candidate analysis continues in the background.
  const addressMap = {};
  for (const s of stops.records) {
    if (s.AccountId__c) addressMap[s.AccountId__c] = s.Container_Address__c || '';
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

  const keptGal = estimateKeptGallons(existingStops, stopsData);
  const remainingCapacityGal = Math.max(0, TRUCK_CAPACITY_GAL - keptGal);

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

  const addsSystem = memoryBlock
    ? `${ANALYZE_ADDS_SYSTEM}\n\n${memoryBlock}`
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
        content: JSON.stringify({
          route: routeHeader,
          stops: stopsData,
          nearbyAccounts,
          remainingCapacityGal,
          historicalInsights,
          addCandidateStats,
        }),
      }],
    }),
    { prompt: ANALYZE_ADDS_SYSTEM, input: { nearby: nearbyAccounts.length, remainingCapacityGal } },
  );

  const addsText = addsResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const addsAnalysis = parseJson(addsText);
  const suggestedAdds = addsAnalysis.suggestedAdds || [];

  setStep(jobId, 'find_adds', 'done', `${suggestedAdds.length} candidates`);
  aiJobs.mergePartialResults(jobId, { suggestedAdds });
  aiJobs.addFinding(jobId, `Found ${suggestedAdds.length} add candidates (${remainingCapacityGal} gal remaining capacity)`);

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

function parseJson(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { runEnhancePipeline, ANALYZE_STOPS_SYSTEM, ANALYZE_ADDS_SYSTEM };
