/**
 * Distance matrix builder with pluggable strategies.
 * - Haversine: free, zero API calls (default)
 * - OSRM: free, self-hosted, road-accurate distances
 * - Google: paid, real road distances with live traffic
 * - Combined (OSRM + Google): OSRM for bulk NxN matrix, Google for traffic validation
 */

const logger = require('../utils/logger');

const EARTH_RADIUS_MILES = 3958.8;
const METERS_TO_MILES = 0.000621371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in miles between two {lat, lng} points. */
function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/**
 * Build an NxN distance matrix from an array of {lat, lng} points.
 * @param {Array<{lat: number, lng: number}>} points
 * @param {Object} [opts]
 * @param {string} [opts.strategy='haversine'] - 'haversine' | 'osrm' | 'google' | 'combined'
 * @param {string} [opts.osrmUrl] - OSRM server URL (required for 'osrm' and 'combined')
 * @param {string} [opts.googleApiKey] - Google Maps API key (required for 'google' and 'combined')
 * @param {Object} [opts.penalties] - map of "i,j" → multiplier for edge penalties
 * @returns {Promise<number[][]>} NxN distance matrix in miles
 */
async function buildMatrix(points, opts = {}) {
  const { strategy = 'haversine', penalties } = opts;

  let matrix;
  switch (strategy) {
    case 'osrm':
      matrix = await buildOSRMMatrix(points, opts.osrmUrl);
      break;
    case 'google':
      matrix = await buildGoogleMatrix(points, opts.googleApiKey);
      break;
    case 'combined':
      matrix = await buildOSRMMatrix(points, opts.osrmUrl);
      break;
    default:
      matrix = buildHaversineMatrix(points);
  }

  if (penalties) {
    applyPenalties(matrix, penalties);
  }

  return matrix;
}

/** Build matrix using straight-line (Haversine) distances. O(n^2), no API calls. */
function buildHaversineMatrix(points) {
  const n = points.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversine(points[i], points[j]);
      matrix[i][j] = d;
      matrix[j][i] = d;
    }
  }

  return matrix;
}

/** Build matrix using OSRM /table endpoint. Free, self-hosted, road-accurate. */
async function buildOSRMMatrix(points, osrmUrl) {
  if (!osrmUrl) {
    logger.warn('[distanceMatrix] No OSRM URL configured, falling back to haversine');
    return buildHaversineMatrix(points);
  }

  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const url = `${osrmUrl}/table/v1/driving/${coords}?annotations=distance`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (data.code !== 'Ok') {
      throw new Error(`OSRM error: ${data.code} — ${data.message || ''}`);
    }

    logger.info('[distanceMatrix] OSRM matrix built', { points: points.length });
    return data.distances.map((row) => row.map((d) => d * METERS_TO_MILES));
  } catch (err) {
    logger.error('[distanceMatrix] OSRM failed, falling back to haversine:', err.message);
    return buildHaversineMatrix(points);
  }
}

/**
 * Build matrix using Google Distance Matrix API. Paid, supports live traffic.
 * Handles the 25-origin/25-destination limit by chunking.
 */
async function buildGoogleMatrix(points, apiKey) {
  if (!apiKey) {
    logger.warn('[distanceMatrix] No Google API key configured, falling back to haversine');
    return buildHaversineMatrix(points);
  }

  const n = points.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const CHUNK = 25; // Google limits 25 origins × 25 destinations per request

  try {
    const chunks = [];
    for (let oi = 0; oi < n; oi += CHUNK) {
      for (let di = 0; di < n; di += CHUNK) {
        chunks.push({ oi, di, oEnd: Math.min(oi + CHUNK, n), dEnd: Math.min(di + CHUNK, n) });
      }
    }

    for (const { oi, di, oEnd, dEnd } of chunks) {
      const origins = points.slice(oi, oEnd).map((p) => `${p.lat},${p.lng}`).join('|');
      const destinations = points.slice(di, dEnd).map((p) => `${p.lat},${p.lng}`).join('|');
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${destinations}&units=imperial&departure_time=now&key=${apiKey}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'OK') {
        throw new Error(`Google Distance Matrix error: ${data.status} — ${data.error_message || ''}`);
      }

      for (let r = 0; r < data.rows.length; r++) {
        for (let c = 0; c < data.rows[r].elements.length; c++) {
          const el = data.rows[r].elements[c];
          if (el.status === 'OK') {
            // distance.value is in meters
            matrix[oi + r][di + c] = el.distance.value * METERS_TO_MILES;
          } else {
            // Unreachable — use haversine fallback for this pair
            matrix[oi + r][di + c] = haversine(points[oi + r], points[di + c]);
          }
        }
      }
    }

    logger.info('[distanceMatrix] Google matrix built', { points: n, chunks: chunks.length });
    return matrix;
  } catch (err) {
    logger.error('[distanceMatrix] Google failed, falling back to haversine:', err.message);
    return buildHaversineMatrix(points);
  }
}

/**
 * Check a final ordered route for traffic issues using Google Directions API.
 * Used in 'combined' strategy AFTER TSP solving — validates the chosen order
 * and flags legs with heavy traffic, road closures, or significant detours.
 * @param {Array<{lat: number, lng: number}>} orderedPoints - the final tour in order
 * @param {string} apiKey - Google Maps API key
 * @returns {Promise<Object>} { totalDuration, totalDistance, legs[], warnings[] }
 */
async function checkTraffic(orderedPoints, apiKey) {
  if (!apiKey || orderedPoints.length < 2) {
    return { totalDuration: null, totalDistance: null, legs: [], warnings: [] };
  }

  const origin = `${orderedPoints[0].lat},${orderedPoints[0].lng}`;
  const dest = `${orderedPoints[orderedPoints.length - 1].lat},${orderedPoints[orderedPoints.length - 1].lng}`;

  // Google Directions supports max 25 waypoints; chunk if needed
  const intermediates = orderedPoints.slice(1, -1);
  const WAYPOINT_LIMIT = 25;
  const warnings = [];
  let totalDuration = 0;
  let totalDistance = 0;
  const allLegs = [];

  for (let i = 0; i < Math.max(1, intermediates.length); i += WAYPOINT_LIMIT) {
    const chunk = intermediates.slice(i, i + WAYPOINT_LIMIT);
    const chunkOrigin = i === 0 ? origin : `${intermediates[i - 1].lat},${intermediates[i - 1].lng}`;
    const chunkDest = (i + WAYPOINT_LIMIT >= intermediates.length)
      ? dest
      : `${intermediates[i + WAYPOINT_LIMIT].lat},${intermediates[i + WAYPOINT_LIMIT].lng}`;

    const waypoints = chunk.map((p) => `${p.lat},${p.lng}`).join('|');
    let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${chunkOrigin}&destination=${chunkDest}&departure_time=now&key=${apiKey}`;
    if (waypoints) url += `&waypoints=${waypoints}`;

    try {
      const response = await fetch(url);
      const data = await response.json();

      if (data.status !== 'OK') {
        warnings.push(`Directions API error: ${data.status}`);
        continue;
      }

      const route = data.routes[0];
      if (route.warnings?.length) warnings.push(...route.warnings);

      for (const leg of route.legs) {
        const legMiles = leg.distance.value * METERS_TO_MILES;
        totalDistance += legMiles;
        totalDuration += leg.duration_in_traffic?.value || leg.duration.value;

        // Flag legs where traffic adds >50% to normal travel time
        const normal = leg.duration.value;
        const inTraffic = leg.duration_in_traffic?.value;
        if (inTraffic && inTraffic > normal * 1.5) {
          warnings.push(
            `Heavy traffic: ${leg.start_address} → ${leg.end_address} — ` +
            `normal ${Math.round(normal / 60)} min, with traffic ${Math.round(inTraffic / 60)} min`
          );
        }

        allLegs.push({
          from: leg.start_address,
          to: leg.end_address,
          distance: Math.round(legMiles * 100) / 100,
          durationMin: Math.round((leg.duration.value) / 60),
          durationInTrafficMin: inTraffic ? Math.round(inTraffic / 60) : null,
          trafficRatio: inTraffic ? Math.round((inTraffic / normal) * 100) / 100 : null,
        });
      }
    } catch (err) {
      warnings.push(`Traffic check failed: ${err.message}`);
    }
  }

  logger.info('[distanceMatrix] traffic check complete', {
    legs: allLegs.length,
    warnings: warnings.length,
    totalMin: Math.round(totalDuration / 60),
  });

  return {
    totalDuration: Math.round(totalDuration / 60),
    totalDistance: Math.round(totalDistance * 100) / 100,
    legs: allLegs,
    warnings,
  };
}

/**
 * Apply penalty multipliers to specific edges in the matrix.
 * @param {number[][]} matrix - mutated in place
 * @param {Object} penalties - map of "i,j" → multiplier (e.g. 2.0 = double the distance)
 */
function applyPenalties(matrix, penalties) {
  for (const [key, multiplier] of Object.entries(penalties)) {
    const [i, j] = key.split(',').map(Number);
    if (matrix[i]?.[j] != null) {
      matrix[i][j] *= multiplier;
      matrix[j][i] *= multiplier;
    }
  }
}

module.exports = { buildMatrix, buildHaversineMatrix, buildGoogleMatrix, checkTraffic, haversine };
