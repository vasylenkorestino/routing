import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Marker } from '@react-google-maps/api';
import { useGoogleMap } from '@react-google-maps/api';
import useStore from '../../store';
import StopInfoWindow from './StopInfoWindow';
import { decodeRoutePolyline, isValidCoord } from '../../utils/routePolyline';

function hasValidCoords(s) {
  return isValidCoord(Number(s.Latitude__c), Number(s.Longitude__c));
}

function slCoord(sl) {
  if (!sl) return null;
  const lat = Number(sl.Latitude__c);
  const lng = Number(sl.Longitude__c);
  if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

function getStopsAndPolyline(route, startPt, endPt) {
  const allStops = route.Routes__r?.records ?? route.Routes__r ?? [];
  const stops = allStops
    .filter(hasValidCoords)
    .sort((a, b) => (a.Priority__c ?? 0) - (b.Priority__c ?? 0));

  const anchors = [
    ...stops.map((s) => ({ lat: Number(s.Latitude__c), lng: Number(s.Longitude__c) })),
    ...(startPt ? [startPt] : []),
    ...(endPt ? [endPt] : []),
  ];

  const polyPath = route.Polyline__c
    ? decodeRoutePolyline(route.Polyline__c, { anchors })
    : [];

  if (route.Polyline__c && polyPath.length < 2) {
    console.warn(`[RouteLayer] polyline unusable for ${route.Name}; using driving directions`);
  }

  return { stops, polyPath };
}

/** Request driving directions for a single chunk (max 25 total = origin + 23 waypoints + destination) */
function requestDrivingChunk(origin, destination, waypoints = []) {
  return new Promise((resolve) => {
    if (!window.google?.maps) { resolve([]); return; }
    const ds = new google.maps.DirectionsService();
    const req = { origin, destination, travelMode: google.maps.TravelMode.DRIVING };
    if (waypoints.length > 0) {
      req.waypoints = waypoints.map((w) => ({ location: w, stopover: true }));
    }
    ds.route(req, (result, status) => {
      if (status === 'OK' && result.routes[0]) {
        resolve(result.routes[0].overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() })));
      } else {
        resolve([]);
      }
    });
  });
}

const CHUNK_SIZE = 23;

/** Splits large routes into chunks, calls Directions API for each, and stitches paths */
async function requestDrivingPath(origin, destination, waypoints = []) {
  if (!window.google?.maps) return [];
  if (waypoints.length <= CHUNK_SIZE) {
    return requestDrivingChunk(origin, destination, waypoints);
  }

  const allPoints = [origin, ...waypoints, destination];
  const chunks = [];
  for (let i = 0; i < allPoints.length - 1; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE + 1, allPoints.length);
    const chunkOrigin = allPoints[i];
    const chunkDest = allPoints[end - 1];
    const chunkWps = allPoints.slice(i + 1, end - 1);
    chunks.push({ origin: chunkOrigin, destination: chunkDest, waypoints: chunkWps });
  }

  const paths = await Promise.all(
    chunks.map((c) => requestDrivingChunk(c.origin, c.destination, c.waypoints))
  );

  const stitched = [];
  for (const seg of paths) {
    if (stitched.length > 0 && seg.length > 0) seg.shift();
    stitched.push(...seg);
  }
  return stitched;
}

const drivingCache = {};

/** Compute driving paths for service-location segments and full fallback routes */
function useDrivingPaths(routeId, startPt, endPt, stops, hasPolyline) {
  const [startPath, setStartPath] = useState(null);
  const [endPath, setEndPath] = useState(null);
  const [fullPath, setFullPath] = useState(null);

  const startKey = startPt ? `${startPt.lat},${startPt.lng}` : '';
  const endKey = endPt ? `${endPt.lat},${endPt.lng}` : '';
  // Signature of the ordered stop set so the driving-path recomputes (and cache
  // key changes) whenever a stop is added/removed/reordered — not just on count.
  const stopsKey = stops.map((s) => s.Id ?? `${s.Latitude__c},${s.Longitude__c}`).join('|');

  useEffect(() => {
    setStartPath(null);
    setEndPath(null);
    setFullPath(null);
    if (!window.google?.maps || stops.length === 0) return;
    const firstStop = { lat: Number(stops[0].Latitude__c), lng: Number(stops[0].Longitude__c) };
    const lastStop = { lat: Number(stops[stops.length - 1].Latitude__c), lng: Number(stops[stops.length - 1].Longitude__c) };

    if (hasPolyline) {
      if (startPt) {
        const key = `s_${routeId}_${startKey}`;
        if (drivingCache[key]) { setStartPath(drivingCache[key]); }
        else {
          requestDrivingPath(startPt, firstStop).then((p) => { drivingCache[key] = p; setStartPath(p); });
        }
      }
      if (endPt) {
        const key = `e_${routeId}_${endKey}`;
        if (drivingCache[key]) { setEndPath(drivingCache[key]); }
        else {
          requestDrivingPath(lastStop, endPt).then((p) => { drivingCache[key] = p; setEndPath(p); });
        }
      }
    } else {
      const origin = startPt || firstStop;
      const dest = endPt || lastStop;
      const wps = stops.map((s) => ({ lat: Number(s.Latitude__c), lng: Number(s.Longitude__c) }));
      const key = `f_${routeId}_${startKey}_${endKey}_${stopsKey}`;
      if (drivingCache[key]) { setFullPath(drivingCache[key]); }
      else {
        requestDrivingPath(origin, dest, wps).then((p) => { drivingCache[key] = p; setFullPath(p); });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, startKey, endKey, stopsKey, hasPolyline]);

  return { startPath, endPath, fullPath };
}

/** Native Google Maps polyline — bypasses @react-google-maps/api wrapper entirely */
function NativePolyline({ path, color, visible }) {
  const map = useGoogleMap();
  const polyRef = useRef(null);

  useEffect(() => {
    if (!map || !window.google || path.length < 2) return;

    const poly = new google.maps.Polyline({
      path,
      strokeColor: color,
      strokeWeight: 5,
      strokeOpacity: 0.85,
      geodesic: true,
      map: visible ? map : null,
    });
    polyRef.current = poly;

    return () => {
      poly.setMap(null);
      polyRef.current = null;
    };
  }, [map, path, color]);

  useEffect(() => {
    const poly = polyRef.current;
    if (!poly) return;
    poly.setMap(visible ? map : null);
  }, [visible, map]);

  return null;
}

/**
 * Numbered stop marker with hover-sync: highlights (bigger, ringed, on top)
 * when its list row is hovered/selected, and reports map hover back to the
 * list via hoveredStopId. Never pans or zooms the map.
 */
function StopMarker({ pt, index, color, onClick }) {
  const highlighted = useStore((s) => s.hoveredStopId === pt.Id || s.selectedStopId === pt.Id);
  const setHoveredStopId = useStore((s) => s.setHoveredStopId);

  return (
    <Marker
      position={{ lat: Number(pt.Latitude__c), lng: Number(pt.Longitude__c) }}
      label={{
        text: String(index + 1),
        color: '#fff',
        fontSize: highlighted ? '13px' : '11px',
        fontWeight: '700',
      }}
      icon={{
        path: window.google?.maps?.SymbolPath?.CIRCLE ?? 0,
        scale: highlighted ? 20 : 16,
        fillColor: color,
        fillOpacity: 1,
        strokeColor: highlighted ? '#facc15' : '#fff',
        strokeWeight: highlighted ? 4 : 2.5,
      }}
      zIndex={highlighted ? 10000 : undefined}
      title={`${index + 1}. ${pt.Account_Name__c || pt.Name || ''}`}
      onClick={onClick}
      onMouseOver={() => pt.Id && setHoveredStopId(pt.Id, 'map')}
      onMouseOut={() => setHoveredStopId(null)}
    />
  );
}

/** Single route rendered on map */
function SingleRoute({ route, onSelectStop, forceVisible = false }) {
  const hiddenRouteIds = useStore((s) => s.hiddenRouteIds);
  const serviceLocations = useStore((s) => s.serviceLocations);

  const id = route.Id ?? route.id;
  const visible = forceVisible || !hiddenRouteIds[id];
  const color = route._color ?? '#2563eb';

  const slMap = {};
  (serviceLocations ?? []).forEach((sl) => { slMap[sl.Id] = sl; });
  const startSL = slMap[route.Service_Location_Start__c] ?? null;
  const endSL = slMap[route.Service_Location_End__c] ?? null;
  const startPt = slCoord(startSL);
  const endPt = slCoord(endSL);

  const { stops, polyPath } = getStopsAndPolyline(route, startPt, endPt);
  const hasPolyline = polyPath.length >= 2;

  const { startPath, endPath, fullPath } = useDrivingPaths(id, startPt, endPt, stops, hasPolyline);

  return (
    <>
      {/* Main route polyline (from Polyline__c) */}
      {hasPolyline && <NativePolyline path={polyPath} color={color} visible={visible} />}

      {/* Driving path: service location → first stop */}
      {hasPolyline && startPath && startPath.length >= 2 && (
        <NativePolyline path={startPath} color={color} visible={visible} />
      )}

      {/* Driving path: last stop → end location */}
      {hasPolyline && endPath && endPath.length >= 2 && (
        <NativePolyline path={endPath} color={color} visible={visible} />
      )}

      {/* Full driving path fallback (no Polyline__c) */}
      {!hasPolyline && fullPath && fullPath.length >= 2 && (
        <NativePolyline path={fullPath} color={color} visible={visible} />
      )}

      {visible && stops.map((pt, pIdx) => (
        <StopMarker
          key={pt.Id ?? pIdx}
          pt={pt}
          index={pIdx}
          color={color}
          onClick={() => onSelectStop({ ...pt, _routeName: route.Name, _color: color, _googleRouteId: route.Id ?? route.id })}
        />
      ))}

      {visible && startSL && Number(startSL.Latitude__c) !== 0 && (
        <Marker
          position={{ lat: Number(startSL.Latitude__c), lng: Number(startSL.Longitude__c) }}
          icon={{
            path: window.google?.maps?.SymbolPath?.CIRCLE ?? 0,
            scale: 12,
            fillColor: '#10b981',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 3,
          }}
          label={{ text: 'S', color: '#fff', fontSize: '10px', fontWeight: '700' }}
          title={`Start: ${startSL.Name}`}
        />
      )}

      {visible && endSL && endSL.Id !== startSL?.Id && Number(endSL.Latitude__c) !== 0 && (
        <Marker
          position={{ lat: Number(endSL.Latitude__c), lng: Number(endSL.Longitude__c) }}
          icon={{
            path: window.google?.maps?.SymbolPath?.CIRCLE ?? 0,
            scale: 12,
            fillColor: '#ef4444',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 3,
          }}
          label={{ text: 'E', color: '#fff', fontSize: '10px', fontWeight: '700' }}
          title={`End: ${endSL.Name}`}
        />
      )}
    </>
  );
}

const stopAcctId = (s) => s.AccountId__c || s.Account__c || null;

/**
 * Marker drawn on top of stops shared across 2+ selected routes so overlaps
 * are immediately obvious. Shows the number of routes containing the account.
 */
function SharedStopMarker({ position, count, title, onClick }) {
  return (
    <Marker
      position={position}
      zIndex={9999}
      onClick={onClick}
      title={title}
      label={{ text: `×${count}`, color: '#fff', fontSize: '10px', fontWeight: '800' }}
      icon={{
        path: window.google?.maps?.SymbolPath?.CIRCLE ?? 0,
        scale: 12,
        fillColor: '#111827',
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 3,
      }}
    />
  );
}

/**
 * Compare overlay — renders every comparison route on top of the current one
 * (each in its own colour) plus a shared-stop layer highlighting accounts that
 * appear in multiple selected routes. Clicking any stop opens Last Services.
 */
export function CompareRouteLayer() {
  const route = useStore((s) => s.route);
  const compareRoutes = useStore((s) => s.compareRoutes);
  const setCompareDetail = useStore((s) => s.setCompareDetail);
  const [selectedStop, setSelectedStop] = useState(null);

  const selectStop = useCallback((stop) => {
    setSelectedStop(stop);
    setCompareDetail({ accountId: stopAcctId(stop), accountName: stop.Account_Name__c || stop.Name || '' });
  }, [setCompareDetail]);

  // Accounts shared across 2+ of the selected routes (current + comparisons).
  const shared = useMemo(() => {
    const all = [route, ...compareRoutes].filter(Boolean);
    const byAcct = new Map();
    all.forEach((r) => {
      const stops = r?.Routes__r?.records ?? r?.Routes__r ?? [];
      stops.forEach((s) => {
        const id = stopAcctId(s);
        if (!id || !hasValidCoords(s)) return;
        if (!byAcct.has(id)) {
          byAcct.set(id, { id, name: s.Account_Name__c || s.Name || id, lat: Number(s.Latitude__c), lng: Number(s.Longitude__c), routes: new Set() });
        }
        byAcct.get(id).routes.add(r.Id ?? r.id ?? r.Name);
      });
    });
    return [...byAcct.values()].filter((a) => a.routes.size >= 2);
  }, [route, compareRoutes]);

  return (
    <>
      {compareRoutes.map((r) => (
        <SingleRoute key={r.Id ?? r.id} route={r} onSelectStop={selectStop} forceVisible />
      ))}

      {shared.map((a) => (
        <SharedStopMarker
          key={a.id}
          position={{ lat: a.lat, lng: a.lng }}
          count={a.routes.size}
          title={`${a.name} — appears in ${a.routes.size} routes`}
          onClick={() => setCompareDetail({ accountId: a.id, accountName: a.name })}
        />
      ))}

      {selectedStop && <StopInfoWindow stop={selectedStop} onClose={() => setSelectedStop(null)} />}
    </>
  );
}

/** Renders all routes — polylines use native Google Maps API for reliable hide/show */
export default function RouteLayer() {
  const routes = useStore((s) => s.layers.routes.data);
  const compareMode = useStore((s) => s.compareMode);
  const setCompareDetail = useStore((s) => s.setCompareDetail);
  const [selectedStop, setSelectedStop] = useState(null);
  const handleClose = useCallback(() => setSelectedStop(null), []);

  const handleSelect = useCallback((stop) => {
    setSelectedStop(stop);
    if (compareMode) setCompareDetail({ accountId: stopAcctId(stop), accountName: stop.Account_Name__c || stop.Name || '' });
  }, [compareMode, setCompareDetail]);

  return (
    <>
      {routes.map((route) => (
        <SingleRoute
          key={route.Id ?? route.id}
          route={route}
          onSelectStop={handleSelect}
        />
      ))}

      {selectedStop && (
        <StopInfoWindow stop={selectedStop} onClose={handleClose} />
      )}
    </>
  );
}
