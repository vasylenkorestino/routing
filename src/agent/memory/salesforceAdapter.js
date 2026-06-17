const { getConnection } = require('../../services/salesforce');
const { sanitizeMemoryForStorage } = require('../../utils/aiDataPolicy');
const config = require('../../config/anthropic');
const logger = require('../../utils/logger');

const USE_FILE_BACKEND = process.env.AGENT_MEMORY_BACKEND === 'file';
const fileStore = USE_FILE_BACKEND ? require('./fileMemoryStore') : null;

/** Upserts an Agent_Memory__c record (or file in dev). */
async function storeMemory(record) {
  const sanitized = sanitizeMemoryForStorage(record);
  if (!sanitized.valid) {
    const err = new Error(sanitized.violations.join('; ') || 'Invalid memory content');
    err.code = 'MEMORY_VALIDATION_FAILED';
    throw err;
  }

  if (USE_FILE_BACKEND && fileStore) {
    return fileStore.upsert(sanitized.record);
  }

  const conn = await getConnection();
  const payload = {
    Category__c: sanitized.record.category,
    Scope__c: sanitized.record.scope,
    Scope_Id__c: sanitized.record.scopeId || null,
    Summary__c: sanitized.record.summary,
    Content__c: sanitized.record.content,
    Confidence__c: (sanitized.record.confidence ?? 80) / 100,
    Source__c: sanitized.record.source || 'agent_self',
    Source_Record__c: sanitized.record.sourceRecord || null,
    Is_Active__c: true,
    Tags__c: sanitized.record.tags || null,
    Agent_Id__c: sanitized.record.agentId || config.agentId,
  };

  const result = await conn.sobject('Agent_Memory__c').create(payload);
  return { id: result.id, ...payload };
}

/** Queries active memories for recall. */
async function queryMemories({ scopeIds = [], yardId, limit } = {}) {
  const max = limit || config.memory?.maxRecalledMemories || 20;

  if (USE_FILE_BACKEND && fileStore) {
    return fileStore.query({ scopeIds, yardId, limit: max });
  }

  try {
    const conn = await getConnection();
    const accountFilter = scopeIds.length
      ? `OR (Scope__c = 'account' AND Scope_Id__c IN (${scopeIds.map((id) => `'${id}'`).join(',')}))`
      : '';
    const yardFilter = yardId ? `OR (Scope__c = 'service_location' AND Scope_Id__c = '${yardId}')` : '';
    const soql = `
      SELECT Id, Summary__c, Content__c, Category__c, Confidence__c, Scope__c, Tags__c
      FROM Agent_Memory__c
      WHERE Is_Active__c = true
        AND (Scope__c = 'global' ${accountFilter} ${yardFilter})
      ORDER BY Confidence__c DESC, Last_Recalled__c DESC NULLS LAST
      LIMIT ${max}
    `;
    const result = await conn.query(soql);
    return result.records || [];
  } catch (err) {
    logger.warn('[memory] query failed — Agent_Memory__c may not exist yet', { error: err.message });
    return [];
  }
}

/** Updates recall counters on memories. */
async function touchRecalled(ids) {
  if (!ids?.length || USE_FILE_BACKEND) return;
  try {
    const conn = await getConnection();
    const now = new Date().toISOString();
    await Promise.all(ids.map((id) => conn.sobject('Agent_Memory__c').update({
      Id: id,
      Last_Recalled__c: now,
    }).catch(() => null)));
  } catch {
    // best effort
  }
}

module.exports = { storeMemory, queryMemories, touchRecalled };
