const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const { getConnection } = require('../services/salesforce');
const { logErrorToSalesforce } = require('../services/errorLogger');
const { logAction } = require('../services/actionLogger');
const { createRecorder } = require('../services/stepRecorder');
const logger = require('../utils/logger');

const ANALYZE_SYSTEM = `You are an AI route analyst for a UCO (Used Cooking Oil) collection company. You analyze route stops AND discover new accounts to add.

You will receive a JSON object with:
- route: route header info
- stops: current stops on the route (with account details, service history, tank info)
- nearbyAccounts: accounts NOT currently on this route but geographically nearby, with their service data

YOUR TASKS:
1. Analyze each EXISTING stop — recommend keep/remove/flag
2. Analyze NEARBY accounts — recommend which ones should be ADDED to this route

For each item in your output, provide:
- accountId: the Account Id
- accountName: the account name
- action: "keep" | "remove" | "flag" | "add"
- confidence: 0-100
- reason: 1-2 sentence explanation

Also provide:
- summary: overall route analysis (2-3 sentences)

DECISION FACTORS:
- Tank fill % = (GPD × days_since_last_service) / tank_capacity. ≥80% = must service. <30% = skip.
- VIP/No-fail = always keep
- Fixed points = always keep
- Overdue accounts (days since service > interval) nearby = strong add candidates
- Same plaza or street as existing stop = add if even moderately full
- Open tickets = higher priority to add
- Consider truck capacity (~1800 gal) — don't exceed with additions
- Geographic fit — only suggest adds that are along the route path, not major detours
- routeNotes: routing-specific comments about the account — may contain scheduling or access info
- specialInstructions: account-level instructions (e.g. "call before arrival", "skip if raining") — respect these constraints
- driverNotes: driver observations about this stop — may flag issues like "closed", "inaccessible", etc.

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
             Service_Location_Start__c, Service_Location_End__c
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
        SELECT Id, Name, Last_Service_Date__c, DaysInterval__c, Tank_Size__c,
               Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
               MALatitude__c, MALongitude__c, Ignore_For_Routing__c,
               (SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ORDER BY CreatedDate DESC LIMIT 5)
        FROM Account WHERE Id IN (${ids})
      `;
      const acctResult = await recorder.wrap('Load Accounts', 'SOQL', () => conn.query(acctQuery), {
        input: acctQuery,
      });
      accounts = acctResult.records;
    }

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
        recentServices: services.map((sv) => ({
          gallons: sv.Qty_Gallons__c,
          date: sv.Service_Date__c,
        })),
      };
    });

    // Find nearby accounts not already on this route
    let nearbyAccounts = [];
    const nearbyResultRaw = {}; // accountId -> raw SF record (kept server-side, not sent to AI)
    const lats = stopsData.map((s) => s.lat).filter(Boolean);
    const lngs = stopsData.map((s) => s.lng).filter(Boolean);
    if (lats.length > 0 && lngs.length > 0) {
      const PAD = 0.15; // ~10 miles bounding box padding
      const minLat = Math.min(...lats) - PAD;
      const maxLat = Math.max(...lats) + PAD;
      const minLng = Math.min(...lngs) - PAD;
      const maxLng = Math.max(...lngs) + PAD;
      const excludeIds = accountIds.map((id) => `'${id}'`).join(',');

      try {
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
            AND Ignore_For_Routing__c = false
            AND Account_Status__c = 'Active'
            AND MALatitude__c != null AND MALongitude__c != null
          LIMIT 50
        `;
        const nearbyResult = await recorder.wrap('Find Nearby Accounts', 'SOQL', () => conn.query(nearbyQuery), {
          input: nearbyQuery,
        });
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
        logger.info(`AI Enhance: found ${nearbyAccounts.length} nearby accounts`);
      } catch (err) {
        logger.error('AI Enhance: nearby accounts query failed', { error: err.message });
        // recorder.wrap already captured the error step
      }
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

    const existingStops = analysis.existingStops || analysis.stops || [];
    const suggestedAdds = analysis.suggestedAdds || analysis.suggestedAccounts || [];
    const summary = analysis.summary || '';

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
      try {
        createdLogs = await recorder.wrap(
          'Create RouteLogs',
          'Skill',
          () => conn.sobject('RouteLog__c').create(logsToCreate),
          { input: { count: logsToCreate.length, sample: logsToCreate.slice(0, 3) } },
        );
      } catch (err) {
        logger.error('AI Enhance: failed to create RouteLog__c', { error: err.message });
        logErrorToSalesforce({ errorType: 'AIEnhanceLogError', errorMessage: err.message, source: 'enhance-route', requestBody: JSON.stringify(logsToCreate).substring(0, 30000) });
      }
    }

    const logIds = Array.isArray(createdLogs) ? createdLogs.map((r) => r.id || r.Id).filter(Boolean) : [];
    let savedLogs = [];
    if (logIds.length > 0) {
      const ids = logIds.map((id) => `'${id}'`).join(',');
      const logResult = await conn.query(`SELECT Id, Name, Account__c, Type__c, Reason__c, Confidence__c, Status__c FROM RouteLog__c WHERE Id IN (${ids})`);
      savedLogs = logResult.records;
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

    const result = allRecs.map((rec, i) => ({
      ...rec,
      address: addressMap[rec.accountId] || '',
      logId: savedLogs[i]?.Id || logIds[i] || null,
      logName: savedLogs[i]?.Name || null,
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

/** POST /api/enhance-route/approve — update RouteLog__c status; Salesforce trigger handles Route__c creation */
router.post('/approve', async (req, res, next) => {
  try {
    const { logIds, status } = req.body;
    if (!logIds?.length || !status) return res.status(400).json({ error: 'logIds and status required' });

    const userName = req.driver?.name || 'Unknown';
    const conn = await getConnection();
    const updates = logIds.map((id) => ({
      Id: id,
      Status__c: status,
      Accepted_By__c: userName,
      Accepted_Date__c: new Date().toISOString(),
    }));
    await conn.sobject('RouteLog__c').update(updates);

    res.json({ success: true, updated: logIds.length, added: status === 'Accepted' ? logIds : [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
