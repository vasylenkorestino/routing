const BaseSkill = require('./base');

const EARTH_RADIUS_MILES = 3958.8;

/** Geospatial utilities: distance, clustering, proximity scoring. */
class GeoUtilsSkill extends BaseSkill {
  constructor() {
    super({
      name: 'geo_utils',
      description:
        'Geospatial utilities for route planning. Supports: ' +
        '"haversine" — distance between two lat/lng points (miles). ' +
        '"route_distance" — total distance for an ordered list of stops including depot start/end. ' +
        '"cluster" — group accounts by geographic proximity using simple grid clustering. ' +
        '"proximity" — find accounts within a given radius of a point.',
      inputSchema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['haversine', 'route_distance', 'cluster', 'proximity'],
          },
          params: {
            type: 'object',
            description: 'Operation-specific parameters.',
          },
        },
        required: ['operation', 'params'],
      },
    });
  }

  async execute({ operation, params }) {
    switch (operation) {
      case 'haversine':
        return { distance: haversine(params.from, params.to) };

      case 'route_distance':
        return this._routeDistance(params);

      case 'cluster':
        return this._cluster(params);

      case 'proximity':
        return this._proximity(params);

      default:
        throw new Error(`Unknown geo operation: ${operation}`);
    }
  }

  _routeDistance({ depot, stops }) {
    if (!stops || stops.length === 0) return { totalDistance: 0, legs: [] };

    const points = [];
    if (depot) points.push(depot);
    points.push(...stops);
    if (depot) points.push(depot);

    let total = 0;
    const legs = [];
    for (let i = 1; i < points.length; i++) {
      const d = haversine(points[i - 1], points[i]);
      legs.push({ from: i - 1, to: i, distance: Math.round(d * 100) / 100 });
      total += d;
    }

    return { totalDistance: Math.round(total * 100) / 100, legs };
  }

  _cluster({ accounts, gridSizeMiles = 10 }) {
    const gridSize = gridSizeMiles / 69;
    const buckets = {};

    for (const acct of accounts) {
      const lat = acct.lat || acct.MALatitude__c;
      const lng = acct.lng || acct.MALongitude__c;
      if (lat == null || lng == null) continue;

      const key = `${Math.floor(lat / gridSize)}_${Math.floor(lng / gridSize)}`;
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(acct);
    }

    return {
      clusters: Object.entries(buckets).map(([key, members]) => {
        const centroid = computeCentroid(members);
        return { key, centroid, count: members.length, accountIds: members.map((a) => a.Id || a.id) };
      }),
    };
  }

  _proximity({ center, accounts, radiusMiles }) {
    const results = [];
    for (const acct of accounts) {
      const lat = acct.lat || acct.MALatitude__c;
      const lng = acct.lng || acct.MALongitude__c;
      if (lat == null || lng == null) continue;

      const d = haversine(center, { lat, lng });
      if (d <= radiusMiles) {
        results.push({ ...acct, distanceFromCenter: Math.round(d * 100) / 100 });
      }
    }
    results.sort((a, b) => a.distanceFromCenter - b.distanceFromCenter);
    return { accounts: results };
  }
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Haversine formula — returns distance in miles between two {lat, lng} points. */
function haversine(a, b) {
  const dLat = toRad((b.lat || b.MALatitude__c) - (a.lat || a.MALatitude__c));
  const dLng = toRad((b.lng || b.MALongitude__c) - (a.lng || a.MALongitude__c));
  const lat1 = toRad(a.lat || a.MALatitude__c);
  const lat2 = toRad(b.lat || b.MALatitude__c);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

function computeCentroid(accounts) {
  let sumLat = 0;
  let sumLng = 0;
  let count = 0;
  for (const a of accounts) {
    const lat = a.lat || a.MALatitude__c;
    const lng = a.lng || a.MALongitude__c;
    if (lat != null && lng != null) {
      sumLat += lat;
      sumLng += lng;
      count++;
    }
  }
  return count > 0
    ? { lat: sumLat / count, lng: sumLng / count }
    : { lat: 0, lng: 0 };
}

module.exports = GeoUtilsSkill;
