const BaseSkill = require('./base');
const { analyzeRouteCompare } = require('../modules/routeCompare');

/** Compares current route against completed historical runs with the same base route name. */
class CompareRoutesSkill extends BaseSkill {
  constructor() {
    super({
      name: 'compare_routes',
      description:
        'Compare the CURRENT route to past COMPLETED runs with the same base route name. ' +
        'Returns stop diff sections (stable, only-on-current, only-on-history), trends, and add/remove candidates. ' +
        'Use this for route-specific history — NOT for broad date-range stats (use route_analysis instead).',
      inputSchema: {
        type: 'object',
        properties: {
          googleRouteId: {
            type: 'string',
            description: 'Salesforce Id of the current Google_Route__c.',
          },
          routeName: {
            type: 'string',
            description: 'Optional name override; defaults to the current route Name.',
          },
          limit: {
            type: 'number',
            description: 'Max historical routes to load. Default 20.',
          },
        },
        required: ['googleRouteId'],
      },
    });
  }

  async execute(params) {
    return analyzeRouteCompare(params);
  }
}

module.exports = CompareRoutesSkill;
