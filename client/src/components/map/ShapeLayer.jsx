import React, { useMemo, useRef, forwardRef, useImperativeHandle } from 'react';
import { Polygon } from '@react-google-maps/api';
import useStore from '../../store';

/** Polygon overlays for Shape__c records (hidden shapes skipped via hiddenShapeIds) */
const ShapeLayer = forwardRef(function ShapeLayer({ shapes = [] }, ref) {
  const hiddenShapeIds = useStore((s) => s.hiddenShapeIds);
  const editingShapeId = useStore((s) => s.editingShapeId);
  const setShapeActionsTarget = useStore((s) => s.setShapeActionsTarget);
  const polygonRefs = useRef({});
  /** Stable path refs while editing so re-renders don't reset dragged vertices. */
  const pathsCache = useRef({});

  useImperativeHandle(ref, () => ({
    getPolygon: (id) => polygonRefs.current[id],
  }), []);

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
      {parsed.filter((s) => s.paths.length && !hiddenShapeIds[s.Id]).map((s, i) => {
        const editing = editingShapeId === s.Id;
        if (!editing || !pathsCache.current[s.Id]) {
          pathsCache.current[s.Id] = s.paths;
        }
        return (
          <Polygon
            key={s.Id ?? i}
            paths={editing ? pathsCache.current[s.Id] : s.paths}
            editable={editing}
            draggable={false}
            options={{
              fillColor: s.Color__c ?? '#2563eb',
              fillOpacity: editing ? 0.4 : 0.3,
              strokeColor: s.Color__c ?? '#2563eb',
              strokeWeight: editing ? 3 : 2,
              strokeOpacity: 0.8,
              clickable: true,
              zIndex: editing ? 10 : 1,
            }}
            onLoad={(poly) => { if (s.Id) polygonRefs.current[s.Id] = poly; }}
            onUnmount={() => { if (s.Id) delete polygonRefs.current[s.Id]; }}
            onClick={() => {
              if (editing) return;
              setShapeActionsTarget(s);
            }}
          />
        );
      })}
    </>
  );
});

export default ShapeLayer;
