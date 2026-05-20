/**
 * Module 2: Route Optimization Engine.
 * Integrates TSP solver + distance matrix to determine optimal stop ordering.
 * Respects fixed-point constraints and supports edge penalty weights.
 */

const tspSolver = require('./tspSolver');
const { buildMatrix, checkTraffic } = require('./distanceMatrix');
const sf = require('../services/salesforce');
const logger = require('../utils/logger');

class RouteOptimizer {
  /**
   * Optimize the ordering of stops on a route.
   * @param {Object} opts
   * @param {Array<Object>} opts.stops - stops with { accountId, lat, lng, isFixed, ... }
   * @param {{ lat: number, lng: number }} opts.startLocation - depot start
   * @param {{ lat: number, lng: number }} opts.endLocation - depot end
   * @param {Object} [opts.penalties] - edge penalty map ("i,j" → multiplier)
   * @param {string} [opts.strategy='haversine'] - 'haversine' | 'osrm' | 'google' | 'combined'
   * @param {string} [opts.osrmUrl] - OSRM server URL (for 'osrm' or 'combined')
   * @param {string} [opts.googleApiKey] - Google Maps API key (for 'google' or 'combined')
   * @returns {Promise<{ orderedStops: Object[], totalDistance: number, improvement: string, traffic?: Object }>}
   */
  async optimize({ stops, startLocation, endLocation, penalties, strategy = 'haversine', osrmUrl, googleApiKey }) {
    if (!stops || stops.length === 0) {
      return { orderedStops: [], totalDistance: 0, improvement: 'N/A' };
    }

    const validStops = stops.filter((s) => s.lat != null && s.lng != null);
    if (validStops.length === 0) {
      return { orderedStops: stops, totalDistance: 0, improvement: 'No coordinates available' };
    }

    // Build point list: [startLocation, ...stops, endLocation]
    const points = [];
    const startIdx = 0;
    points.push({ lat: startLocation.lat, lng: startLocation.lng });

    const stopStartIdx = points.length;
    validStops.forEach((s) => points.push({ lat: s.lat, lng: s.lng }));

    const endIdx = points.length;
    points.push({ lat: endLocation.lat, lng: endLocation.lng });

    // Map fixed-point stops to their indices in the points array
    const fixedIndices = [];
    validStops.forEach((s, i) => {
      if (s.isFixed) fixedIndices.push(stopStartIdx + i);
    });

    const distanceMatrix = await buildMatrix(points, { strategy, osrmUrl, googleApiKey, penalties });

    const originalDistance = this._sequentialDistance(distanceMatrix, startIdx, stopStartIdx, validStops.length, endIdx);

    const result = tspSolver.solve({
      distanceMatrix,
      startIdx,
      endIdx,
      fixedIndices,
    });

    // Map tour indices back to stop objects (exclude start/end depot)
    const orderedStops = result.tour
      .filter((idx) => idx !== startIdx && idx !== endIdx)
      .map((idx) => validStops[idx - stopStartIdx]);

    const pctImprovement = originalDistance > 0
      ? Math.round((1 - result.totalDistance / originalDistance) * 100)
      : 0;

    logger.info('[RouteOptimizer] optimization complete', {
      stopCount: validStops.length,
      originalDist: Math.round(originalDistance * 100) / 100,
      optimizedDist: Math.round(result.totalDistance * 100) / 100,
      improvement: `${pctImprovement}%`,
    });

    // Combined strategy: validate final route against live traffic via Google
    let traffic = null;
    if (strategy === 'combined' && googleApiKey) {
      const orderedPoints = [
        startLocation,
        ...orderedStops.map((s) => ({ lat: s.lat, lng: s.lng })),
        endLocation,
      ];
      traffic = await checkTraffic(orderedPoints, googleApiKey);
    }

    return {
      orderedStops,
      totalDistance: Math.round(result.totalDistance * 100) / 100,
      originalDistance: Math.round(originalDistance * 100) / 100,
      improvement: `${pctImprovement}%`,
      ...(traffic && { traffic }),
    };
  }

  /**
   * Optimize an existing Salesforce route in-place.
   * Loads stops, runs TSP, updates Priority__c on each Route__c.
   * @param {string} googleRouteId
   * @param {Object} [opts] - strategy options forwarded to optimize()
   * @returns {Promise<Object>}
   */
  async optimizeExistingRoute(googleRouteId, opts = {}) {
    const conn = await sf.getConnection();

    const routeResult = await conn.query(`
      SELECT Id, Service_Location_Start__c, Service_Location_End__c
      FROM Google_Route__c WHERE Id = '${googleRouteId}'
    `);
    if (!routeResult.records.length) throw new Error('Route not found');
    const gRoute = routeResult.records[0];

    const locIds = [gRoute.Service_Location_Start__c, gRoute.Service_Location_End__c].filter(Boolean);
    let startLoc = null;
    let endLoc = null;
    if (locIds.length > 0) {
      const locResult = await conn.query(
        `SELECT Id, Latitude__c, Longitude__c FROM Service_Location__c WHERE Id IN ('${locIds.join("','")}')`
      );
      const locMap = {};
      locResult.records.forEach((l) => { locMap[l.Id] = { lat: l.Latitude__c, lng: l.Longitude__c }; });
      startLoc = locMap[gRoute.Service_Location_Start__c];
      endLoc = locMap[gRoute.Service_Location_End__c];
    }
    if (!startLoc || !endLoc) throw new Error('Service locations with coordinates are required');

    const stopsResult = await conn.query(`
      SELECT Id, AccountId__c, Account_Name__c, Latitude__c, Longitude__c,
             Fixed_point__c, Priority__c, Driver_Notes__c
      FROM Route__c
      WHERE Google_Route_Id__c = '${googleRouteId}' AND AccountId__c != null
      ORDER BY Priority__c ASC
    `);

    const stops = stopsResult.records.map((s) => ({
      id: s.Id,
      accountId: s.AccountId__c,
      accountName: s.Account_Name__c,
      lat: s.Latitude__c,
      lng: s.Longitude__c,
      isFixed: s.Fixed_point__c || false,
      originalPriority: s.Priority__c,
    }));

    const result = await this.optimize({
      stops,
      startLocation: startLoc,
      endLocation: endLoc,
      ...opts,
    });

    // Update Priority__c based on new order
    const updates = result.orderedStops.map((s, i) => ({
      Id: s.id,
      Priority__c: i + 1,
    }));

    if (updates.length > 0) {
      await conn.sobject('Route__c').update(updates);
      logger.info('[RouteOptimizer] updated stop priorities', { routeId: googleRouteId, count: updates.length });
    }

    return {
      routeId: googleRouteId,
      stopCount: stops.length,
      totalDistance: result.totalDistance,
      originalDistance: result.originalDistance,
      improvement: result.improvement,
      orderedStops: result.orderedStops.map((s, i) => ({ ...s, newPriority: i + 1 })),
      ...(result.traffic && { traffic: result.traffic }),
    };
  }

  /** Calculate distance of stops in their current sequential order. */
  _sequentialDistance(matrix, startIdx, stopStart, stopCount, endIdx) {
    let total = 0;
    let prev = startIdx;
    for (let i = 0; i < stopCount; i++) {
      total += matrix[prev][stopStart + i];
      prev = stopStart + i;
    }
    total += matrix[prev][endIdx];
    return total;
  }
}

module.exports = new RouteOptimizer();
