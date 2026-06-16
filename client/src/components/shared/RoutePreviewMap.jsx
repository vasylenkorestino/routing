import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useLoadScript, Marker, Polyline } from '@react-google-maps/api';

const LIBRARIES = ['geometry'];
const CHUNK = 23; // Directions API: origin + 23 waypoints + destination = 25

/** Requests a driving path (road geometry) for ordered points; returns [] on failure. */
async function requestDrivingPath(points) {
  if (!window.google?.maps || points.length < 2) return [];
  const ds = new window.google.maps.DirectionsService();
  const out = [];
  for (let i = 0; i < points.length - 1; i += CHUNK) {
    const end = Math.min(i + CHUNK + 1, points.length);
    const origin = points[i];
    const destination = points[end - 1];
    const waypoints = points.slice(i + 1, end - 1).map((p) => ({ location: p, stopover: true }));
    const seg = await new Promise((resolve) => {
      ds.route(
        { origin, destination, waypoints, travelMode: window.google.maps.TravelMode.DRIVING },
        (res, status) => {
          if (status === 'OK' && res.routes[0]) resolve(res.routes[0].overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() })));
          else resolve(null);
        },
      );
    });
    if (!seg) return []; // bail to straight-line fallback
    if (out.length > 0) seg.shift();
    out.push(...seg);
  }
  return out;
}

/**
 * Self-contained map preview for a single generated route: depot start/end,
 * numbered ordered stops, and the route path (road geometry when available,
 * straight-line fallback otherwise).
 */
export default function RoutePreviewMap({ route }) {
  const { isLoaded } = useLoadScript({ googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY, libraries: LIBRARIES });
  const mapRef = useRef(null);
  const [driving, setDriving] = useState(null); // { key, path }

  const depot = route?.depot || null;
  const stops = useMemo(() => route?.stops || [], [route]);

  const straightPath = useMemo(() => {
    const pts = [];
    if (depot) pts.push({ lat: depot.lat, lng: depot.lng });
    stops.forEach((s) => pts.push({ lat: s.lat, lng: s.lng }));
    if (depot) pts.push({ lat: depot.lat, lng: depot.lng });
    return pts;
  }, [depot, stops]);

  const pathKey = useMemo(() => straightPath.map((p) => `${p.lat},${p.lng}`).join('|'), [straightPath]);

  useEffect(() => {
    let cancelled = false;
    if (!isLoaded || straightPath.length < 2) return undefined;
    requestDrivingPath(straightPath).then((p) => {
      if (!cancelled && p.length >= 2) setDriving({ key: pathKey, path: p });
    });
    return () => { cancelled = true; };
  }, [isLoaded, pathKey, straightPath]);

  const onLoad = (map) => {
    mapRef.current = map;
    if (!window.google || straightPath.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    straightPath.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { top: 30, right: 30, bottom: 30, left: 30 });
  };

  if (!isLoaded) {
    return <div className="flex items-center justify-center h-full text-txt-secondary text-sm">Loading map…</div>;
  }

  const path = driving && driving.key === pathKey ? driving.path : straightPath;
  const circle = window.google?.maps?.SymbolPath?.CIRCLE ?? 0;

  return (
    <GoogleMap
      mapContainerClassName="w-full h-full"
      onLoad={onLoad}
      options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}
    >
      {path.length >= 2 && (
        <Polyline path={path} options={{ strokeColor: '#7c3aed', strokeWeight: 4, strokeOpacity: 0.85 }} />
      )}

      {stops.map((s, i) => (
        <Marker
          key={s.accountId ?? i}
          position={{ lat: s.lat, lng: s.lng }}
          label={{ text: String(i + 1), color: '#fff', fontSize: '11px', fontWeight: '700' }}
          title={s.accountName}
          icon={{ path: circle, scale: 14, fillColor: '#7c3aed', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2.5 }}
        />
      ))}

      {depot && (
        <Marker
          position={{ lat: depot.lat, lng: depot.lng }}
          label={{ text: 'S/E', color: '#fff', fontSize: '9px', fontWeight: '700' }}
          title={`Start / End: ${depot.name}`}
          icon={{ path: circle, scale: 13, fillColor: '#10b981', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }}
        />
      )}
    </GoogleMap>
  );
}
