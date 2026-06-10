const BaseSkill = require('./base');
const sf = require('../services/salesforce');

/** Loads an existing route and finds candidate accounts to add based on proximity and service schedule. */
class RouteEnhancementSkill extends BaseSkill {
  constructor() {
    super({
      name: 'route_enhancement',
      description:
        'Load an existing Google_Route__c with its stops and find nearby accounts that could be added. ' +
        'Returns the route details, current stops with coordinates, and scored candidate accounts.',
      inputSchema: {
        type: 'object',
        properties: {
          googleRouteId: {
            type: 'string',
            description: 'The Salesforce Id of the Google_Route__c to enhance.',
          },
          targetDate: {
            type: 'string',
            description: 'Target date for filtering eligible accounts (YYYY-MM-DD). Defaults to the route service date.',
          },
          radiusMiles: {
            type: 'number',
            description: 'Search radius in miles around the route path. Default 15.',
          },
        },
        required: ['googleRouteId'],
      },
    });
  }

  async execute({ googleRouteId, targetDate, radiusMiles = 15 }) {
    const routes = await sf.query(
      `SELECT Id, Name, Service_Date__c, Miles__c, Minutes__c, Accounts__c, ` +
      `Waypoints__c, Shape__c, Service_Location_Start__c, Service_Location_End__c, ` +
      `(SELECT Id, AccountId__c, Account_Name__c, Latitude__c, Longitude__c, ` +
      `Priority__c, ServiceType__c, Status__c FROM Routes__r ORDER BY Priority__c ASC) ` +
      `FROM Google_Route__c WHERE Id = '${googleRouteId}'`
    );

    if (routes.length === 0) {
      return { error: 'Google Route not found' };
    }

    const route = routes[0];
    const stops = route.Routes__r?.records || [];
    const serviceDate = targetDate || route.Service_Date__c;
    const existingAccountIds = new Set(stops.map((s) => s.AccountId__c).filter(Boolean));

    const centroid = this._computeCentroid(stops);
    if (!centroid) {
      return { route: this._formatRoute(route, stops), candidates: [], message: 'No stops with coordinates found' };
    }

    const alreadyRouted = await sf.query(
      `SELECT AccountId__c FROM Route__c ` +
      `WHERE DateOfService__c = ${serviceDate} AND AccountId__c != null AND Status__c != 'Complete'`
    );
    const routedIds = new Set(alreadyRouted.map((r) => r.AccountId__c));

    const candidates = await sf.query(
      `SELECT Id, Name, ShippingStreet, ShippingCity, ShippingState, ` +
      `MALatitude__c, MALongitude__c, Last_Service_Date__c, Expected_Date_Of_Service__c, ` +
      `Pickup_Frequency_in_Days__c, Route_Notes__c, Notes__c, Shape_Name__c, ` +
      `(SELECT Id, Type, Status FROM Cases WHERE Status = 'Open' AND Type = 'UCO Collection' LIMIT 3) ` +
      `FROM Account ` +
      `WHERE Ignore_For_Routing__c = false AND Account_Status__c = 'Active' ` +
      `AND MALatitude__c != null AND MALongitude__c != null ` +
      `AND (Expected_Date_Of_Service__c <= ${serviceDate} OR Expected_Date_Of_Service__c = null) ` +
      `ORDER BY Expected_Date_Of_Service__c ASC NULLS LAST LIMIT 1000`
    );

    const scored = candidates
      .filter((a) => !existingAccountIds.has(a.Id) && !routedIds.has(a.Id))
      .map((a) => {
        const dist = this._haversine(centroid, { lat: a.MALatitude__c, lng: a.MALongitude__c });
        return { ...a, distanceFromRoute: Math.round(dist * 100) / 100, hasOpenTicket: (a.Cases?.records?.length || 0) > 0 };
      })
      .filter((a) => a.distanceFromRoute <= radiusMiles)
      .sort((a, b) => {
        if (a.hasOpenTicket !== b.hasOpenTicket) return a.hasOpenTicket ? -1 : 1;
        return a.distanceFromRoute - b.distanceFromRoute;
      });

    return {
      route: this._formatRoute(route, stops),
      candidateCount: scored.length,
      candidates: scored.slice(0, 50).map((a) => ({
        Id: a.Id,
        Name: a.Name,
        address: `${a.ShippingStreet || ''} ${a.ShippingCity || ''} ${a.ShippingState || ''}`.trim(),
        MALatitude__c: a.MALatitude__c,
        MALongitude__c: a.MALongitude__c,
        distanceFromRoute: a.distanceFromRoute,
        hasOpenTicket: a.hasOpenTicket,
        Last_Service_Date__c: a.Last_Service_Date__c,
        Expected_Date_Of_Service__c: a.Expected_Date_Of_Service__c,
        Route_Notes__c: a.Route_Notes__c,
        Notes__c: a.Notes__c,
      })),
    };
  }

  _formatRoute(route, stops) {
    return {
      Id: route.Id,
      Name: route.Name,
      Service_Date__c: route.Service_Date__c,
      Miles__c: route.Miles__c,
      Minutes__c: route.Minutes__c,
      stopCount: stops.length,
      stops: stops.map((s) => ({
        Id: s.Id,
        AccountId__c: s.AccountId__c,
        Account_Name__c: s.Account_Name__c,
        Latitude__c: s.Latitude__c,
        Longitude__c: s.Longitude__c,
        Priority__c: s.Priority__c,
      })),
    };
  }

  _computeCentroid(stops) {
    const valid = stops.filter((s) => s.Latitude__c && s.Longitude__c);
    if (valid.length === 0) return null;
    const lat = valid.reduce((sum, s) => sum + s.Latitude__c, 0) / valid.length;
    const lng = valid.reduce((sum, s) => sum + s.Longitude__c, 0) / valid.length;
    return { lat, lng };
  }

  _haversine(a, b) {
    const R = 3958.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
}

module.exports = RouteEnhancementSkill;
