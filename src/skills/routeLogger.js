const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Creates RouteLog__c records in Salesforce to document AI decisions. */
class RouteLoggerSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_logger',
      description:
        'Create RouteLog__c records in Salesforce to log AI routing decisions. ' +
        'Supports route-level logs (linked to Google_Route__c) and stop-level logs (linked to Route__c). ' +
        'Each log should explain why a route was created or why an account was added/recommended.',
      inputSchema: {
        type: 'object',
        properties: {
          logs: {
            type: 'array',
            description: 'Array of log entries to create.',
            items: {
              type: 'object',
              properties: {
                Google_Route__c: { type: 'string', description: 'Google Route Id (for route-level logs).' },
                Route__c: { type: 'string', description: 'Route Id (for stop-level logs).' },
                Account__c: { type: 'string', description: 'Account Id.' },
                Type__c: { type: 'string', enum: ['Route Created', 'Account Added', 'Account Recommended', 'Route Optimized'] },
                Reason__c: { type: 'string', description: 'AI-generated explanation of the decision.' },
                Status__c: { type: 'string', enum: ['Proposed', 'Accepted', 'Declined'] },
                Skill__c: { type: 'string', description: 'Name of the skill that generated this log.' },
                Confidence__c: { type: 'number', description: 'Confidence percentage (0-100).' },
              },
              required: ['Type__c', 'Reason__c'],
            },
          },
        },
        required: ['logs'],
      },
    });
  }

  async execute({ logs }) {
    if (!logs || logs.length === 0) {
      return { created: 0, ids: [] };
    }

    const records = logs.map((log) => ({
      Google_Route__c: log.Google_Route__c || null,
      Route__c: log.Route__c || null,
      Account__c: log.Account__c || null,
      Type__c: log.Type__c,
      Reason__c: log.Reason__c,
      Status__c: log.Status__c || 'Proposed',
      Skill__c: log.Skill__c || 'unknown',
      Confidence__c: log.Confidence__c || null,
    }));

    const results = await sf.insert('RouteLog__c', records);
    const ids = results.filter((r) => r.success).map((r) => r.id);

    return { created: ids.length, ids };
  }
}

module.exports = RouteLoggerSkill;
