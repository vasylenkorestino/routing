const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config/anthropic');
const { getConnection } = require('../../services/salesforce');
const { redactFreeText, sanitizeMemoryForStorage } = require('../../utils/aiDataPolicy');
const { storeMemory } = require('../memory/salesforceAdapter');
const { drainQueue, queueLength } = require('./feedbackObserver');
const logger = require('../../utils/logger');

let lastProcessedAt = null;

const REFLECTION_SYSTEM = `You synthesize routing feedback into durable routing rules.
Store ONLY generalized routing heuristics — never emails, phones, API keys, or verbatim comments.
Return JSON array: [{ "category", "scope", "scopeId", "summary", "content", "confidence" }]`;

/** Runs reflection over recent feedback and upserts Agent_Memory__c records. */
async function runReflectionJob() {
  const minEvents = config.memory?.reflectionMinFeedbackEvents || 10;
  if (queueLength() < minEvents) {
    logger.info('[reflectionJob] skipped — insufficient queued events');
    return { skipped: true, reason: 'insufficient events' };
  }

  const events = drainQueue(config.memory?.reflectionMaxEventsPerRun || 100);
  const conn = await getConnection();

  let sfLogs = [];
  try {
    const since = lastProcessedAt || new Date(Date.now() - 7 * 86400000).toISOString();
    const result = await conn.query(`
      SELECT Id, Status__c, Reason__c, Skill__c, Account__c, Google_Route__c, LastModifiedDate
      FROM RouteLog__c
      WHERE LastModifiedDate > '${since}'
      ORDER BY LastModifiedDate DESC
      LIMIT 50
    `);
    sfLogs = result.records || [];
  } catch (err) {
    logger.warn('[reflectionJob] RouteLog query failed', { error: err.message });
  }

  const payload = {
    events: events.map((e) => ({ type: e.type, detail: redactFreeText(e.detail || '') })),
    routeLogs: sfLogs.map((l) => ({
      status: l.Status__c,
      reason: redactFreeText(l.Reason__c),
      skill: l.Skill__c,
    })),
  };

  const client = new Anthropic({ apiKey: config.apiKey });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 4096,
    system: REFLECTION_SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });

  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let candidates = [];
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    candidates = JSON.parse(cleaned);
    if (!Array.isArray(candidates)) candidates = [];
  } catch {
    logger.error('[reflectionJob] failed to parse LLM output');
    return { error: 'parse failed' };
  }

  let stored = 0;
  let rejected = 0;
  for (const c of candidates) {
    const sanitized = sanitizeMemoryForStorage({
      category: c.category,
      scope: c.scope || 'global',
      scopeId: c.scopeId,
      summary: c.summary,
      content: c.content,
      confidence: c.confidence,
      source: 'reflection_job',
    });
    if (!sanitized.valid) {
      rejected += 1;
      continue;
    }
    try {
      await storeMemory(sanitized.record);
      stored += 1;
    } catch (err) {
      rejected += 1;
      logger.warn('[reflectionJob] store failed', { error: err.message });
    }
  }

  lastProcessedAt = new Date().toISOString();
  return { stored, rejected, processedEvents: events.length };
}

module.exports = { runReflectionJob };
