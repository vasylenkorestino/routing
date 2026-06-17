const { getConnection } = require('./salesforce');
const logger = require('../utils/logger');

/** POST helper for the RoutingAPIController Apex REST endpoints. */
async function apexPost(path, body) {
  const conn = await getConnection();
  const url = `/services/apexrest/routing/${path}`;
  logger.info(`[sfRoutingApi] POST ${url}`, { bodyKeys: Object.keys(body || {}) });
  const res = await conn.request({
    method: 'POST',
    url,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return typeof res === 'string' ? JSON.parse(res) : res;
}

/** Reorders stops and updates polyline/metrics for a Google route via Apex. */
async function optimizeGoogleRoute(googleRoute, routePoints) {
  return apexPost('optimize-route', { googleRoute, routePoints });
}

module.exports = { apexPost, optimizeGoogleRoute };
