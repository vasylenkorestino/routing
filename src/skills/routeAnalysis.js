const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Analyzes historical completed routes for patterns, averages, and account groupings. */
class RouteAnalysisSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_analysis',
      description:
        'Analyze historical completed routes to find patterns. ' +
        'Returns average stops/distance/time per route, account co-occurrence patterns, ' +
        'and route frequency data. Only analyzes routes where CompletionStatus__c = "Completed" OR Driver_Completed__c = true.',
      inputSchema: {
        type: 'object',
        properties: {
          recordTypeName: {
            type: 'string',
            description: 'Record type to filter (e.g. "EZG", "ENJ").',
          },
          fromDate: {
            type: 'string',
            description: 'Start date for analysis window (YYYY-MM-DD).',
          },
          toDate: {
            type: 'string',
            description: 'End date for analysis window (YYYY-MM-DD).',
          },
          limit: {
            type: 'number',
            description: 'Max number of routes to analyze. Default 200.',
          },
        },
        required: [],
      },
    });
  }

  async execute({ recordTypeName, fromDate, toDate, limit = 200 }) {
    let soql =
      'SELECT Id, Name, Service_Date__c, Miles__c, Minutes__c, Gallons_Collected__c, ' +
      'Accounts__c, Shape__c, Driver__c, DriverName__c, ' +
      'Service_Location_Start__c, Service_Location_End__c, ' +
      '(SELECT Id, AccountId__c, Account_Name__c, Latitude__c, Longitude__c, ' +
      'Priority__c, Gallons_Collected__c, ServiceType__c FROM Routes__r ORDER BY Priority__c ASC) ' +
      'FROM Google_Route__c ' +
      'WHERE (CompletionStatus__c = \'Completed\' OR Driver_Completed__c = true) ';

    if (recordTypeName) soql += `AND RecordType.Name = '${recordTypeName}' `;
    if (fromDate) soql += `AND Service_Date__c >= ${fromDate} `;
    if (toDate) soql += `AND Service_Date__c <= ${toDate} `;
    soql += `ORDER BY Service_Date__c DESC LIMIT ${limit}`;

    const routes = await sf.query(soql);

    const stats = this._computeStats(routes);
    const coOccurrence = this._computeCoOccurrence(routes);

    return {
      routeCount: routes.length,
      averages: stats,
      topAccountPairs: coOccurrence.slice(0, 30),
      sampleRoutes: routes.slice(0, 10).map((r) => ({
        id: r.Id,
        name: r.Name,
        date: r.Service_Date__c,
        miles: r.Miles__c,
        minutes: r.Minutes__c,
        stopCount: r.Routes__r?.records?.length || 0,
        accountIds: (r.Accounts__c || '').split(',').filter(Boolean),
      })),
    };
  }

  _computeStats(routes) {
    if (routes.length === 0) return {};

    let totalStops = 0;
    let totalMiles = 0;
    let totalMinutes = 0;
    let totalGallons = 0;
    let countWithMiles = 0;
    let countWithMinutes = 0;

    for (const r of routes) {
      const stops = r.Routes__r?.records?.length || 0;
      totalStops += stops;
      if (r.Miles__c) { totalMiles += r.Miles__c; countWithMiles++; }
      if (r.Minutes__c) { totalMinutes += r.Minutes__c; countWithMinutes++; }
      if (r.Gallons_Collected__c) totalGallons += r.Gallons_Collected__c;
    }

    return {
      avgStopsPerRoute: Math.round((totalStops / routes.length) * 10) / 10,
      avgMiles: countWithMiles ? Math.round((totalMiles / countWithMiles) * 10) / 10 : null,
      avgMinutes: countWithMinutes ? Math.round((totalMinutes / countWithMinutes) * 10) / 10 : null,
      avgGallons: Math.round((totalGallons / routes.length) * 10) / 10,
    };
  }

  /** Finds account pairs that frequently appear on the same route. */
  _computeCoOccurrence(routes) {
    const pairCounts = {};

    for (const r of routes) {
      const ids = (r.Accounts__c || '').split(',').map((s) => s.trim()).filter(Boolean);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = [ids[i], ids[j]].sort().join('|');
          pairCounts[key] = (pairCounts[key] || 0) + 1;
        }
      }
    }

    return Object.entries(pairCounts)
      .map(([pair, count]) => {
        const [a, b] = pair.split('|');
        return { accountA: a, accountB: b, coOccurrences: count };
      })
      .sort((a, b) => b.coOccurrences - a.coOccurrences);
  }
}

module.exports = RouteAnalysisSkill;
