/**
 * Module 1: Account Selection Engine.
 * Orchestrates existing skills to identify which accounts need service,
 * then uses Claude to score and classify them.
 */

const Anthropic = require('@anthropic-ai/sdk');
const sf = require('../services/salesforce');
const anthropicConfig = require('../config/anthropic');
const logger = require('../utils/logger');
const { redactFreeText } = require('../utils/aiDataPolicy');
const { accountRoutingFilterClause } = require('../utils/accountRoutingFilters');

const SELECTION_PROMPT = `You are an AI route analyst for a UCO (Used Cooking Oil) collection company.
You analyze route stops AND discover new accounts to add.

You will receive a JSON object with:
- route: route header info (may be null for new routes)
- existingStops: current stops on the route (with account details, service history, notes)
- candidates: accounts NOT currently on this route but eligible for service

IMPORTANT FIELDS TO CONSIDER:
- routeNotes (Account.Route_Notes__c): routing-specific comments about the account
- specialInstructions (Account.Notes__c): special instructions like "call before arrival", "skip if raining"
- driverNotes (Route__c.Driver_Notes__c): driver observations about this stop

YOUR TASKS:
1. Analyze each EXISTING stop — recommend keep/remove/flag
2. Analyze CANDIDATE accounts — recommend which ones should be ADDED

DECISION FACTORS:
- Tank fill % = (GPD × days_since_last_service) / tank_capacity. >=80% = must service. <30% = skip.
- VIP/No-fail = always keep
- Fixed points = always keep
- New accounts: fewer than 3 UCO Collection services = always keep; CDL (Deliver Container) more than 14 days ago with no UCO yet = keep/add
- Overdue = days past nextDueDate / service-due engine only. NEVER treat gpdHistorySpanDays (DaysInterval__c) as overdue — it is the GPD history window span, not cadence.
- Same plaza or street as existing stop = add if even moderately full
- Open tickets = higher priority
- Special instructions may indicate constraints (skip conditions, time windows, etc.)
- Driver notes may flag issues (inaccessible, closed, etc.)
- Consider truck capacity (~1800 gal) — don't exceed with additions
- Geographic fit — only suggest adds that are along the route path

Return ONLY valid JSON:
{
  "summary": "...",
  "existingStops": [{ "accountId": "", "accountName": "", "action": "keep|remove|flag", "confidence": 0-100, "reason": "" }],
  "suggestedAdds": [{ "accountId": "", "accountName": "", "action": "add", "confidence": 0-100, "reason": "", "address": "" }]
}`;

class AccountSelector {
  /**
   * Select accounts for a route using existing skills + AI analysis.
   * @param {Object} opts
   * @param {string} [opts.googleRouteId] - existing route to enhance
   * @param {string} [opts.recordType] - e.g. "EZG", "ENJ"
   * @param {string} [opts.serviceDate] - YYYY-MM-DD
   * @param {string} [opts.shapeId] - optional shape filter
   * @param {boolean} [opts.skipAI=false] - skip Claude analysis, return raw data only
   * @returns {Promise<Object>} { accountsToKeep[], accountsToAdd[], accountsToRemove[], summary }
   */
  async selectAccounts({ googleRouteId, recordType, serviceDate, shapeId, skipAI = false }) {
    const conn = await sf.getConnection();
    let route = null;
    let existingStops = [];
    let candidates = [];

    if (googleRouteId) {
      const result = await this._loadRouteWithStops(conn, googleRouteId);
      route = result.route;
      existingStops = result.stops;
      serviceDate = serviceDate || route.Service_Date__c;
    }

    candidates = await this._findCandidates(conn, {
      existingStops,
      serviceDate,
      recordType,
      routeCenter: this._computeCentroid(existingStops),
    });

    if (skipAI) {
      return {
        route,
        accountsToKeep: existingStops.map((s) => this._formatStop(s)),
        accountsToAdd: candidates.map((c) => this._formatCandidate(c)),
        accountsToRemove: [],
        summary: `Found ${existingStops.length} existing stops and ${candidates.length} candidates.`,
      };
    }

    return this._analyzeWithAI(route, existingStops, candidates);
  }

  /** Load a Google_Route__c with its child Route__c stops, enriched with Account data. */
  async _loadRouteWithStops(conn, googleRouteId) {
    const routeResult = await conn.query(`
      SELECT Id, Name, Service_Date__c, DriverName__c, Total_Distance__c, Total_Time__c,
             Service_Location_Start__c, Service_Location_End__c
      FROM Google_Route__c WHERE Id = '${googleRouteId}'
    `);
    if (!routeResult.records.length) throw new Error('Route not found');
    const route = routeResult.records[0];

    const stopsResult = await conn.query(`
      SELECT Id, AccountId__c, Account_Name__c, Container_Address__c, Priority__c,
             ServiceType__c, ServiceSubType__c, LastGallonsCollected__c, Notes__c,
             Driver_Notes__c, Status__c, Fixed_point__c, Latitude__c, Longitude__c
      FROM Route__c
      WHERE Google_Route_Id__c = '${googleRouteId}' AND AccountId__c != null
      ORDER BY Priority__c ASC
    `);

    const accountIds = stopsResult.records.map((s) => s.AccountId__c).filter(Boolean);
    let acctMap = {};
    if (accountIds.length > 0) {
      const ids = accountIds.map((id) => `'${id}'`).join(',');
      const acctResult = await conn.query(`
        SELECT Id, Name, Last_Service_Date__c, DaysInterval__c, Tank_Size__c,
               Second_Container__c, Priority_Tier__c, Route_Notes__c, Notes__c,
               MALatitude__c, MALongitude__c, Ignore_For_Routing__c,
               (SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ORDER BY CreatedDate DESC LIMIT 5)
        FROM Account WHERE Id IN (${ids})
      `);
      acctResult.records.forEach((a) => { acctMap[a.Id] = a; });
    }

    const stops = stopsResult.records.map((s) => {
      const acct = acctMap[s.AccountId__c] || {};
      return {
        ...s,
        _acct: acct,
        tankSize: acct.Tank_Size__c,
        secondContainer: acct.Second_Container__c,
        lastServiceDate: acct.Last_Service_Date__c,
        interval: acct.DaysInterval__c,
        priorityTier: acct.Priority_Tier__c,
        routeNotes: acct.Route_Notes__c,
        specialInstructions: acct.Notes__c,
        driverNotes: s.Driver_Notes__c,
        recentServices: (acct.Services__r?.records || []).map((sv) => ({
          gallons: sv.Qty_Gallons__c, date: sv.Service_Date__c,
        })),
      };
    });

    return { route, stops };
  }

  /** Find candidate accounts not already on the route. */
  async _findCandidates(conn, { existingStops, serviceDate, recordType, routeCenter }) {
    const existingIds = new Set(existingStops.map((s) => s.AccountId__c).filter(Boolean));

    const alreadyRouted = await sf.query(
      `SELECT AccountId__c FROM Route__c ` +
      `WHERE DateOfService__c = ${serviceDate} AND AccountId__c != null AND Status__c != 'Complete'`
    );
    const routedIds = new Set(alreadyRouted.map((r) => r.AccountId__c));

    let bbox = '';
    if (routeCenter) {
      const PAD = 0.15;
      const lats = existingStops.map((s) => s.Latitude__c).filter(Boolean);
      const lngs = existingStops.map((s) => s.Longitude__c).filter(Boolean);
      if (lats.length > 0) {
        bbox = ` AND MALatitude__c >= ${Math.min(...lats) - PAD} AND MALatitude__c <= ${Math.max(...lats) + PAD}` +
               ` AND MALongitude__c >= ${Math.min(...lngs) - PAD} AND MALongitude__c <= ${Math.max(...lngs) + PAD}`;
      }
    }

    let rtFilter = '';
    if (recordType) rtFilter = ` AND RecordType.Name = '${recordType}'`;

    const result = await conn.query(`
      SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState,
             MALatitude__c, MALongitude__c, Last_Service_Date__c, DaysInterval__c,
             Tank_Size__c, Second_Container__c, Priority_Tier__c,
             Route_Notes__c, Notes__c,
             Ignore_For_Routing__c, Rotisserie_Collection__c,
             (SELECT Id, Qty_Gallons__c, Service_Date__c FROM Services__r ORDER BY CreatedDate DESC LIMIT 3),
             (SELECT Id, Type, Status FROM Cases WHERE Status = 'Open' AND Type = 'UCO Collection' LIMIT 3)
      FROM Account
      WHERE ${accountRoutingFilterClause()}
        AND MALatitude__c != null AND MALongitude__c != null
        AND (Expected_Date_Of_Service__c <= ${serviceDate} OR Expected_Date_Of_Service__c = null)
        ${bbox}${rtFilter}
      ORDER BY Expected_Date_Of_Service__c ASC NULLS LAST LIMIT 100
    `);

    return (result.records || []).filter((a) => !existingIds.has(a.Id) && !routedIds.has(a.Id));
  }

  /** Send stop + candidate data to Claude for analysis. */
  async _analyzeWithAI(route, existingStops, candidates) {
    const payload = {
      route: route ? { id: route.Id, name: route.Name, date: route.Service_Date__c, driver: route.DriverName__c } : null,
      existingStops: existingStops.map((s) => ({
        accountId: s.AccountId__c,
        accountName: s.Account_Name__c,
        address: s.Container_Address__c,
        priority: s.Priority__c,
        serviceType: s.ServiceType__c,
        lastGallons: s.LastGallonsCollected__c,
        isFixed: s.Fixed_point__c,
        lat: s.Latitude__c,
        lng: s.Longitude__c,
        tankSize: s.tankSize,
        lastServiceDate: s.lastServiceDate,
        gpdHistorySpanDays: s.interval,
        priorityTier: s.priorityTier,
        routeNotes: redactFreeText(s.routeNotes),
        specialInstructions: redactFreeText(s.specialInstructions),
        driverNotes: redactFreeText(s.driverNotes),
        recentServices: s.recentServices,
      })),
      candidates: candidates.map((a) => ({
        accountId: a.Id,
        accountName: a.Name,
        address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
        lat: a.MALatitude__c,
        lng: a.MALongitude__c,
        lastServiceDate: a.Last_Service_Date__c,
        gpdHistorySpanDays: a.DaysInterval__c,
        tankSize: a.Tank_Size__c,
        priorityTier: a.Priority_Tier__c,
        routeNotes: redactFreeText(a.Route_Notes__c),
        specialInstructions: redactFreeText(a.Notes__c),
        hasOpenTicket: (a.Cases?.records?.length || 0) > 0,
        recentServices: (a.Services__r?.records || []).map((sv) => ({ gallons: sv.Qty_Gallons__c, date: sv.Service_Date__c })),
      })),
    };

    const client = new Anthropic({ apiKey: anthropicConfig.apiKey });
    const response = await client.messages.create({
      model: anthropicConfig.model,
      max_tokens: anthropicConfig.maxTokens,
      system: SELECTION_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });

    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let analysis;
    try {
      analysis = JSON.parse(cleaned);
    } catch {
      logger.error('[AccountSelector] Failed to parse AI response', { text: text.substring(0, 500) });
      throw new Error('AI returned invalid JSON');
    }

    const existingResults = analysis.existingStops || [];
    const suggestedAdds = analysis.suggestedAdds || [];

    return {
      route,
      accountsToKeep: existingResults.filter((r) => r.action === 'keep'),
      accountsToAdd: suggestedAdds,
      accountsToRemove: existingResults.filter((r) => r.action === 'remove'),
      accountsToFlag: existingResults.filter((r) => r.action === 'flag'),
      summary: analysis.summary || '',
      _raw: { existingStops: existingResults, suggestedAdds },
    };
  }

  _computeCentroid(stops) {
    const valid = stops.filter((s) => s.Latitude__c && s.Longitude__c);
    if (valid.length === 0) return null;
    return {
      lat: valid.reduce((sum, s) => sum + s.Latitude__c, 0) / valid.length,
      lng: valid.reduce((sum, s) => sum + s.Longitude__c, 0) / valid.length,
    };
  }

  _formatStop(s) {
    return {
      accountId: s.AccountId__c,
      accountName: s.Account_Name__c,
      lat: s.Latitude__c,
      lng: s.Longitude__c,
      address: s.Container_Address__c,
      isFixed: s.Fixed_point__c,
      priority: s.Priority__c,
      routeNotes: s.routeNotes,
      specialInstructions: s.specialInstructions,
      driverNotes: s.driverNotes,
    };
  }

  _formatCandidate(a) {
    return {
      accountId: a.Id,
      accountName: a.Name,
      lat: a.MALatitude__c,
      lng: a.MALongitude__c,
      address: [a.ShippingStreet, a.ShippingCity, a.ShippingState].filter(Boolean).join(', '),
      routeNotes: a.Route_Notes__c,
      specialInstructions: a.Notes__c,
    };
  }
}

module.exports = new AccountSelector();
