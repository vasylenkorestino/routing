import React, { useMemo } from 'react';
import { Polygon } from '@react-google-maps/api';
import useStore from '../../store';

/** Polygon overlays for Shape__c records (hidden shapes skipped via hiddenShapeIds) */
export default function ShapeLayer({ shapes = [] }) {
  const hiddenShapeIds = useStore((s) => s.hiddenShapeIds);

  const parsed = useMemo(
    () =>
      shapes.map((s) => {
        let paths = [];
        try {
          const coords = typeof s.Coordinates__c === 'string' ? JSON.parse(s.Coordinates__c) : s.Coordinates__c;
          if (Array.isArray(coords)) {
            paths = coords[0].map(([lng, lat]) => ({ lat, lng }));
          }
        } catch {
          /* skip malformed coords */
        }
        return { ...s, paths };
      }),
    [shapes],
  );

  return (
    <>
      {parsed.filter((s) => s.paths.length && !hiddenShapeIds[s.Id]).map((s, i) => (
        <Polygon
          key={s.Id ?? i}
          paths={s.paths}
          options={{
            fillColor: s.Color__c ?? '#2563eb',
            fillOpacity: 0.3,
            strokeColor: s.Color__c ?? '#2563eb',
            strokeWeight: 2,
            strokeOpacity: 0.8,
          }}
        />
      ))}
    </>
  );
}
