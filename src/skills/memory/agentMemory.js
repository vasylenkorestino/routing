const BaseSkill = require('../base');
const { storeMemory, queryMemories } = require('../../agent/memory/salesforceAdapter');
const { sanitizeMemoryForStorage } = require('../../utils/aiDataPolicy');

/** Stores, recalls, and searches routing-only agent memory. */
class AgentMemorySkill extends BaseSkill {
  constructor() {
    super({
      name: 'agent_memory',
      description:
        'Store, recall, or search learned routing rules and heuristics. ' +
        'Never store emails, phones, API keys, or customer contact data.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['store', 'recall', 'search'] },
          category: { type: 'string', description: 'Memory category (routing_heuristic, yard_rule, etc.)' },
          scope: { type: 'string', enum: ['global', 'service_location', 'account', 'driver', 'shape', 'user'] },
          scopeId: { type: 'string', description: 'Salesforce Id for scoped memory' },
          summary: { type: 'string', description: 'Short label' },
          content: { type: 'string', description: 'Full routing rule text' },
          confidence: { type: 'number', description: '0-100' },
          tags: { type: 'string', description: 'Comma-separated tags for search' },
          query: { type: 'string', description: 'Keyword for search action' },
        },
        required: ['action'],
      },
    });
  }

  async execute(params) {
    const { action } = params;

    if (action === 'store') {
      const sanitized = sanitizeMemoryForStorage({
        category: params.category,
        scope: params.scope,
        scopeId: params.scopeId,
        summary: params.summary,
        content: params.content,
        confidence: params.confidence,
        source: 'agent_self',
        tags: params.tags,
      });
      if (!sanitized.valid) {
        return { error: `Memory rejected: ${sanitized.violations.join('; ')}` };
      }
      const created = await storeMemory(sanitized.record);
      return { stored: true, id: created.id, summary: sanitized.record.summary };
    }

    if (action === 'recall' || action === 'search') {
      const scopeIds = params.scopeId ? [params.scopeId] : [];
      const memories = await queryMemories({ scopeIds, limit: 20 });
      let filtered = memories;
      if (action === 'search' && params.query) {
        const q = params.query.toLowerCase();
        filtered = memories.filter(
          (m) => (m.Summary__c || '').toLowerCase().includes(q)
            || (m.Content__c || '').toLowerCase().includes(q)
            || (m.Tags__c || '').toLowerCase().includes(q),
        );
      }
      return {
        count: filtered.length,
        memories: filtered.map((m) => ({
          id: m.Id,
          category: m.Category__c,
          summary: m.Summary__c,
          content: m.Content__c,
          confidence: m.Confidence__c,
        })),
      };
    }

    return { error: `Unknown action: ${action}` };
  }
}

module.exports = AgentMemorySkill;
