const { redactFreeText } = require('../../utils/aiDataPolicy');
const { queryMemories, touchRecalled } = require('./salesforceAdapter');

/** Builds a memory block for injection into system prompts. */
async function buildMemoryContext({ context, recordType } = {}) {
  const scopeIds = [];
  if (context?.routeId) scopeIds.push(context.routeId);
  if (context?.stops?.length) {
    context.stops.forEach((s) => { if (s.accountId) scopeIds.push(s.accountId); });
  }
  const yardId = context?.serviceLocationId || null;

  const memories = await queryMemories({ scopeIds, yardId });
  if (!memories.length) return '';

  const lines = memories.map((m) => {
    const conf = m.Confidence__c != null ? Math.round(m.Confidence__c * 100) : '?';
    const summary = redactFreeText(m.Summary__c || '');
    const content = redactFreeText(m.Content__c || '');
    return `• [${m.Category__c || 'rule'}] ${summary || content} (confidence: ${conf}%)`;
  });

  touchRecalled(memories.map((m) => m.Id).filter(Boolean));

  return [
    '--- AGENT MEMORY (routing rules learned from past interactions — no PII) ---',
    ...lines,
    '--- END MEMORY ---',
  ].join('\n');
}

module.exports = { buildMemoryContext };
