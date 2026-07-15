const sf = require('../services/salesforce');

/** SOQL filter for successfully completed routes. */
const COMPLETED_FILTER = "(CompletionStatus__c = 'Completed' OR Driver_Completed__c = true)";

const STOP_SUBQUERY =
  '(SELECT Id, AccountId__c, Account_Name__c, Container_Address__c, Priority__c, ' +
  'Gallons_Collected__c, LastGallonsCollected__c, Latitude__c, Longitude__c, Status__c ' +
  'FROM Routes__r WHERE AccountId__c != null ORDER BY Priority__c ASC)';

const ROUTE_FIELDS =
  'Id, Name, Service_Date__c, CreatedDate, DriverName__c, Total_Distance__c, Total_Time__c, Minutes__c, ' +
  'Gallons_Collected__c, CompletionStatus__c, Driver_Completed__c';

/** Escapes a string for SOQL single-quoted literals. */
function escSoql(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Normalizes route name for history lookup: keep through the word "Route".
 * e.g. "New York Route A-293…" → "New York Route"
 */
function baseRouteName(name) {
  if (!name) return '';
  const match = String(name).match(/^(.+\broute)\b/i);
  return (match ? match[1] : String(name)).trim();
}

/** Reads child stops whether Routes__r is an array or { records: [] }. */
function getStops(route) {
  const r = route?.Routes__r;
  if (!r) return route?.points ?? [];
  if (Array.isArray(r)) return r;
  return r.records ?? [];
}

function acctId(stop) {
  return stop.AccountId__c || stop.Account__c || null;
}

function acctName(stop) {
  return stop.Account_Name__c || stop.Name || acctId(stop);
}

/** Headline metrics for one route record. */
function routeMetrics(route) {
  const stops = getStops(route);
  const gallons = stops.reduce((sum, p) => sum + (parseFloat(p.Gallons_Collected__c) || 0), 0);
  const done = stops.filter((s) => s.Status__c === 'Completed' || s.Status__c === 'Complete').length;
  return {
    stopCount: stops.length,
    distance: route?.Total_Distance__c || '—',
    time: route?.Total_Time__c || '—',
    gallons: gallons ? Math.round(gallons * 10) / 10 : null,
    completion: stops.length ? `${done}/${stops.length}` : '—',
    serviceDate: route?.Service_Date__c || null,
    driver: route?.DriverName__c || null,
  };
}

/**
 * Fetches completed historical routes sharing the same base route name.
 * @param {{ routeName: string, excludeId?: string, search?: string, date?: string, limit?: number }}
 */
async function fetchCompletedRoutesByName({ routeName, excludeId, search, date, limit = 50 }) {
  const where = [COMPLETED_FILTER];

  if (search) {
    where.push(`Name LIKE '%${escSoql(search)}%'`);
  } else if (routeName) {
    const base = baseRouteName(routeName);
    if (base.toLowerCase().includes('route')) {
      where.push(`Name LIKE '${escSoql(base)}%'`);
    } else {
      where.push(`Name = '${escSoql(routeName)}'`);
    }
  }

  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    where.push(`Service_Date__c = ${date}`);
  }
  if (excludeId) where.push(`Id != '${escSoql(excludeId)}'`);

  const soql =
    `SELECT ${ROUTE_FIELDS}, ${STOP_SUBQUERY} ` +
    `FROM Google_Route__c WHERE ${where.join(' AND ')} ` +
    `ORDER BY CreatedDate DESC LIMIT ${Math.min(limit, 50)}`;

  return sf.query(soql);
}

/** Loads current route with stops by Id. */
async function loadCurrentRoute(googleRouteId) {
  const rows = await sf.query(
    `SELECT ${ROUTE_FIELDS}, ${STOP_SUBQUERY} ` +
    `FROM Google_Route__c WHERE Id = '${escSoql(googleRouteId)}' LIMIT 1`,
  );
  return rows[0] || null;
}

/**
 * Builds account → route membership index across current + historical routes.
 * @returns {Map<string, { id: string, name: string, routeKeys: Set<string> }>}
 */
function buildAccountIndex(currentRoute, historicalRoutes) {
  const idx = new Map();
  const all = [{ key: 'current', route: currentRoute }, ...historicalRoutes.map((r, i) => ({ key: `hist_${i}`, route: r }))];

  for (const { key, route } of all) {
    if (!route) continue;
    for (const s of getStops(route)) {
      const id = acctId(s);
      if (!id) continue;
      if (!idx.has(id)) idx.set(id, { id, name: acctName(s), routeKeys: new Set() });
      idx.get(id).routeKeys.add(key);
    }
  }
  return idx;
}

/** Splits accounts into compare sections (mirrors RouteComparePanel). */
function buildCompareSections(accountIndex, historicalCount) {
  const totalRoutes = 1 + historicalCount;
  const inAll = [];
  const onlyCurrent = [];
  const onlyHistorical = [];
  const partial = [];

  for (const a of accountIndex.values()) {
    const onCurrent = a.routeKeys.has('current');
    const histCount = [...a.routeKeys].filter((k) => k.startsWith('hist_')).length;

    if (a.routeKeys.size === totalRoutes) inAll.push(a);
    else if (onCurrent && histCount === 0) onlyCurrent.push(a);
    else if (!onCurrent && histCount > 0) onlyHistorical.push(a);
    else partial.push(a);
  }

  const byName = (x, y) => x.name.localeCompare(y.name);
  return {
    inAll: inAll.sort(byName),
    onlyCurrent: onlyCurrent.sort(byName),
    onlyHistorical: onlyHistorical.sort(byName),
    partial: partial.sort(byName),
  };
}

/** Computes trend stats and add/remove candidates from historical runs. */
function buildHistoricalInsights(currentRoute, historicalRoutes, sections) {
  const currentMetrics = routeMetrics(currentRoute);
  const histMetrics = historicalRoutes.map(routeMetrics);

  const stopCounts = histMetrics.map((m) => m.stopCount).filter((n) => n > 0);
  const gallons = histMetrics.map((m) => m.gallons).filter((g) => g != null);

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const missingFromCurrent = sections.onlyHistorical.slice(0, 25).map((a) => ({
    accountId: a.id,
    accountName: a.name,
    historicalAppearances: a.routeKeys.size,
    signal: 'frequent_on_past_runs',
  }));

  const rareOnCurrent = sections.onlyCurrent.slice(0, 15).map((a) => ({
    accountId: a.id,
    accountName: a.name,
    signal: 'not_on_historical_runs',
  }));

  return {
    historicalRouteCount: historicalRoutes.length,
    trends: {
      avgStopCount: avg(stopCounts) != null ? Math.round(avg(stopCounts) * 10) / 10 : null,
      minStopCount: stopCounts.length ? Math.min(...stopCounts) : null,
      maxStopCount: stopCounts.length ? Math.max(...stopCounts) : null,
      currentStopCount: currentMetrics.stopCount,
      avgGallons: avg(gallons) != null ? Math.round(avg(gallons) * 10) / 10 : null,
      currentGallons: currentMetrics.gallons,
    },
    addCandidates: missingFromCurrent,
    removeCandidates: rareOnCurrent,
    stableStops: sections.inAll.slice(0, 30).map((a) => ({ accountId: a.id, accountName: a.name })),
  };
}

/** Slim payload for LLM / prefetch bundle. */
function summarizeForAI({ currentRoute, historicalRoutes, sections, insights }) {
  return {
    currentRoute: {
      id: currentRoute.Id,
      name: currentRoute.Name,
      baseName: baseRouteName(currentRoute.Name),
      metrics: routeMetrics(currentRoute),
    },
    historicalRoutes: historicalRoutes.slice(0, 10).map((r) => ({
      id: r.Id,
      name: r.Name,
      serviceDate: r.Service_Date__c,
      metrics: routeMetrics(r),
    })),
    sections: {
      inAll: sections.inAll.length,
      onlyCurrent: sections.onlyCurrent.length,
      onlyHistorical: sections.onlyHistorical.length,
      partial: sections.partial.length,
    },
    insights,
  };
}

/**
 * Full compare analysis for a route (used by skill, enhance pipeline, prefetch).
 * @param {{ googleRouteId: string, routeName?: string, limit?: number }}
 */
async function analyzeRouteCompare({ googleRouteId, routeName, limit = 20 }) {
  const currentRoute = await loadCurrentRoute(googleRouteId);
  if (!currentRoute) return { error: 'Google Route not found' };

  const name = routeName || currentRoute.Name;
  const historicalRoutes = await fetchCompletedRoutesByName({
    routeName: name,
    excludeId: googleRouteId,
    limit,
  });

  const accountIndex = buildAccountIndex(currentRoute, historicalRoutes);
  const sections = buildCompareSections(accountIndex, historicalRoutes.length);
  const insights = buildHistoricalInsights(currentRoute, historicalRoutes, sections);

  return summarizeForAI({ currentRoute, historicalRoutes, sections, insights });
}

module.exports = {
  COMPLETED_FILTER,
  baseRouteName,
  fetchCompletedRoutesByName,
  loadCurrentRoute,
  getStops,
  routeMetrics,
  buildAccountIndex,
  buildCompareSections,
  buildHistoricalInsights,
  summarizeForAI,
  analyzeRouteCompare,
};
