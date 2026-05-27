const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/anthropic');
const { getConnection } = require('./salesforce');
const { logErrorToSalesforce } = require('./errorLogger');
const { publish, EVENT_TICKET_TRIAGED } = require('./notificationBus');
const logger = require('../utils/logger');

const SKILL_NAME = 'Ticket Triage';
const TYPE_ADD = 'Ticket Triage - Add To Route';
const TYPE_NEW = 'Ticket Triage - New Route Suggested';

const TRIAGE_SYSTEM = `You are a routing dispatcher for a UCO (Used Cooking Oil) collection company.
A new ticket (Case) has just been created. You must decide the best route to service it.

You will receive JSON with:
- ticket: the Case (account, geo, ticket type, future service date, notes)
- account: the customer account (geo, last service, frequency, shape)
- candidateRoutes: existing Google_Route__c records that could service the ticket (id, name, service date, driver, stop count, isAI, geo center)

YOUR TASKS:
1. Decide whether to add the ticket to one of the candidateRoutes or recommend creating a new route.
2. Prefer adding to an existing route on/near the ticket's required service date when geographically reasonable.
3. Recommend a new route only if no candidate is appropriate (wrong area, wrong date, or none provided).

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
 * Returns the created RouteLog payload (or null on failure).
 */
async function triageTicket(ticket) {
  if (!ticket || !ticket.id) {
    logger.warn('[ticketTriage] missing ticket id; skipping');
    return null;
  }

  try {
    const conn = await getConnection();
    const account = await loadAccount(conn, ticket.accountId);
    const candidates = await loadCandidateRoutes(conn, ticket, account);

    const decision = await askClaude({ ticket, account, candidates });
    const matchedRoute = decision.googleRouteId
      ? candidates.find((c) => c.id === decision.googleRouteId)
      : null;
    const log = await createRouteLog(conn, ticket, decision, matchedRoute);

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
  const soql = `
    SELECT Id, Name, MALatitude__c, MALongitude__c, Shape__c,
           Last_Service_Date__c, Pickup_Frequency_in_Days__c,
           Ignore_For_Routing__c, Notes__c, Route_Notes__c
    FROM Account WHERE Id = '${accountId}'
  `;
  const res = await conn.query(soql);
  return res.records[0] || null;
}

async function loadCandidateRoutes(conn, ticket, account) {
  const targetDate = ticket.futureServiceDate
    ? toIsoDate(ticket.futureServiceDate)
    : toIsoDate(new Date().toISOString());

  const filters = [`Service_Date__c >= ${shiftDate(targetDate, 0)}`, `Service_Date__c <= ${shiftDate(targetDate, 7)}`];
  if (account?.Shape__c) {
    filters.push(`(Shape__c = '${account.Shape__c}' OR Shape__c = null)`);
  }

  const soql = `
    SELECT Id, Name, Service_Date__c, Driver__c, DriverName__c, Shape__c,
           Service_Location_Start__c, Service_Location_End__c,
           CompletionStatus__c, isAI__c, isAIApproved__c, Accounts__c
    FROM Google_Route__c
    WHERE ${filters.join(' AND ')}
    ORDER BY Service_Date__c ASC
    LIMIT 25
  `;
  const res = await conn.query(soql);
  return (res.records || []).map((r) => ({
    id: r.Id,
    name: r.Name,
    serviceDate: r.Service_Date__c,
    driverId: r.Driver__c,
    driverName: r.DriverName__c,
    shapeId: r.Shape__c,
    completion: r.CompletionStatus__c,
    isAI: r.isAI__c,
    accountIds: (r.Accounts__c || '').split(',').filter(Boolean),
  }));
}

async function askClaude({ ticket, account, candidates }) {
  if (!config.apiKey) {
    return defaultDecision(candidates);
  }
  const client = new Anthropic({ apiKey: config.apiKey });
  const payload = {
    ticket: {
      id: ticket.id,
      caseNumber: ticket.caseNumber,
      subject: ticket.subject,
      recordType: ticket.recordType,
      accountId: ticket.accountId,
      accountLat: ticket.accountLat,
      accountLng: ticket.accountLng,
      isFuture: ticket.isFuture,
      futureServiceDate: ticket.futureServiceDate,
      driverRequestedId: ticket.driverRequestedId,
      notes: ticket.notes,
      typeName: ticket.typeName,
    },
    account,
    candidateRoutes: candidates,
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
    return defaultDecision(candidates);
  }

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return normalizeDecision(parsed, candidates);
  } catch {
    logger.warn('[ticketTriage] could not parse Claude response, using fallback', { text: text.slice(0, 500) });
    return defaultDecision(candidates);
  }
}

function defaultDecision(candidates) {
  if (candidates && candidates.length > 0) {
    const first = candidates[0];
    return {
      decision: 'addToRoute',
      googleRouteId: first.id,
      suggestedDate: first.serviceDate || null,
      suggestedDriverId: first.driverId || null,
      confidence: 40,
      reason: 'Heuristic fallback: nearest upcoming candidate route by service date.',
    };
  }
  return {
    decision: 'newRoute',
    googleRouteId: null,
    suggestedDate: null,
    suggestedDriverId: null,
    confidence: 30,
    reason: 'No candidate routes available; new route suggested.',
  };
}

function normalizeDecision(d, candidates) {
  const decision = d.decision === 'newRoute' ? 'newRoute' : 'addToRoute';
  let googleRouteId = d.googleRouteId || null;
  if (decision === 'addToRoute' && googleRouteId) {
    const ok = candidates.some((c) => c.id === googleRouteId);
    if (!ok) googleRouteId = candidates[0]?.id || null;
  }
  if (decision === 'addToRoute' && !googleRouteId) {
    return defaultDecision(candidates);
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

async function createRouteLog(conn, ticket, decision, matchedRoute) {
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
      googleRouteId: decision.googleRouteId,
      googleRouteName: matchedRoute ? matchedRoute.name : null,
      decision: decision.decision,
      type: record.Type__c,
      confidence: decision.confidence,
      reason: decision.reason,
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

module.exports = { triageTicket };
