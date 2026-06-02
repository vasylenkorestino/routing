const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const { getConnection } = require('./salesforce');
const { logErrorToSalesforce } = require('./errorLogger');
const { publish, EVENT_TICKET_TRIAGED } = require('./notificationBus');
const { evaluateRoute } = require('../skills/routeReadiness');
const logger = require('../utils/logger');
const {
  isUcoTicket,
  ticketRecordTypeName,
  accountServiceLocationId,
  routeMatchesTicketContext,
  escapeSoql,
} = require('../utils/ticketTriageRules');

const SKILL_NAME = 'Ticket Triage';
const TYPE_ADD = 'Ticket Triage - Add To Route';
const TYPE_NEW = 'Ticket Triage - New Route Suggested';

const TRIAGE_SYSTEM = `You are a routing dispatcher for a UCO (Used Cooking Oil) collection company.
A new UCO Collection ticket (Case) has just been created. You must decide the best route to service it.

You will receive JSON with:
- ticket: the Case (record type EZG or ENJ, account, geo, service date, notes)
- account: the customer account (service location depot, geo, last service, frequency, shape)
- candidateRoutes: existing Google_Route__c records that ALREADY match the ticket record type and the account service location (depot)

HARD RULES (already enforced in candidateRoutes — do not violate):
1. EZG tickets may only use EZG routes; ENJ tickets may only use ENJ routes.
2. The route must use the same service location (depot) as the account — never mix cities/regions (e.g. Miami vs New York).
3. Only UCO Collection tickets are triaged; container/grease tickets are out of scope.

YOUR TASKS:
1. Decide whether to add the ticket to one of the candidateRoutes or recommend creating a new route.
2. Prefer adding to an existing route on/near the ticket's required service date when geographically reasonable.
3. Recommend a new route only if no candidate is appropriate (wrong date, or none provided).

Return ONLY valid JSON with this shape:
{
  "decision": "addToRoute" | "newRoute",
  "googleRouteId": "<Id of candidate, or null when newRoute>",
  "suggestedDate": "YYYY-MM-DD or null",
  "suggestedDriverId": "<Driver__c Id or null>",
  "confidence": 0-100,
  "reason": "1-2 sentence explanation"
}`;

/**
 * Runs end-to-end AI triage for a single Case payload from the SF webhook.
 * Loads context, asks Claude for a decision, persists a RouteLog__c, and publishes a bell event.
 *
 * @param {object} ticket - Case payload from the inbound webhook (or replayed from RouteLog.Input_Data__c)
 * @param {object} [options]
 * @param {string[]} [options.excludeRouteIds] - Google_Route__c ids to skip (used by Decline → re-triage)
 * @param {string|null} [options.parentLogId] - When this triage is a retry, link the new RouteLog__c to the previous one via Parent_Log__c
 * @returns {Promise<object|null>} the created RouteLog payload or null on failure
 */
async function triageTicket(ticket, options = {}) {
  if (!ticket || !ticket.id) {
    logger.warn('[ticketTriage] missing ticket id; skipping');
    return null;
  }
  if (!isUcoTicket(ticket)) {
    logger.info('[ticketTriage] skipping non-UCO ticket', {
      ticketId: ticket.id,
      type: ticket.type || ticket.typeName,
    });
    return null;
  }

  const { excludeRouteIds = [], parentLogId = null } = options;
  const ticketRt = ticketRecordTypeName(ticket);
  if (!ticketRt) {
    logger.info('[ticketTriage] skipping unsupported record type', {
      ticketId: ticket.id,
      recordType: ticket.recordType,
    });
    return null;
  }

  try {
    const conn = await getConnection();
    const account = await loadAccount(conn, ticket.accountId);
    const serviceLocId = accountServiceLocationId(account, ticket);
    const candidates = await loadCandidateRoutes(conn, ticket, account, {
      ticketRecordType: ticketRt,
      serviceLocationId: serviceLocId,
      excludeRouteIds,
    });

    if (!serviceLocId) {
      logger.warn('[ticketTriage] account has no RelatedServiceLocation__c; no route candidates', {
        ticketId: ticket.id,
        accountId: ticket.accountId,
      });
    }

    const decision = await askClaude({ ticket, account, candidates, ticketRecordType: ticketRt, serviceLocationId: serviceLocId });
    const matchedRoute = decision.googleRouteId
      ? candidates.find((c) => c.id === decision.googleRouteId)
      : null;
    const log = await createRouteLog(conn, ticket, decision, matchedRoute, parentLogId);

    if (log) {
      publish(EVENT_TICKET_TRIAGED, log);
    }
    return log;
  } catch (err) {
    logger.error('[ticketTriage] failed', { error: err.message, ticketId: ticket.id });
    logErrorToSalesforce({
      errorType: 'TicketTriageError',
      errorMessage: err.message,
      stackTrace: err.stack,
      source: 'ticketTriage',
      requestBody: JSON.stringify(ticket).substring(0, 30000),
    });
    return null;
  }
}

async function loadAccount(conn, accountId) {
  if (!accountId) return null;
  const safeId = escapeSoql(accountId);
  const soql = `
    SELECT Id, Name, MALatitude__c, MALongitude__c, Shape__c,
           Last_Service_Date__c, Pickup_Frequency_in_Days__c,
           Ignore_For_Routing__c, Notes__c, Route_Notes__c,
           RelatedServiceLocation__c, AccountServiceLocation__c,
           RecordType.Name
    FROM Account WHERE Id = '${safeId}'
  `;
  const res = await conn.query(soql);
  return res.records[0] || null;
}

async function loadCandidateRoutes(conn, ticket, account, { ticketRecordType, serviceLocationId, excludeRouteIds = [] }) {
  const targetDate = ticket.futureServiceDate
    ? toIsoDate(ticket.futureServiceDate)
    : toIsoDate(new Date().toISOString());

  const filters = [`Service_Date__c >= ${shiftDate(targetDate, 0)}`, `Service_Date__c <= ${shiftDate(targetDate, 7)}`];

  if (ticketRecordType) {
    filters.push(`RecordType.Name = '${escapeSoql(ticketRecordType)}'`);
  }
  if (serviceLocationId) {
    const loc = escapeSoql(serviceLocationId);
    filters.push(`(Service_Location_Start__c = '${loc}' OR Service_Location_End__c = '${loc}')`);
  }
  if (account?.Shape__c) {
    filters.push(`(Shape__c = '${escapeSoql(account.Shape__c)}' OR Shape__c = null)`);
  }
  if (Array.isArray(excludeRouteIds) && excludeRouteIds.length > 0) {
    const inList = excludeRouteIds
      .filter(Boolean)
      .map((id) => `'${escapeSoql(id)}'`)
      .join(',');
    if (inList) filters.push(`Id NOT IN (${inList})`);
  }

  const soql = `
    SELECT Id, Name, Service_Date__c, Driver__c, DriverName__c, Shape__c,
           RecordType.Name,
           Service_Location_Start__c, Service_Location_End__c,
           CompletionStatus__c, isAI__c, isAIApproved__c, Accounts__c,
           Driver_Completed__c, isLocked__c,
           (SELECT Id, Status__c, Gallons_Collected__c, Notes2__c,
                   Service_Completed__c, Inactive__c
            FROM Routes__r)
    FROM Google_Route__c
    WHERE ${filters.join(' AND ')}
    ORDER BY Service_Date__c ASC
    LIMIT 25
  `;
  const res = await conn.query(soql);
  const records = res.records || [];
  const open = records.filter((r) => {
    const stops = (r.Routes__r && r.Routes__r.records) || [];
    return evaluateRoute(r, stops).open;
  });
  if (open.length !== records.length) {
    logger.info('[ticketTriage] filtered candidate routes by readiness', {
      total: records.length,
      open: open.length,
      ticketId: ticket.id,
    });
  }

  const mapped = open.map((r) => ({
    id: r.Id,
    name: r.Name,
    serviceDate: r.Service_Date__c,
    driverId: r.Driver__c,
    driverName: r.DriverName__c,
    shapeId: r.Shape__c,
    recordTypeName: r.RecordType?.Name || null,
    serviceLocationStartId: r.Service_Location_Start__c,
    serviceLocationEndId: r.Service_Location_End__c,
    completion: r.CompletionStatus__c,
    isAI: r.isAI__c,
    accountIds: (r.Accounts__c || '').split(',').filter(Boolean),
  }));

  return mapped.filter((r) => routeMatchesTicketContext(r, ticketRecordType, serviceLocationId));
}

async function askClaude({ ticket, account, candidates, ticketRecordType, serviceLocationId }) {
  if (!config.apiKey) {
    return defaultDecision(candidates, { ticketRecordType, serviceLocationId });
  }
  const client = new Anthropic({ apiKey: config.apiKey });
  const payload = {
    ticket: {
      id: ticket.id,
      caseNumber: ticket.caseNumber,
      subject: ticket.subject,
      recordType: ticket.recordType,
      type: ticket.type || ticket.typeName,
      accountId: ticket.accountId,
      accountLat: ticket.accountLat,
      accountLng: ticket.accountLng,
      isFuture: ticket.isFuture,
      futureServiceDate: ticket.futureServiceDate,
      driverRequestedId: ticket.driverRequestedId,
      notes: ticket.notes,
      typeName: ticket.typeName,
    },
    account: account ? {
      ...account,
      serviceLocationId: accountServiceLocationId(account, ticket),
      serviceLocationName: account.AccountServiceLocation__c,
    } : null,
    candidateRoutes: candidates,
    matchingRules: {
      ticketRecordType,
      serviceLocationId,
    },
  };

  let response;
  try {
    response = await client.messages.create({
      model: config.model,
      max_tokens: 1024,
      system: TRIAGE_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
  } catch (err) {
    logger.error('[ticketTriage] Claude call failed', { error: err.message });
    return defaultDecision(candidates, { ticketRecordType, serviceLocationId });
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return normalizeDecision(parsed, candidates, { ticketRecordType, serviceLocationId });
  } catch {
    logger.warn('[ticketTriage] could not parse Claude response, using fallback', { text: text.slice(0, 500) });
    return defaultDecision(candidates, { ticketRecordType, serviceLocationId });
  }
}

function defaultDecision(candidates, ctx = {}) {
  const eligible = (candidates || []).filter((c) =>
    routeMatchesTicketContext(c, ctx.ticketRecordType, ctx.serviceLocationId),
  );
  if (eligible.length > 0) {
    const first = eligible[0];
    const locNote = ctx.serviceLocationId ? 'same service location' : 'matching record type';
    return {
      decision: 'addToRoute',
      googleRouteId: first.id,
      suggestedDate: first.serviceDate || null,
      suggestedDriverId: first.driverId || null,
      confidence: 40,
      reason: `Heuristic fallback: nearest upcoming ${first.recordTypeName || ''} route (${locNote}) by service date.`,
    };
  }
  const rt = ctx.ticketRecordType || 'matching';
  return {
    decision: 'newRoute',
    googleRouteId: null,
    suggestedDate: null,
    suggestedDriverId: null,
    confidence: 30,
    reason: `No open ${rt} routes at this account's service location; new route suggested.`,
  };
}

function normalizeDecision(d, candidates, ctx = {}) {
  const decision = d.decision === 'newRoute' ? 'newRoute' : 'addToRoute';
  let googleRouteId = d.googleRouteId || null;
  const eligible = (candidates || []).filter((c) =>
    routeMatchesTicketContext(c, ctx.ticketRecordType, ctx.serviceLocationId),
  );
  if (decision === 'addToRoute' && googleRouteId) {
    const ok = eligible.some((c) => c.id === googleRouteId);
    if (!ok) googleRouteId = eligible[0]?.id || null;
  }
  if (decision === 'addToRoute' && !googleRouteId) {
    return defaultDecision(candidates, ctx);
  }
  return {
    decision,
    googleRouteId: decision === 'newRoute' ? null : googleRouteId,
    suggestedDate: d.suggestedDate || null,
    suggestedDriverId: d.suggestedDriverId || null,
    confidence: clampNumber(d.confidence, 0, 100, 50),
    reason: typeof d.reason === 'string' ? d.reason.slice(0, 1000) : '',
  };
}

async function createRouteLog(conn, ticket, decision, matchedRoute, parentLogId = null) {
  const record = {
    Google_Route__c: decision.googleRouteId,
    Account__c: ticket.accountId || null,
    Ticket__c: ticket.id,
    Type__c: decision.decision === 'addToRoute' ? TYPE_ADD : TYPE_NEW,
    Skill__c: SKILL_NAME,
    Status__c: 'Proposed',
    Confidence__c: (decision.confidence || 0) / 100,
    Reason__c: buildReasonString(ticket, decision),
    Input_Data__c: JSON.stringify({ ticket, decision }).substring(0, 32000),
  };
  if (parentLogId) record.Parent_Log__c = parentLogId;

  try {
    const created = await conn.sobject('RouteLog__c').create(record);
    const id = created.id || created.Id;
    if (!id) {
      logger.error('[ticketTriage] RouteLog__c create returned no id', { created });
      return null;
    }
    return {
      id,
      ticketId: ticket.id,
      caseNumber: ticket.caseNumber,
      accountId: ticket.accountId,
      accountName: ticket.accountName,
      accountLat: ticket.accountLat,
      accountLng: ticket.accountLng,
      ticketType: ticket.typeName || ticket.type || null,
      caseRecordType: ticket.recordType || null,
      ticketOpenedAt: ticket.createdDate || null,
      googleRouteId: decision.googleRouteId,
      googleRouteName: matchedRoute ? matchedRoute.name : null,
      decision: decision.decision,
      type: record.Type__c,
      confidence: decision.confidence,
      reason: decision.reason,
      parentLogId: parentLogId || null,
      createdAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.error('[ticketTriage] failed to insert RouteLog__c', { error: err.message });
    logErrorToSalesforce({
      errorType: 'TicketTriageInsert',
      errorMessage: err.message,
      stackTrace: err.stack,
      source: 'ticketTriage',
      requestBody: JSON.stringify(record).substring(0, 30000),
    });
    return null;
  }
}

function buildReasonString(ticket, decision) {
  const verb = decision.decision === 'addToRoute' ? 'ADD' : 'NEW';
  return `[${verb}] ${ticket.accountName || ticket.accountId || 'Ticket'}: ${decision.reason || ''}`.slice(0, 32000);
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return new Date(value).toISOString().slice(0, 10);
}

function shiftDate(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function clampNumber(n, min, max, fallback) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

module.exports = { triageTicket, isUcoTicket };
