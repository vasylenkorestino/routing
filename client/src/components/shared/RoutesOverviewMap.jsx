import { Fragment, useMemo, useRef, useState } from 'react';
import { GoogleMap, useLoadScript, Marker, Polyline, InfoWindow } from '@react-google-maps/api';

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

/**
 * Overview map showing many routes at once. Each route is drawn with its own
 * color using straight-line geometry (light-weight vs. per-route Directions
 * calls), with stop dots and depot markers, fit to the bounds of all routes.
 */
export default function RoutesOverviewMap({ routes, selectedId = null, onSelectRoute, hideUnselected = false }) {
  const { isLoaded } = useLoadScript({ googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY, libraries: LIBRARIES });
  const mapRef = useRef(null);
  const [hovered, setHovered] = useState(null); // { stop, routeName } for the tooltip

  const paths = useMemo(() => routes.map((r) => ({ id: r.id, path: straightPath(r), depot: r.depot, stops: r.stops || [] })), [routes]);
  const allPoints = useMemo(() => paths.flatMap((p) => p.path), [paths]);

  const onLoad = (map) => {
    mapRef.current = map;
    if (!window.google || allPoints.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    allPoints.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
  };

  if (!isLoaded) {
    return <div className="flex items-center justify-center h-full text-txt-secondary text-sm">Loading map…</div>;
  }

  const circle = window.google?.maps?.SymbolPath?.CIRCLE ?? 0;

  if (routes.length === 0) {
    return <div className="flex items-center justify-center h-full text-txt-secondary text-sm">Select one or more routes to view them on the map.</div>;
  }

  return (
    <GoogleMap
      mapContainerClassName="w-full h-full"
      onLoad={onLoad}
      options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}
    >
      {paths.map((p, ri) => {
        // Color is keyed to the route's index in the full list so it stays stable
        // (same color) whether or not other routes are hidden/dimmed.
        const color = routeColor(ri);
        const hasSelection = !!selectedId;
        const isSelected = selectedId === p.id;
        // Single mode: render only the selected route (others fully hidden).
        if (hideUnselected && hasSelection && !isSelected) return null;
        // Day mode: dim non-selected routes so the chosen one stands out.
        const dim = !hideUnselected && hasSelection && !isSelected;
        const strokeOpacity = dim ? 0.25 : 0.85;
        const strokeWeight = (isSelected && !hideUnselected) ? 5.5 : 3.5;
        const fillOpacity = dim ? 0.35 : 1;
        const select = onSelectRoute ? () => onSelectRoute(p.id) : undefined;
        return (
          <Fragment key={p.id}>
            {p.path.length >= 2 && (
              <Polyline
                path={p.path}
                onClick={select}
                options={{ strokeColor: color, strokeWeight, strokeOpacity, zIndex: isSelected ? 100 : 1, clickable: !!onSelectRoute }}
              />
            )}
            {p.stops.map((s, i) => (
              <Marker
                key={`${p.id}-${s.accountId ?? i}`}
                position={{ lat: s.lat, lng: s.lng }}
                onClick={select}
                onMouseOver={() => setHovered({ stop: s, routeName: routes[ri].routeName, color })}
                onMouseOut={() => setHovered((h) => (h?.stop === s ? null : h))}
                icon={{ path: circle, scale: isSelected ? 7 : 6, fillColor: color, fillOpacity, strokeColor: '#fff', strokeWeight: 1.5 }}
                zIndex={isSelected ? 100 : undefined}
              />
            ))}
            {p.depot && (
              <Marker
                position={{ lat: p.depot.lat, lng: p.depot.lng }}
                title={`Depot: ${p.depot.name}`}
                onClick={select}
                icon={{ path: circle, scale: 9, fillColor: color, fillOpacity, strokeColor: '#fff', strokeWeight: 3 }}
                zIndex={isSelected ? 100 : undefined}
              />
            )}
          </Fragment>
        );
      })}

      {hovered && (
        <InfoWindow
          position={{ lat: hovered.stop.lat, lng: hovered.stop.lng }}
          options={{ disableAutoPan: true, pixelOffset: new window.google.maps.Size(0, -10) }}
          onCloseClick={() => setHovered(null)}
        >
          <StopTooltip stop={hovered.stop} routeName={hovered.routeName} color={hovered.color} />
        </InfoWindow>
      )}
    </GoogleMap>
  );
}

/** Compact hover card showing quick account info for a stop. */
function StopTooltip({ stop, routeName, color }) {
  return (
    <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 180, maxWidth: 240 }}>
      <div style={{ fontWeight: 600, color: '#111', fontSize: 14, marginBottom: 2 }}>
        {stop.accountName || stop.accountId}
      </div>
      {stop.address && <div style={{ fontSize: 12, color: '#666' }}>{stop.address}</div>}
      <div style={{ fontSize: 12, color: '#444', marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span title="Estimated gallons to collect">~{stop.estGallons} gal</span>
        {stop.lastServiceDate && <span title="Last UCO service date">Last: {stop.lastServiceDate}</span>}
      </div>
      {stop.hasOpenTicket && (
        <div style={{ fontSize: 11, color: '#b45309', marginTop: 4, fontWeight: 600 }}>Open UCO ticket</div>
      )}
      {routeName && (
        <div style={{ fontSize: 11, color: color || '#666', marginTop: 4 }}>{routeName}</div>
      )}
    </div>
  );
}
