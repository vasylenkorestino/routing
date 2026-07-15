import { useEffect, useMemo, useState } from 'react';
import useStore from '../store';
import { slCoord } from '../utils/routeGeometry';
import { getTodayET } from '../utils/date';
import { getStopStatus, isCompletedStatus } from '../utils/stopStatus';
import {
  ROUTE_TIME_ZONE,
  SERVICE_TIME_MIN,
  anchorStartMs,
  coordsSignature,
  cumulativeOffsets,
  estimateAllLegSeconds,
  formatClock,
  formatLegDuration,
  formatOffset,
  formatStopTimeLabel,
  getLastCompletedStop,
  getNextPendingStop,
  orderedRouteStops,
  stopCoord,
} from '../utils/routeTimeline';

/** Directions API limit: origin + 23 waypoints + destination per request. */
const CHUNK_SIZE = 23;

/** Live-traffic ETAs re-fetch on this cadence (also the cache-key bucket size). */
const TRAFFIC_BUCKET_MS = 5 * 60 * 1000;

/** Module-level caches shared by all hook instances (panel + map layer). */
const legCache = new Map(); // signature -> number[] seconds per leg
const inflight = new Map(); // signature -> Promise<number[]|null>
const LEG_CACHE_CAP = 50;

/**
 * Per-leg traffic-free drive seconds for one chunk, or null on failure.
 * Uses `stopover: true` waypoints so Google returns one leg per stop — but that
 * is also why this request never yields `duration_in_traffic` (see below).
 */
function requestChunkTypicalSeconds(origin, destination, waypoints = []) {
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

/**
 * Total live-traffic seconds for one chunk, or null when unavailable.
 * Google only returns `duration_in_traffic` when the request has NO stopover
 * waypoints, so we route through the same points as non-stopover (`via:`) —
 * this collapses the chunk into a single traffic-aware leg total.
 */
function requestChunkTrafficTotal(origin, destination, waypoints = [], departureTime) {
  return new Promise((resolve) => {
    if (!window.google?.maps || !departureTime) { resolve(null); return; }
    const ds = new google.maps.DirectionsService();
    const req = {
      origin,
      destination,
      travelMode: google.maps.TravelMode.DRIVING,
      drivingOptions: { departureTime, trafficModel: 'bestguess' },
    };
    if (waypoints.length > 0) {
      req.waypoints = waypoints.map((w) => ({ location: w, stopover: false }));
    }
    ds.route(req, (result, status) => {
      const legs = status === 'OK' ? result?.routes?.[0]?.legs : null;
      if (!legs?.length) { resolve(null); return; }
      resolve(legs.reduce((sum, l) => sum + (l.duration_in_traffic?.value ?? l.duration?.value ?? 0), 0));
    });
  });
}

/**
 * Per-leg drive seconds for one chunk. Without a departureTime this is just the
 * typical per-leg durations. With one, we scale each leg by the chunk's live
 * traffic ratio (trafficTotal / typicalTotal): stopover waypoints give per-leg
 * granularity but no traffic, `via:` gives traffic but no per-leg split, so we
 * combine both to get traffic-aware per-leg times in two requests per chunk.
 */
async function fetchChunkLegSeconds(origin, destination, waypoints, departureTime) {
  const typical = await requestChunkTypicalSeconds(origin, destination, waypoints);
  if (!typical || !departureTime) return typical;
  const trafficTotal = await requestChunkTrafficTotal(origin, destination, waypoints, departureTime);
  const typicalTotal = typical.reduce((a, b) => a + b, 0);
  if (!trafficTotal || typicalTotal <= 0) return typical; // no live data → typical times
  const ratio = trafficTotal / typicalTotal;
  return typical.map((s) => Math.round(s * ratio));
}

/** Chunked Directions fetch of all leg durations for an ordered point list. */
async function fetchLegSeconds(coords, departureTime = null) {
  if (coords.length < 2) return [];
  const chunks = [];
  for (let i = 0; i < coords.length - 1; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE + 1, coords.length);
    chunks.push(fetchChunkLegSeconds(coords[i], coords[end - 1], coords.slice(i + 1, end - 1), departureTime));
  }
  const results = await Promise.all(chunks);
  if (results.some((r) => r === null)) return null;
  return results.flat();
}

/**
 * Cached + deduped leg durations for a cache key. The key is the coordinate
 * signature for traffic-free routes, or signature + 5-minute time bucket for
 * traffic-aware routes (so live ETAs refresh instead of freezing on a cache hit).
 */
function getLegSeconds(cacheKey, coords, departureTime = null) {
  if (legCache.has(cacheKey)) return Promise.resolve(legCache.get(cacheKey));
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);
  const p = fetchLegSeconds(coords, departureTime).then((legs) => {
    inflight.delete(cacheKey);
    if (legs) {
      legCache.set(cacheKey, legs);
      if (legCache.size > LEG_CACHE_CAP) legCache.delete(legCache.keys().next().value);
    }
    return legs;
  });
  inflight.set(cacheKey, p);
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
  const trafficRefreshNonce = useStore((s) => s.trafficRefreshNonce);
  const refreshTraffic = useStore((s) => s.refreshTraffic);

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

  // Live traffic ("leave now") for today/future routes; past routes fall back to
  // traffic-free typical times (Google rejects past departure times).
  const useTraffic = !(route?.Service_Date__c && route.Service_Date__c < getTodayET());

  // 5-minute bucket rotates the cache key and drives periodic live refresh.
  const [trafficBucket, setTrafficBucket] = useState(() => Math.floor(Date.now() / TRAFFIC_BUCKET_MS));
  useEffect(() => {
    if (!useTraffic) return undefined;
    const id = setInterval(
      () => setTrafficBucket(Math.floor(Date.now() / TRAFFIC_BUCKET_MS)),
      TRAFFIC_BUCKET_MS,
    );
    return () => clearInterval(id);
  }, [useTraffic]);

  // Manual refresh (nonce) forces a fresh key -> cache miss -> traffic re-fetch,
  // and because the nonce lives in the store, the timeline and map chips refresh together.
  const cacheKey = signature
    ? (useTraffic ? `${signature}|t${trafficBucket}|r${trafficRefreshNonce}` : signature)
    : '';

  // Haversine estimate first; swapped for Directions data when it resolves.
  // Stored legs are tagged with the route-shape `signature` (not the full
  // cacheKey). A traffic refresh (bucket/nonce change) keeps the last real legs
  // visible while the new ones load — stale-while-revalidate — so the display
  // never flashes back to the haversine estimate and then "reverts".
  const [directions, setDirections] = useState(null);
  const [trafficLoading, setTrafficLoading] = useState(false);

  useEffect(() => {
    const cached = legCache.get(cacheKey);
    if (cached) {
      setDirections({ sig: signature, legs: cached });
      setTrafficLoading(false);
      return undefined;
    }
    if (!cacheKey || coords.length < 2) {
      setDirections(null);
      setTrafficLoading(false);
      return undefined;
    }

    // Same route shape → keep prior legs during the refetch (no flash); a
    // different shape invalidates the leg count, so fall back to the estimate.
    setDirections((prev) => (prev && prev.sig === signature ? prev : null));
    setTrafficLoading(true);

    let cancelled = false;
    const timer = setTimeout(() => {
      const departureTime = useTraffic ? new Date() : null;
      getLegSeconds(cacheKey, coords, departureTime).then((legs) => {
        if (cancelled) return;
        if (legs) setDirections({ sig: signature, legs });
        setTrafficLoading(false);
      });
    }, 300); // debounce rapid reorder/add/remove bursts

    return () => { cancelled = true; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const directionsLegs = directions?.sig === signature ? directions.legs : null;
  const trafficAware = useTraffic && directionsLegs != null;

  return useMemo(() => {
    if (!route || stops.length === 0) {
      return {
        nodes: [], legs: [], mode: 'relative', isEstimate: false, totalSec: 0,
        nextStop: null, nextStopNode: null, nextStopEta: null,
        lastCompletedAt: null, timeZone: ROUTE_TIME_ZONE, trafficAware: false,
        useTraffic, refreshTraffic, trafficLoading,
      };
    }

    const legsSec = directionsLegs ?? estimateAllLegSeconds(coords);
    const hasStartDepot = !!startSL;
    const offsets = cumulativeOffsets(legsSec, { hasStartDepot, pointCount: coords.length });
    const stopOffsets = offsets.slice(hasStartDepot ? 1 : 0, (hasStartDepot ? 1 : 0) + stops.length);

    const startMs = anchorStartMs(stops, stopOffsets);
    const mode = startMs != null ? 'clock' : 'relative';

    const timeLabelFor = (offsetSec, stop, kind) => {
      if (mode === 'clock') {
        // Completed stops show their real completion time (actual), not the projection.
        if (stop && isCompletedStatus(stop.Status__c) && stop.LastModifiedDate) {
          const ms = Date.parse(stop.LastModifiedDate);
          if (!Number.isNaN(ms)) return formatClock(ms);
        }
        // Not-yet-serviced stops are projections → mark as estimates; depots stay unprefixed.
        const clock = formatClock(startMs + offsetSec * 1000);
        return kind === 'stop' ? `est. ${clock}` : clock;
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
        timeLabel: timeLabelFor(offsets[ci], null, 'start'),
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
        timeLabel: timeLabelFor(offsets[ci], stop, 'stop'),
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
        timeLabel: timeLabelFor(offsets[ci], null, 'end'),
        legFromPrevSec: legSec,
        legFromPrevLabel: formatLegDuration(legSec),
      });
    }

    let progressIndex = -1;
    nodes.forEach((n, i) => {
      if (n.kind === 'stop' && isCompletedStatus(n.stop?.Status__c)) progressIndex = i;
    });

    // Driver's next stop + actual/estimated clock times (in the operational timezone).
    const nextStop = getNextPendingStop(stops);
    const nextStopNode = nextStop
      ? nodes.find((n) => n.kind === 'stop' && n.stop?.Id === nextStop.Id) ?? null
      : null;

    const lastCompleted = getLastCompletedStop(stops);
    const lastCompletedAt = lastCompleted?.LastModifiedDate
      ? formatStopTimeLabel({ ms: Date.parse(lastCompleted.LastModifiedDate), isActual: true })
      : null;

    let nextStopEta = null;
    if (nextStopNode) {
      if (mode === 'clock') {
        let etaMs = startMs + nextStopNode.offsetSec * 1000;
        // Behind schedule: re-estimate from now plus the drive leg into the next stop.
        if (etaMs < Date.now()) etaMs = Date.now() + (nextStopNode.legFromPrevSec ?? 0) * 1000;
        nextStopEta = formatStopTimeLabel({ ms: etaMs, isActual: false });
      } else {
        nextStopEta = formatOffset(nextStopNode.offsetSec);
      }
    }

    return {
      nodes,
      mode,
      isEstimate: !directionsLegs,
      totalSec: offsets[offsets.length - 1] ?? 0,
      serviceTimeMin: SERVICE_TIME_MIN,
      progressIndex,
      nextStop,
      nextStopNode,
      nextStopEta,
      lastCompletedAt,
      timeZone: ROUTE_TIME_ZONE,
      trafficAware,
      useTraffic,
      refreshTraffic,
      trafficLoading,
    };
  }, [route, stops, startSL, endSL, coords, directionsLegs, trafficAware, useTraffic, refreshTraffic, trafficLoading]);
}
