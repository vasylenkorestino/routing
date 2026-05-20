const BaseSkill = require('./base');
const defaults = require('../config/routeParams');

/** Manages and validates configurable route constraints. */
class RouteParametersSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_parameters',
      description:
        'Get or validate route parameters (time, distance, stops). ' +
        'Use "get" to retrieve current defaults. ' +
        'Use "validate" to check if a proposed route meets the parameter ranges. ' +
        'Parameters are flexible ranges (soft constraints), not hard limits.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['get', 'validate'],
          },
          overrides: {
            type: 'object',
            description: 'Optional overrides for route parameters (timeRange, distanceRange, stopsRange).',
          },
          route: {
            type: 'object',
            description: 'Route to validate. Must have: totalTimeMinutes, totalDistanceMiles, stopCount.',
          },
        },
        required: ['operation'],
      },
    });
  }

  async execute({ operation, overrides, route }) {
    const params = { ...defaults };
    if (overrides) {
      if (overrides.timeRange) params.timeRange = { ...params.timeRange, ...overrides.timeRange };
      if (overrides.distanceRange) params.distanceRange = { ...params.distanceRange, ...overrides.distanceRange };
      if (overrides.stopsRange) params.stopsRange = { ...params.stopsRange, ...overrides.stopsRange };
    }

    if (operation === 'get') {
      return { parameters: params };
    }

    if (operation === 'validate' && route) {
      const issues = [];

      if (route.totalTimeMinutes < params.timeRange.from) {
        issues.push(`Time ${route.totalTimeMinutes}min is below minimum ${params.timeRange.from}min`);
      }
      if (route.totalTimeMinutes > params.timeRange.to) {
        issues.push(`Time ${route.totalTimeMinutes}min exceeds maximum ${params.timeRange.to}min`);
      }
      if (route.totalDistanceMiles < params.distanceRange.from) {
        issues.push(`Distance ${route.totalDistanceMiles}mi is below minimum ${params.distanceRange.from}mi`);
      }
      if (route.totalDistanceMiles > params.distanceRange.to) {
        issues.push(`Distance ${route.totalDistanceMiles}mi exceeds maximum ${params.distanceRange.to}mi`);
      }
      if (route.stopCount < params.stopsRange.from) {
        issues.push(`${route.stopCount} stops is below minimum ${params.stopsRange.from}`);
      }
      if (route.stopCount > params.stopsRange.to) {
        issues.push(`${route.stopCount} stops exceeds maximum ${params.stopsRange.to}`);
      }

      return {
        valid: issues.length === 0,
        issues,
        parameters: params,
      };
    }

    return { parameters: params };
  }
}

module.exports = RouteParametersSkill;
