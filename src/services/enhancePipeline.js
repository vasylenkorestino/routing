const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const { getConnection } = require('./salesforce');
const { createRecorder } = require('./stepRecorder');
const { accountRoutingFilterClause } = require('../utils/accountRoutingFilters');
const aiJobs = require('./aiJobs');
const { publishJobProgress, progress } = require('./aiJobPublisher');
const logger = require('../utils/logger');

const TRUCK_CAPACITY_GAL = 1800;

const ANALYZE_STOPS_SYSTEM = `You are an AI route analyst for a UCO collection company. Analyze EXISTING stops only.

Return ONLY valid JSON:
{
  "summary": "2-3 sentence route overview",
  "existingStops": [{ "accountId", "accountName", "action": "keep"|"remove"|"flag"|"overflow", "confidence": 0-100, "reason": "..." }]
}

Use tank fill %, VIP/fixed points, driver notes, and truck capacity (~1800 gal).`;

const ANALYZE_ADDS_SYSTEM = `You are an AI route analyst for a UCO collection company. Recommend NEARBY accounts to ADD.

You receive remainingCapacityGal — do not suggest adds that would exceed it.

Return ONLY valid JSON:
{
  "suggestedAdds": [{ "accountId", "accountName", "action": "add", "confidence": 0-100, "reason": "..." }]
}`;

const STEP_DEFS = [
  { id: 'load_route', label: 'Loading route data' },
  { id: 'load_locations', label: 'Reviewing service locations' },
  { id: 'analyze_stops', label: 'Analyzing current stops' },
  { id: 'find_adds', label: 'Finding add candidates' },
  { id: 'save_logs', label: 'Saving recommendations' },
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
           Service_Location_Start__c, Service_Location_End__c
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
  aiJobs.updateProgress(jobId, { step: 'load_locations', label: 'Reviewing service locations…', percent: 20 });
  publishJobProgress(jobId);

  const accountIds = stops.records.map((s) => s.AccountId__c).filter(Boolean);

  setStep(jobId, 'load_locations', 'running');
  let accounts = [];
  let nearbyAccounts = [];
  const nearbyResultRaw = {};

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
    const lats = stops.records.map((s) => s.Latitude__c).filter(Boolean);
    const lngs = stops.records.map((s) => s.Longitude__c).filter(Boolean);
    if (!lats.length) return;
    const PAD = 0.15;
    const minLat = Math.min(...lats) - PAD;
    const maxLat = Math.max(...lats) + PAD;
    const minLng = Math.min(...lngs) - PAD;
    const maxLng = Math.max(...lngs) + PAD;
    const excludeIds = accountIds.map((id) => `'${id}'`).join(',');
    const nearbyQuery = `
      SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState,
             MALatitude__c, MALongitude__c, Last_Service_Date__c, DaysInterval__c,
             Tank_Size__c, Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
             Ignore_For_Routing__c, Rotisserie_Collection__c,
             (SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ORDER BY CreatedDate DESC LIMIT 3)
      FROM Account
      WHERE MALatitude__c >= ${minLat} AND MALatitude__c <= ${maxLat}
        AND MALongitude__c >= ${minLng} AND MALongitude__c <= ${maxLng}
        AND Id NOT IN (${excludeIds})
        AND ${accountRoutingFilterClause()}
        AND MALatitude__c != null AND MALongitude__c != null
      LIMIT 50
    `;
    try {
      const nearbyResult = await recorder.wrap('Find Nearby Accounts', 'SOQL', () => conn.query(nearbyQuery), { input: nearbyQuery });
      for (const a of nearbyResult.records || []) nearbyResultRaw[a.Id] = a;
      nearbyAccounts = (nearbyResult.records || []).map((a) => ({
        accountId: a.Id,
        accountName: a.Name,
        lat: a.MALatitude__c,
        lng: a.MALongitude__c,
        lastServiceDate: a.Last_Service_Date__c,
        interval: a.DaysInterval__c,
        tankSize: a.Tank_Size__c,
        secondContainer: a.Second_Container__c,
        priorityTier: a.Priority_Tier__c,
        routeNotes: a.Route_Notes__c,
        specialInstructions: a.Notes__c,
        recentServices: (a.Services__r?.records || []).map((sv) => ({ gallons: sv.Qty_Gallons__c, date: sv.Service_Date__c })),
      }));
    } catch (err) {
      logger.error('Enhance pipeline: nearby query failed', { error: err.message });
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

  setStep(jobId, 'load_locations', 'done', `${nearbyAccounts.length} nearby accounts`);
  aiJobs.mergePartialResults(jobId, { nearbyCount: nearbyAccounts.length });
  aiJobs.addFinding(jobId, `Found ${nearbyAccounts.length} nearby accounts to evaluate`);
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
      messages: [{ role: 'user', content: JSON.stringify({ route: routeHeader, stops: stopsData }) }],
    }),
    { prompt: ANALYZE_STOPS_SYSTEM, input: { stops: stopsData.length } },
  );

  const stopsText = stopsResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const stopsAnalysis = parseJson(stopsText);
  const existingStops = stopsAnalysis.existingStops || [];
  const summary = stopsAnalysis.summary || '';

  setStep(jobId, 'analyze_stops', 'done');
  aiJobs.mergePartialResults(jobId, { existingStops, summary });
  const flagged = existingStops.filter((s) => s.action === 'remove' || s.action === 'flag').length;
  aiJobs.addFinding(jobId, `Reviewed ${existingStops.length} stops — ${flagged} flagged for review`);
  aiJobs.updateProgress(jobId, { step: 'find_adds', label: 'Finding add candidates…', percent: 65 });
  publishJobProgress(jobId);

  const keptGal = estimateKeptGallons(existingStops, stopsData);
  const remainingCapacityGal = Math.max(0, TRUCK_CAPACITY_GAL - keptGal);

  setStep(jobId, 'find_adds', 'running');
  const addsResponse = await recorder.wrap(
    'AI Analysis (adds)',
    'AI Call',
    () => client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: ANALYZE_ADDS_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          route: routeHeader,
          stops: stopsData,
          nearbyAccounts,
          remainingCapacityGal,
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
  aiJobs.updateProgress(jobId, { step: 'save_logs', label: 'Saving recommendations…', percent: 85 });
  publishJobProgress(jobId);

  setStep(jobId, 'save_logs', 'running');
  const allRecs = [
    ...existingStops.map((r) => ({ ...r, _section: 'existing' })),
    ...suggestedAdds.map((r) => ({ ...r, action: 'add', _section: 'add' })),
  ];

  const logsToCreate = allRecs.map((rec) => ({
    Google_Route__c: googleRouteId,
    Account__c: rec.accountId || null,
    Type__c: rec.action === 'add' ? 'Account Recommended' : (rec.action === 'keep' ? 'Account Added' : 'Account Recommended'),
    Reason__c: `[${(rec.action || '').toUpperCase()}] ${rec.accountName || ''}: ${rec.reason || ''}`,
    Confidence__c: (rec.confidence || 0) / 100,
    Status__c: 'Proposed',
    Skill__c: 'AI Enhance',
  }));

  let createdLogs = [];
  if (logsToCreate.length > 0) {
    createdLogs = await recorder.wrap(
      'Create RouteLogs',
      'Skill',
      () => conn.sobject('RouteLog__c').create(logsToCreate),
      { input: { count: logsToCreate.length } },
    );
  }

  const logIds = Array.isArray(createdLogs) ? createdLogs.map((r) => r.id || r.Id).filter(Boolean) : [];
  let savedLogs = [];
  if (logIds.length > 0) {
    const ids = logIds.map((id) => `'${id}'`).join(',');
    const logResult = await conn.query(`SELECT Id, Name, Account__c, Type__c, Reason__c, Confidence__c, Status__c FROM RouteLog__c WHERE Id IN (${ids})`);
    savedLogs = logResult.records;
  }

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

  const result = allRecs.map((rec, i) => ({
    ...rec,
    address: addressMap[rec.accountId] || '',
    logId: savedLogs[i]?.Id || logIds[i] || null,
    logName: savedLogs[i]?.Name || null,
  }));

  const existing = result.filter((r) => r._section === 'existing');
  const additions = result.filter((r) => r._section === 'add');

  setStep(jobId, 'save_logs', 'done');
  const responsePayload = {
    summary,
    existingStops: existing,
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
