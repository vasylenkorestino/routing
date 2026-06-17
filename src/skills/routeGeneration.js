const BaseSkill = require('./base');
const sf = require('../services/salesforce');
const { optimizeGoogleRoute } = require('../services/sfRoutingApi');
const logger = require('../utils/logger');

/** Creates Google_Route__c + Route__c records in Salesforce, marked as AI-generated. */
class RouteGenerationSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_generation',
      description:
        'Create new routes in Salesforce. Accepts a list of route definitions, each with a name, ' +
        'service date, record type, service location (depot), and ordered list of account IDs. ' +
        'Creates Google_Route__c (header) and Route__c (stops) records with isAI__c = true and isInherit__c = true. ' +
        'The service location is the start and end point for the route.',
      inputSchema: {
        type: 'object',
        properties: {
          routes: {
            type: 'array',
            description: 'Array of route definitions to create.',
            items: {
              type: 'object',
              properties: {
                routeName: { type: 'string', description: 'Name for the Google_Route__c.' },
                serviceDate: { type: 'string', description: 'Service date (YYYY-MM-DD).' },
                recordTypeName: { type: 'string', description: 'Record type name (e.g. "EZG").' },
                serviceLocationId: {
                  type: 'string',
                  description: 'Service_Location__c Id used for both start and end when start/end are not set separately.',
                },
                serviceLocationStartId: {
                  type: 'string',
                  description: 'Service_Location__c Id for Service_Location_Start__c (yard departure).',
                },
                serviceLocationEndId: {
                  type: 'string',
                  description: 'Service_Location__c Id for Service_Location_End__c (yard return).',
                },
                sourceRouteId: {
                  type: 'string',
                  description: 'Optional Google_Route__c Id to copy start/end yards from when rebuilding a route.',
                },
                accountIds: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Ordered list of Account IDs for route stops.',
                },
              },
              required: ['routeName', 'serviceDate', 'recordTypeName', 'accountIds'],
            },
          },
        },
        required: ['routes'],
      },
    });
  }

  async execute({ routes }) {
    if (!routes || routes.length === 0) {
      return { created: 0, googleRoutes: [] };
    }

    const rtMap = await this._getRecordTypeMap();

    const allAccountIds = new Set();
    for (const r of routes) {
      for (const id of r.accountIds) allAccountIds.add(id);
    }

    const accountMap = await this._getAccountMap([...allAccountIds]);
    const resolvedRoutes = await this._resolveServiceLocations(routes, accountMap);

    const googleRoutes = resolvedRoutes.map((r) => ({
      Name: r.routeName,
      Service_Date__c: r.serviceDate,
      RecordTypeId: rtMap.googleRoute[r.recordTypeName],
      Service_Location_Start__c: r.serviceLocationStartId || null,
      Service_Location_End__c: r.serviceLocationEndId || null,
      isAI__c: true,
      isAIApproved__c: false,
      isInherit__c: true,
      Custom_Route__c: false,
      Accounts__c: r.accountIds.join(','),
    }));

    const grResults = await sf.insert('Google_Route__c', googleRoutes);

    const routeStopGroups = resolvedRoutes.map(() => []);
    const routePoints = [];
    for (let i = 0; i < resolvedRoutes.length; i++) {
      const grResult = grResults[i];
      if (!grResult.success) continue;

      const routeDef = resolvedRoutes[i];
      let priority = 1;

      for (const accountId of routeDef.accountIds) {
        const acct = accountMap[accountId];
        if (!acct) continue;

        const point = {
          AccountId__c: acct.Id,
          Account_Name__c: acct.Name,
          RecordTypeId: rtMap.route[routeDef.recordTypeName],
          DateOfService__c: routeDef.serviceDate,
          Container_Address__c: [acct.ShippingStreet, acct.ShippingCity, acct.ShippingState, acct.ShippingCountry]
            .filter(Boolean).join(', '),
          Name: routeDef.routeName,
          Google_Route_Id__c: grResult.id,
          GRoute_Id__c: grResult.id,
          Latitude__c: acct.MALatitude__c,
          Longitude__c: acct.MALongitude__c,
          Status__c: 'New',
          Priority__c: priority,
          isAI__c: true,
          isAIApproved__c: false,
          ServiceType__c: acct.Rotisserie_Collection__c ? 'Rotisserie Water' : 'UCO Collection',
        };

        if (acct.Services__r?.records?.[0]) {
          point.LastGallonsCollected__c = acct.Services__r.records[0].Qty_Gallons__c;
        }

        routeStopGroups[i].push(routePoints.length);
        routePoints.push(point);
        priority++;
      }
    }

    let pointResults = [];
    if (routePoints.length > 0) {
      pointResults = await sf.insert('Route__c', routePoints);
    }

    const optimizedRoutes = [];
    for (let i = 0; i < resolvedRoutes.length; i++) {
      const grResult = grResults[i];
      if (!grResult.success) continue;

      const routeDef = resolvedRoutes[i];
      const stopPayload = routeStopGroups[i]
        .map((insertIndex, idx) => {
          const insertResult = pointResults[insertIndex];
          if (!insertResult?.success) return null;
          const sourcePoint = routePoints[insertIndex];
          return {
            Id: insertResult.id,
            AccountId__c: sourcePoint.AccountId__c,
            Fixed_point__c: false,
            Priority__c: idx + 1,
            Google_Route_Id__c: grResult.id,
            GRoute_Id__c: grResult.id,
          };
        })
        .filter(Boolean);

      const optimized = await this._optimizeCreatedRoute(routeDef, grResult.id, stopPayload);
      optimizedRoutes.push({ routeId: grResult.id, optimized });
    }

    const createdRoutes = grResults
      .filter((r) => r.success)
      .map((r, idx) => ({
        id: r.id,
        name: resolvedRoutes[idx].routeName,
        serviceDate: resolvedRoutes[idx].serviceDate,
        stopCount: resolvedRoutes[idx].accountIds.length,
        serviceLocationStartId: resolvedRoutes[idx].serviceLocationStartId,
        serviceLocationEndId: resolvedRoutes[idx].serviceLocationEndId,
        optimized: optimizedRoutes.find((o) => o.routeId === r.id)?.optimized ?? false,
      }));

    return {
      created: createdRoutes.length,
      googleRoutes: createdRoutes,
      totalStops: pointResults.filter((r) => r.success).length,
    };
  }

  /** Runs Apex optimize-route for a newly created Google route. */
  async _optimizeCreatedRoute(routeDef, googleRouteId, routePoints) {
    if (!routePoints.length) return false;
    if (!routeDef.serviceLocationStartId || !routeDef.serviceLocationEndId) {
      logger.warn('[route_generation] skipping optimize — service locations missing', { googleRouteId });
      return false;
    }

    try {
      await optimizeGoogleRoute(
        {
          Id: googleRouteId,
          Driver__c: null,
          Service_Location_Start__c: routeDef.serviceLocationStartId,
          Service_Location_End__c: routeDef.serviceLocationEndId,
        },
        routePoints,
      );
      logger.info('[route_generation] route optimized', { googleRouteId, stopCount: routePoints.length });
      return true;
    } catch (err) {
      logger.warn('[route_generation] optimize failed', { googleRouteId, error: err.message });
      return false;
    }
  }

  /** Fills Service_Location_Start__c / Service_Location_End__c when the AI omits them. */
  async _resolveServiceLocations(routes, accountMap) {
    const sourceRouteIds = [...new Set(routes.map((r) => r.sourceRouteId).filter(Boolean))];
    const sourceRouteMap = await this._getSourceRouteLocations(sourceRouteIds);

    const recordTypes = [...new Set(routes.map((r) => r.recordTypeName).filter(Boolean))];
    const depotsByRecordType = {};
    for (const rt of recordTypes) {
      depotsByRecordType[rt] = await this._getDepots(rt);
    }

    return routes.map((r) => {
      let startId = r.serviceLocationStartId || r.serviceLocationId || null;
      let endId = r.serviceLocationEndId || r.serviceLocationId || null;

      if (r.sourceRouteId) {
        const src = sourceRouteMap[r.sourceRouteId];
        if (src) {
          startId = startId || src.Service_Location_Start__c;
          endId = endId || src.Service_Location_End__c;
        }
      }

      if (!startId || !endId) {
        const inferred = this._majorityAccountDepot(r.accountIds, accountMap);
        startId = startId || inferred;
        endId = endId || inferred;
      }

      if (!startId || !endId) {
        const nearest = this._nearestDepot(r.accountIds, accountMap, depotsByRecordType[r.recordTypeName] || []);
        startId = startId || nearest;
        endId = endId || nearest;
      }

      return { ...r, serviceLocationStartId: startId, serviceLocationEndId: endId };
    });
  }

  async _getSourceRouteLocations(routeIds) {
    if (routeIds.length === 0) return {};
    const idList = routeIds.map((id) => `'${id}'`).join(',');
    const rows = await sf.query(
      `SELECT Id, Service_Location_Start__c, Service_Location_End__c ` +
      `FROM Google_Route__c WHERE Id IN (${idList})`,
    );
    const map = {};
    for (const row of rows) map[row.Id] = row;
    return map;
  }

  async _getDepots(recordTypeName) {
    const filter = recordTypeName
      ? `AND RecordType.Name = '${String(recordTypeName).replace(/'/g, "\\'")}' `
      : '';
    return sf.query(
      `SELECT Id, Name, Latitude__c, Longitude__c ` +
      `FROM Service_Location__c WHERE Temporary__c = false ${filter}ORDER BY Name`,
    );
  }

  /** Picks the most common account depot among route stops. */
  _majorityAccountDepot(accountIds, accountMap) {
    const counts = {};
    for (const id of accountIds || []) {
      const depotId = accountMap[id]?.RelatedServiceLocation__c;
      if (!depotId) continue;
      counts[depotId] = (counts[depotId] || 0) + 1;
    }
    let best = null;
    let bestCount = 0;
    for (const [depotId, count] of Object.entries(counts)) {
      if (count > bestCount) {
        best = depotId;
        bestCount = count;
      }
    }
    return best;
  }

  /** Finds the depot closest to the geographic center of the route accounts. */
  _nearestDepot(accountIds, accountMap, depots) {
    if (!depots.length) return null;
    const coords = (accountIds || [])
      .map((id) => accountMap[id])
      .filter((a) => typeof a?.MALatitude__c === 'number' && typeof a?.MALongitude__c === 'number')
      .map((a) => ({ lat: a.MALatitude__c, lng: a.MALongitude__c }));
    if (coords.length === 0) return depots[0].Id;

    const centroid = {
      lat: coords.reduce((sum, c) => sum + c.lat, 0) / coords.length,
      lng: coords.reduce((sum, c) => sum + c.lng, 0) / coords.length,
    };

    let nearest = null;
    let nearestDist = Infinity;
    for (const depot of depots) {
      if (typeof depot.Latitude__c !== 'number' || typeof depot.Longitude__c !== 'number') continue;
      const dist = this._haversine(centroid, { lat: depot.Latitude__c, lng: depot.Longitude__c });
      if (dist < nearestDist) {
        nearest = depot.Id;
        nearestDist = dist;
      }
    }
    return nearest || depots[0].Id;
  }

  _haversine(a, b) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async _getRecordTypeMap() {
    const grTypes = await sf.query(
      "SELECT Id, Name FROM RecordType WHERE SobjectType = 'Google_Route__c' AND IsActive = true"
    );
    const rTypes = await sf.query(
      "SELECT Id, Name FROM RecordType WHERE SobjectType = 'Route__c' AND IsActive = true"
    );

    const googleRoute = {};
    const route = {};
    for (const rt of grTypes) googleRoute[rt.Name] = rt.Id;
    for (const rt of rTypes) route[rt.Name] = rt.Id;

    return { googleRoute, route };
  }

  async _getAccountMap(accountIds) {
    if (accountIds.length === 0) return {};

    const idList = accountIds.map((id) => `'${id}'`).join(',');
    const accounts = await sf.query(
      `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ShippingCountry, ` +
      `MALatitude__c, MALongitude__c, RelatedServiceLocation__c, Rotisserie_Collection__c, ` +
      `(SELECT Id, Qty_Gallons__c FROM Services__r WHERE RecordType.Name = 'UCO Collection' ORDER BY CreatedDate DESC LIMIT 1), ` +
      `(SELECT Id, Type, Status FROM Cases WHERE Status = 'Open' ORDER BY CreatedDate DESC LIMIT 3) ` +
      `FROM Account WHERE Id IN (${idList})`
    );

    const map = {};
    for (const a of accounts) map[a.Id] = a;
    return map;
  }
}

module.exports = RouteGenerationSkill;
