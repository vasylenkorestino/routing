import { Fragment, useMemo, useRef } from 'react';
import { GoogleMap, useLoadScript, Marker, Polyline } from '@react-google-maps/api';

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
export default function RoutesOverviewMap({ routes }) {
  const { isLoaded } = useLoadScript({ googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY, libraries: LIBRARIES });
  const mapRef = useRef(null);

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
        const color = routeColor(ri);
        return (
          <Fragment key={p.id}>
            {p.path.length >= 2 && (
              <Polyline path={p.path} options={{ strokeColor: color, strokeWeight: 3.5, strokeOpacity: 0.8 }} />
            )}
            {p.stops.map((s, i) => (
              <Marker
                key={`${p.id}-${s.accountId ?? i}`}
                position={{ lat: s.lat, lng: s.lng }}
                title={`${s.accountName || ''} (${routes[ri].routeName})`}
                icon={{ path: circle, scale: 6, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 1.5 }}
              />
            ))}
            {p.depot && (
              <Marker
                position={{ lat: p.depot.lat, lng: p.depot.lng }}
                title={`Depot: ${p.depot.name}`}
                icon={{ path: circle, scale: 9, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }}
              />
            )}
          </Fragment>
        );
      })}
    </GoogleMap>
  );
}
