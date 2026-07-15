import { useEffect, useMemo, useState } from 'react';
import { OverlayView, OverlayViewF, useGoogleMap } from '@react-google-maps/api';
import useStore from '../../store';
import useRouteTimeline from '../../hooks/useRouteTimeline';
import { decodeRoutePolyline } from '../../utils/routePolyline';
import { legMidpointOnPath } from '../../utils/routeGeometry';

/** Zoom thresholds keeping the map readable when zoomed out. */
const MIN_ZOOM_CHIPS = 9;
const MIN_ZOOM_LEG_LABELS = 11;

/** Vertical gap between a stop marker's center and its ETA chip (px). */
const CHIP_OFFSET_PX = 26;

const chipOffset = (w, h) => ({ x: -w / 2, y: -h - CHIP_OFFSET_PX });
const centerOffset = (w, h) => ({ x: -w / 2, y: -h / 2 });

/** Small time badge floating above a stop / depot marker. */
function EtaChip({ node, onClick, isNext }) {
  const color = node.kind === 'stop' ? (node.status?.color ?? '#2563eb') : node.kind === 'start' ? '#10b981' : '#ef4444';
  const prefix = node.kind === 'start' ? 'Start ' : node.kind === 'end' ? 'End ' : isNext ? 'Next · ' : '';
  return (
    <OverlayViewF
      position={node.coord}
      mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
      getPixelPositionOffset={chipOffset}
    >
      <div
        className="px-1.5 py-0.5 rounded-full bg-white text-[10px] font-semibold whitespace-nowrap cursor-pointer select-none tabular-nums"
        style={{
          border: isNext ? `2.5px solid ${color}` : `1.5px solid ${color}`,
          color: '#1f2937',
          boxShadow: isNext ? '0 0 0 3px rgba(37,99,235,0.35)' : '0 1px 3px rgba(0,0,0,0.2)',
        }}
        onClick={onClick}
        title={node.name}
      >
        {prefix}{node.timeLabel}
      </div>
    </OverlayViewF>
  );
}

/** Drive-time label sitting directly on the polyline mid-leg. */
function LegLabel({ position, label }) {
  return (
    <OverlayViewF
      position={position}
      mapPaneName={OverlayView.OVERLAY_LAYER}
      getPixelPositionOffset={centerOffset}
    >
      <div
        className="px-1 py-px rounded bg-white/90 text-[9px] font-semibold text-txt-secondary whitespace-nowrap shadow-sm select-none tabular-nums"
        style={{ pointerEvents: 'none', border: '1px solid rgba(0,0,0,0.12)' }}
      >
        {label}
      </div>
    </OverlayViewF>
  );
}

/**
 * Timeline overlay for the selected route: ETA chips above each stop/depot
 * marker and drive-time labels placed on the polyline mid-leg. Shares
 * useRouteTimeline (and its Directions cache) with the details-panel timeline
 * so both stay in sync on add/remove/reorder. Hidden at low zoom to avoid
 * clutter, and when the selected route's layer is toggled off.
 */
export default function RouteTimelineMapLayer() {
  const map = useGoogleMap();
  const route = useStore((s) => s.route);
  const hidden = useStore((s) => !!s.hiddenRouteIds[route?.Id]);
  const setSelectedStopId = useStore((s) => s.setSelectedStopId);

  const [zoom, setZoom] = useState(() => map?.getZoom() ?? 0);

  useEffect(() => {
    if (!map) return undefined;
    setZoom(map.getZoom() ?? 0);
    const listener = map.addListener('zoom_changed', () => setZoom(map.getZoom() ?? 0));
    return () => listener.remove();
  }, [map]);

  const { nodes, nextStop } = useRouteTimeline(route);
  const nextStopId = nextStop?.Id ?? null;

  // Mid-leg label positions on the decoded polyline (geographic midpoint fallback).
  const legLabels = useMemo(() => {
    if (nodes.length < 2 || zoom < MIN_ZOOM_LEG_LABELS) return [];
    const path = decodeRoutePolyline(route?.Polyline__c, { anchors: nodes.map((n) => n.coord) });
    const labels = [];
    for (let i = 1; i < nodes.length; i++) {
      if (!nodes[i].legFromPrevLabel) continue;
      labels.push({
        key: `leg-${nodes[i - 1].key}-${nodes[i].key}`,
        position: legMidpointOnPath(path, nodes[i - 1].coord, nodes[i].coord),
        label: nodes[i].legFromPrevLabel,
      });
    }
    return labels;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, route?.Polyline__c, zoom >= MIN_ZOOM_LEG_LABELS]);

  if (!route || hidden || nodes.length === 0 || zoom < MIN_ZOOM_CHIPS) return null;

  return (
    <>
      {nodes.map((node) => (
        <EtaChip
          key={`chip-${node.key}`}
          node={node}
          isNext={node.kind === 'stop' && node.stop?.Id === nextStopId}
          onClick={node.kind === 'stop' && node.stop?.Id ? () => setSelectedStopId(node.stop.Id) : undefined}
        />
      ))}

      {legLabels.map((l) => (
        <LegLabel key={l.key} position={l.position} label={l.label} />
      ))}
    </>
  );
}
