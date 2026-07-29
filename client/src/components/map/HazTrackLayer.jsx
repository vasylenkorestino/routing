import { useMemo } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import {
  HAZTRACK_STATUS_COLORS,
  tankCoords,
  tankTitle,
  tankSfRecordId,
  volumePercent,
} from '../../utils/haztrack';

/** Builds a colored circle marker icon for a HazTrack status. */
function hazTrackMarkerIcon(status, focused) {
  const color = HAZTRACK_STATUS_COLORS[status] || HAZTRACK_STATUS_COLORS.Issue;
  const size = focused ? 18 : 14;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1}" fill="${color}" stroke="white" stroke-width="2"/>
    </svg>
  `;
  return {
    url: 'data:image/svg+xml,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(size, size),
    anchor: new google.maps.Point(size / 2, size / 2),
  };
}

/**
 * HazTrack tank markers on the map.
 * Marker click selects the tank (opens detail in overlay) and shows a compact InfoWindow.
 */
export default function HazTrackLayer() {
  const tanks = useStore((s) => s.layers.haztrack.data);
  const selectedHazTrackId = useStore((s) => s.selectedHazTrackId);
  const selectHazTrack = useStore((s) => s.selectHazTrack);
  const clearSelectedHazTrack = useStore((s) => s.clearSelectedHazTrack);
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);

  const withCoords = useMemo(
    () => tanks.map((t) => ({ tank: t, coords: tankCoords(t) })).filter((x) => x.coords),
    [tanks],
  );

  const selected = useMemo(() => {
    if (!selectedHazTrackId) return null;
    return withCoords.find((x) => x.tank.Id === selectedHazTrackId) || null;
  }, [selectedHazTrackId, withCoords]);

  return (
    <>
      {withCoords.map(({ tank, coords }) => {
        const focused = selectedHazTrackId === tank.Id;
        return (
          <Marker
            key={tank.Id}
            position={coords}
            onClick={() => selectHazTrack(tank)}
            icon={hazTrackMarkerIcon(tank.LevelStatus, focused)}
            title={`${tankTitle(tank)} · ${tank.LevelStatus || 'Issue'}`}
            zIndex={focused ? 600 : 200}
          />
        );
      })}

      {selected && (
        <InfoWindow
          position={selected.coords}
          onCloseClick={clearSelectedHazTrack}
        >
          <HazTrackPopup
            tank={selected.tank}
            sfInstanceUrl={sfInstanceUrl}
          />
        </InfoWindow>
      )}
    </>
  );
}

/** Compact InfoWindow — SF link + status; full details live in the overlay panel. */
function HazTrackPopup({ tank, sfInstanceUrl }) {
  const recordId = tankSfRecordId(tank);
  const href = sfInstanceUrl && recordId ? `${sfInstanceUrl}/${recordId}` : null;
  const pct = volumePercent(tank);
  const color = HAZTRACK_STATUS_COLORS[tank.LevelStatus] || HAZTRACK_STATUS_COLORS.Issue;

  return (
    <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 200, maxWidth: 280 }}>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontWeight: 700, color: '#2563eb', fontSize: 14, display: 'block', textDecoration: 'none', marginBottom: 4 }}
          onMouseEnter={(e) => { e.target.style.textDecoration = 'underline'; }}
          onMouseLeave={(e) => { e.target.style.textDecoration = 'none'; }}
        >
          {tankTitle(tank)}
        </a>
      ) : (
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{tankTitle(tank)}</div>
      )}
      <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>
        <strong>Tank:</strong> {tank.Name || '—'}
      </div>
      <div style={{ fontSize: 12, color: '#555', marginBottom: 2 }}>
        <strong>Fill level:</strong> {pct != null ? `${Math.round(pct)}%` : '—'}
      </div>
      <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <strong>Status:</strong>
        <span style={{ color, fontWeight: 600 }}>{tank.LevelStatus || 'Issue'}</span>
      </div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
        Open HazTrack tab for full details
      </div>
    </div>
  );
}
