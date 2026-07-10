import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useLoadScript } from '@react-google-maps/api';

const LIBRARIES = ['geometry'];

// Distinct colors cycled across routes so overlapping paths stay readable.
const PALETTE = [
  '#7c3aed', '#2563eb', '#059669', '#dc2626', '#d97706',
  '#0891b2', '#db2777', '#65a30d', '#9333ea', '#0d9488',
  '#e11d48', '#4f46e5', '#ca8a04', '#16a34a', '#c026d3',
];

export function routeColor(index) {
  return PALETTE[index % PALETTE.length];
}

/** Straight-line path depot -> stops -> depot for one route. */
function straightPath(route) {
  const pts = [];
  if (route.depot) pts.push({ lat: route.depot.lat, lng: route.depot.lng });
  (route.stops || []).forEach((s) => pts.push({ lat: s.lat, lng: s.lng }));
  if (route.depot) pts.push({ lat: route.depot.lat, lng: route.depot.lng });
  return pts;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** HTML for the stop hover tooltip (imperative InfoWindow content). */
function stopTooltipHtml(stop, routeName, color) {
  const rows = [];
  rows.push(`<div style="font-weight:600;color:#111;font-size:14px;margin-bottom:2px">${esc(stop.accountName || stop.accountId)}</div>`);
  if (stop.address) rows.push(`<div style="font-size:12px;color:#666">${esc(stop.address)}</div>`);
  const facts = [`<span title="Estimated gallons to collect">~${esc(stop.estGallons)} gal</span>`];
  if (stop.lastServiceDate) facts.push(`<span title="Last UCO service date">Last: ${esc(stop.lastServiceDate)}</span>`);
  rows.push(`<div style="font-size:12px;color:#444;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap">${facts.join('')}</div>`);
  if (stop.hasOpenTicket) rows.push('<div style="font-size:11px;color:#b45309;margin-top:4px;font-weight:600">Open UCO ticket</div>');
  if (routeName) rows.push(`<div style="font-size:11px;color:${esc(color || '#666')};margin-top:4px">${esc(routeName)}</div>`);
  return `<div style="font-family:sans-serif;font-size:13px;min-width:180px;max-width:240px">${rows.join('')}</div>`;
}

/**
 * Overview map showing one or many routes with straight-line geometry.
 * Overlays (polylines/markers) are managed imperatively with full teardown and
 * redraw on every change — React-managed overlay components leak under React 18
 * StrictMode with @react-google-maps/api, leaving stale "ghost" routes behind.
 *
 * Behavior:
 * - selectedId set   => that route is highlighted, all others dimmed.
 * - route._color     => pins a route's color (used by Single view so the route
 *                       keeps its Day-view color when shown alone).
 * - Bounds are fit once on load; later changes never move the viewport.
 */
export default function RoutesOverviewMap({ routes, selectedId = null, onSelectRoute }) {
  const { isLoaded } = useLoadScript({ googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY, libraries: LIBRARIES });
  const [map, setMap] = useState(null);
  const overlaysRef = useRef([]); // live google.maps overlay objects
  const infoRef = useRef(null); // shared hover InfoWindow
  const didFitRef = useRef(false);

  // Keep latest callback without re-drawing overlays when it changes identity.
  const onSelectRef = useRef(onSelectRoute);
  onSelectRef.current = onSelectRoute;

  const allPoints = useMemo(() => routes.flatMap((r) => straightPath(r)), [routes]);

  const onLoad = (m) => setMap(m);

  // Fit bounds only once (first time we have a map + routes), then leave the
  // viewport alone so toggling Day/Single doesn't zoom out.
  useEffect(() => {
    if (!map || didFitRef.current || !window.google || allPoints.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    allPoints.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    didFitRef.current = true;
  }, [map, allPoints]);

  // Imperative overlay sync: clear everything, then draw the current route set.
  useEffect(() => {
    if (!map || !window.google) return undefined;
    const g = window.google.maps;

    const clear = () => {
      overlaysRef.current.forEach((o) => {
        g.event.clearInstanceListeners(o);
        o.setMap(null);
      });
      overlaysRef.current = [];
      if (infoRef.current) infoRef.current.close();
    };
    clear();

    if (!infoRef.current) {
      infoRef.current = new g.InfoWindow({ disableAutoPan: true, pixelOffset: new g.Size(0, -10) });
    }

    const hasSelection = !!selectedId;

    routes.forEach((route, ri) => {
      const color = route._color || routeColor(ri);
      const isSelected = selectedId === route.id;
      const dim = hasSelection && !isSelected;
      const select = () => onSelectRef.current && onSelectRef.current(route.id);

      const path = straightPath(route);
      if (path.length >= 2) {
        const line = new g.Polyline({
          map,
          path,
          strokeColor: color,
          strokeWeight: isSelected ? 5.5 : 3.5,
          strokeOpacity: dim ? 0.25 : 0.85,
          zIndex: isSelected ? 100 : 1,
          clickable: !!onSelectRef.current,
        });
        line.addListener('click', select);
        overlaysRef.current.push(line);
      }

      (route.stops || []).forEach((s) => {
        const marker = new g.Marker({
          map,
          position: { lat: s.lat, lng: s.lng },
          icon: {
            path: g.SymbolPath.CIRCLE,
            scale: isSelected ? 7 : 6,
            fillColor: color,
            fillOpacity: dim ? 0.35 : 1,
            strokeColor: '#fff',
            strokeWeight: 1.5,
          },
          zIndex: isSelected ? 100 : 1,
        });
        marker.addListener('click', select);
        marker.addListener('mouseover', () => {
          infoRef.current.setContent(stopTooltipHtml(s, route.routeName, color));
          infoRef.current.setPosition({ lat: s.lat, lng: s.lng });
          infoRef.current.open({ map });
        });
        marker.addListener('mouseout', () => infoRef.current.close());
        overlaysRef.current.push(marker);
      });

      if (route.depot) {
        const depot = new g.Marker({
          map,
          position: { lat: route.depot.lat, lng: route.depot.lng },
          title: `Depot: ${route.depot.name}`,
          icon: {
            path: g.SymbolPath.CIRCLE,
            scale: 9,
            fillColor: color,
            fillOpacity: dim ? 0.35 : 1,
            strokeColor: '#fff',
            strokeWeight: 3,
          },
          zIndex: isSelected ? 100 : 1,
        });
        depot.addListener('click', select);
        overlaysRef.current.push(depot);
      }
    });

    return clear;
  }, [map, routes, selectedId]);

  if (!isLoaded) {
    return <div className="flex items-center justify-center h-full text-txt-secondary text-sm">Loading map…</div>;
  }

  if (routes.length === 0) {
    return <div className="flex items-center justify-center h-full text-txt-secondary text-sm">Select one or more routes to view them on the map.</div>;
  }

  return (
    <GoogleMap
      mapContainerClassName="w-full h-full"
      onLoad={onLoad}
      options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}
    />
  );
}
