const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Lightweight loader for current Route__c stops on a Google route. */
class RouteStopsSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_stops',
      description:
        'Load the current stop list for a Google_Route__c (Route__c Id, AccountId__c, Account_Name__c, priority). ' +
        'Use for quick lookups when you need stop IDs or to verify a stop exists. ' +
        'Prefer route_edit_proposal with removeAccountNames/addAccountNames for edits — only call this when disambiguation is needed.',
      inputSchema: {
        type: 'object',
        properties: {
          googleRouteId: { type: 'string', description: 'Google_Route__c Id.' },
          searchName: {
            type: 'string',
            description: 'Optional account name filter (partial match on Account_Name__c).',
          },
        },
        required: ['googleRouteId'],
      },
    });
  }

  async execute({ googleRouteId, searchName }) {
    const stops = await sf.query(
      `SELECT Id, AccountId__c, Account_Name__c, Priority__c, Container_Address__c, Status__c ` +
      `FROM Route__c WHERE GRoute_Id__c = '${googleRouteId}' ORDER BY Priority__c ASC`,
    );

    let filtered = stops;
    if (searchName) {
      const q = searchName.toLowerCase();
      filtered = stops.filter((s) => (s.Account_Name__c || '').toLowerCase().includes(q));
    }

    return {
      googleRouteId,
      stopCount: stops.length,
      stops: filtered.map((s) => ({
        stopId: s.Id,
        accountId: s.AccountId__c,
        accountName: s.Account_Name__c,
        priority: s.Priority__c,
        address: s.Container_Address__c,
        status: s.Status__c,
      })),
    };
  }
}

module.exports = RouteStopsSkill;
