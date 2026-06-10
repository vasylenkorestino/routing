import { useCallback, useEffect, useRef, useState } from 'react';
import { GoogleMap, useLoadScript, Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import { decodeRoutePolyline, isValidCoord } from '../../utils/routePolyline';
import RouteLayer from './RouteLayer';
import TicketLayer from './TicketLayer';
import ShapeLayer from './ShapeLayer';
import MapOverlayPanel from './MapOverlayPanel';

const LIBRARIES = ['geometry'];

/** Main Google Maps wrapper — renders route/ticket/shape/service-location layers */
export default function RoutingMap() {
  const { isLoaded } = useLoadScript({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_KEY,
    libraries: LIBRARIES,
  });

  const layers = useStore((s) => s.layers);
  const mapCenter = useStore((s) => s.mapCenter);
  const mapZoom = useStore((s) => s.mapZoom);
  const route = useStore((s) => s.route);
  const serviceLocations = useStore((s) => s.serviceLocations);
  const mapRef = useRef(null);
  const [selectedSL, setSelectedSL] = useState(null);

  const onLoad = useCallback((map) => { mapRef.current = map; }, []);

  /** When a route is selected, fit map bounds to its stops */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route || !window.google) return;

    const stops = route.Routes__r?.records ?? route.Routes__r ?? [];
    const coords = stops
      .filter((s) => isValidCoord(Number(s.Latitude__c), Number(s.Longitude__c)))
      .map((s) => ({ lat: Number(s.Latitude__c), lng: Number(s.Longitude__c) }));

    if (coords.length === 0) return;

    if (coords.length === 1) {
      map.panTo(coords[0]);
      map.setZoom(14);
      return;
    }

    const bounds = new google.maps.LatLngBounds();
    coords.forEach((c) => bounds.extend(c));

    const polyPath = decodeRoutePolyline(route.Polyline__c, { anchors: coords });
    polyPath.forEach((p) => bounds.extend(p));

    map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
  }, [route]);

  const validSLs = (serviceLocations ?? []).filter((sl) => {
    const lat = Number(sl.Latitude__c);
    const lng = Number(sl.Longitude__c);
    return !isNaN(lat) && !isNaN(lng) && !(lat === 0 && lng === 0);
  });

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-full text-txt-secondary text-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          Loading map…
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
    <MapOverlayPanel />
    <GoogleMap
      mapContainerClassName="w-full h-full"
      center={mapCenter}
      zoom={mapZoom}
      onLoad={onLoad}
      options={{
        zoomControl: true,
        streetViewControl: false,
        mapTypeControl: true,
        fullscreenControl: true,
      }}
    >
      {layers.routes.visible && <RouteLayer />}
      {layers.tickets.visible && <TicketLayer tickets={layers.tickets.data} />}
      {layers.shapes.visible && <ShapeLayer shapes={layers.shapes.data} />}

      {/* Service Location markers */}
      {validSLs.map((sl) => (
        <Marker
          key={sl.Id}
          position={{ lat: Number(sl.Latitude__c), lng: Number(sl.Longitude__c) }}
          onClick={() => setSelectedSL(sl)}
          icon={{
            url: 'data:image/svg+xml,' + encodeURIComponent(`
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="40" viewBox="0 0 32 40">
                <path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 24 16 24s16-12 16-24C32 7.16 24.84 0 16 0z" fill="#10b981"/>
                <circle cx="16" cy="15" r="8" fill="white"/>
                <path d="M12 15l3 3 5-5" stroke="#10b981" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            `),
            scaledSize: new google.maps.Size(32, 40),
            anchor: new google.maps.Point(16, 40),
          }}
          title={sl.Name}
        />
      ))}

      {selectedSL && (
        <InfoWindow
          position={{ lat: Number(selectedSL.Latitude__c), lng: Number(selectedSL.Longitude__c) }}
          onCloseClick={() => setSelectedSL(null)}
        >
          <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 180 }}>
            <div style={{ fontWeight: 600, color: '#10b981', fontSize: 14, marginBottom: 4 }}>
              {selectedSL.Name}
            </div>
            {selectedSL.Street__c && (
              <div style={{ fontSize: 12, color: '#666' }}>
                {selectedSL.Street__c}
                {selectedSL.City__c ? `, ${selectedSL.City__c}` : ''}
                {selectedSL.State__c ? `, ${selectedSL.State__c}` : ''}
                {selectedSL.Postal_Code__c ? ` ${selectedSL.Postal_Code__c}` : ''}
              </div>
            )}
            <div style={{ fontSize: 11, color: '#10b981', marginTop: 4 }}>Service Location</div>
          </div>
        </InfoWindow>
      )}
    </GoogleMap>
    </div>
  );
}
