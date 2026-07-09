import { useEffect, useMemo, useState } from 'react';
import useStore from '../store';
import { slCoord } from '../utils/routeGeometry';
import { getStopStatus, isCompletedStatus } from '../utils/stopStatus';
import {
  SERVICE_TIME_MIN,
  anchorStartMs,
  coordsSignature,
  cumulativeOffsets,
  estimateAllLegSeconds,
  formatClock,
  formatLegDuration,
  formatOffset,
  orderedRouteStops,
  stopCoord,
} from '../utils/routeTimeline';

/** Directions API limit: origin + 23 waypoints + destination per request. */
const CHUNK_SIZE = 23;

/** Module-level caches shared by all hook instances (panel + map layer). */
const legCache = new Map(); // signature -> number[] seconds per leg
const inflight = new Map(); // signature -> Promise<number[]|null>
const LEG_CACHE_CAP = 50;

/** Per-leg drive seconds for one Directions request, or null on failure. */
function requestChunkLegSeconds(origin, destination, waypoints = []) {
  return new Promise((resolve) => {
    if (!window.google?.maps) { resolve(null); return; }
    const ds = new google.maps.DirectionsService();
    const req = { origin, destination, travelMode: google.maps.TravelMode.DRIVING };
    if (waypoints.length > 0) {
      req.waypoints = waypoints.map((w) => ({ location: w, stopover: true }));
    }
    ds.route(req, (result, status) => {
      const legs = status === 'OK' ? result?.routes?.[0]?.legs : null;
      resolve(legs?.length ? legs.map((l) => l.duration?.value ?? 0) : null);
    });
  });
}

/** Chunked Directions fetch of all leg durations for an ordered point list. */
async function fetchLegSeconds(coords) {
  if (coords.length < 2) return [];
  const chunks = [];
  for (let i = 0; i < coords.length - 1; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE + 1, coords.length);
    chunks.push(requestChunkLegSeconds(coords[i], coords[end - 1], coords.slice(i + 1, end - 1)));
  }
  const results = await Promise.all(chunks);
  if (results.some((r) => r === null)) return null;
  return results.flat();
}

/** Cached + deduped leg durations for a coordinate signature. */
function getLegSeconds(signature, coords) {
  if (legCache.has(signature)) return Promise.resolve(legCache.get(signature));
  if (inflight.has(signature)) return inflight.get(signature);
  const p = fetchLegSeconds(coords).then((legs) => {
    inflight.delete(signature);
    if (legs) {
      legCache.set(signature, legs);
      if (legCache.size > LEG_CACHE_CAP) legCache.delete(legCache.keys().next().value);
    }
    return legs;
  });
  inflight.set(signature, p);
  return p;
}

/**
 * Timing model for a route's journey: ordered nodes (start depot → stops →
 * end depot) with per-node arrival labels and per-leg drive times.
 *
 * Leg durations come from the Google Directions API (cached by the ordered
 * coordinate signature, so add/remove/reorder recomputes automatically) with
 * an instant haversine estimate shown until real data arrives.
 *
 * Time anchoring: when at least one stop is completed, the latest completed
 * stop's LastModifiedDate pins the schedule to real clock times; otherwise
 * labels are relative offsets from the route start.
 */
export default function useRouteTimeline(route) {
  const serviceLocations = useStore((s) => s.serviceLocations);

  const { stops, startSL, endSL, coords, signature } = useMemo(() => {
    if (!route) return { stops: [], startSL: null, endSL: null, coords: [], signature: '' };
    const slMap = {};
    (serviceLocations ?? []).forEach((sl) => { slMap[sl.Id] = sl; });
    const start = slMap[route.Service_Location_Start__c] ?? null;
    const end = slMap[route.Service_Location_End__c] ?? null;
    const ordered = orderedRouteStops(route);
    const startPt = slCoord(start);
    const endPt = slCoord(end);
    const all = [
      ...(startPt ? [startPt] : []),
      ...ordered.map(stopCoord),
      ...(endPt ? [endPt] : []),
    ];
    return {
      stops: ordered,
      startSL: startPt ? start : null,
      endSL: endPt ? end : null,
      coords: all,
      signature: coordsSignature(all),
    };
  }, [route, serviceLocations]);

  // Haversine estimate first; swapped for Directions data when it resolves.
  // State is keyed by signature so a stale result never renders against a
  // newer stop order.
  const [directions, setDirections] = useState(null);

  useEffect(() => {
    const cached = legCache.get(signature);
    setDirections(cached ? { sig: signature, legs: cached } : null);
    if (!signature || coords.length < 2 || cached) return undefined;

    let cancelled = false;
    const timer = setTimeout(() => {
      getLegSeconds(signature, coords).then((legs) => {
        if (!cancelled && legs) setDirections({ sig: signature, legs });
      });
    }, 300); // debounce rapid reorder/add/remove bursts

    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const directionsLegs = directions?.sig === signature ? directions.legs : null;

  return useMemo(() => {
    if (!route || stops.length === 0) {
      return { nodes: [], legs: [], mode: 'relative', isEstimate: false, totalSec: 0 };
    }

    const legsSec = directionsLegs ?? estimateAllLegSeconds(coords);
    const hasStartDepot = !!startSL;
    const offsets = cumulativeOffsets(legsSec, { hasStartDepot, pointCount: coords.length });
    const stopOffsets = offsets.slice(hasStartDepot ? 1 : 0, (hasStartDepot ? 1 : 0) + stops.length);

    const startMs = anchorStartMs(stops, stopOffsets);
    const mode = startMs != null ? 'clock' : 'relative';

    const timeLabelFor = (offsetSec, stop) => {
      if (mode === 'clock') {
        // Completed stops show their real completion time, not the projection.
        if (stop && isCompletedStatus(stop.Status__c) && stop.LastModifiedDate) {
          const ms = Date.parse(stop.LastModifiedDate);
          if (!Number.isNaN(ms)) return formatClock(ms);
        }
        return formatClock(startMs + offsetSec * 1000);
      }
      return formatOffset(offsetSec);
    };

    const nodes = [];
    let ci = 0; // index into coords/offsets

    if (startSL) {
      nodes.push({
        key: `start-${startSL.Id}`,
        kind: 'start',
        name: startSL.Name || 'Start',
        coord: coords[ci],
        offsetSec: offsets[ci],
        timeLabel: timeLabelFor(offsets[ci], null),
        legFromPrevSec: null,
        legFromPrevLabel: null,
      });
      ci += 1;
    }

    stops.forEach((stop, i) => {
      const legSec = ci > 0 ? legsSec[ci - 1] ?? 0 : null;
      nodes.push({
        key: stop.Id ?? `stop-${i}`,
        kind: 'stop',
        index: i,
        name: stop.Account_Name__c || stop.Name || `Stop ${i + 1}`,
        stop,
        status: getStopStatus(stop, stops),
        coord: coords[ci],
        offsetSec: offsets[ci],
        timeLabel: timeLabelFor(offsets[ci], stop),
        legFromPrevSec: legSec,
        legFromPrevLabel: legSec != null ? formatLegDuration(legSec) : null,
      });
      ci += 1;
    });

    if (endSL) {
      const legSec = legsSec[ci - 1] ?? 0;
      nodes.push({
        key: `end-${endSL.Id}`,
        kind: 'end',
        name: endSL.Name || 'End',
        coord: coords[ci],
        offsetSec: offsets[ci],
        timeLabel: timeLabelFor(offsets[ci], null),
        legFromPrevSec: legSec,
        legFromPrevLabel: formatLegDuration(legSec),
      });
    }

    let progressIndex = -1;
    nodes.forEach((n, i) => {
      if (n.kind === 'stop' && isCompletedStatus(n.stop?.Status__c)) progressIndex = i;
    });

    return {
      nodes,
      mode,
      isEstimate: !directionsLegs,
      totalSec: offsets[offsets.length - 1] ?? 0,
      serviceTimeMin: SERVICE_TIME_MIN,
      progressIndex,
    };
  }, [route, stops, startSL, endSL, coords, directionsLegs]);
}
