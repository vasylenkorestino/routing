import { useEffect, useMemo, useRef, useState } from 'react';
import useStore from '../../store';
import useRouteTimeline from '../../hooks/useRouteTimeline';
import { formatOffset } from '../../utils/routeTimeline';
import { isCompletedStatus } from '../../utils/stopStatus';

/** Depot colors matching the map's S / E markers. */
const DEPOT_COLORS = { start: '#10b981', end: '#ef4444' };

/** Circle node — stop number colored by status, or S / E for depots. */
function NodeCircle({ node, highlighted, isNext }) {
  const color = node.kind === 'stop' ? (node.status?.color ?? '#2563eb') : DEPOT_COLORS[node.kind];
  const text = node.kind === 'stop' ? String(node.index + 1) : node.kind === 'start' ? 'S' : 'E';
  // Hover/selection (yellow) takes precedence over the next-stop ring (blue).
  const boxShadow = highlighted ? '0 0 0 3px #facc15' : isNext ? '0 0 0 3px #2563eb' : '0 0 0 2px #fff';
  return (
    <span
      className="flex items-center justify-center rounded-full text-white font-bold shrink-0 transition"
      style={{ width: 24, height: 24, fontSize: 11, backgroundColor: color, boxShadow }}
    >
      {text}
    </span>
  );
}

/** Track segment between two nodes with the leg drive time on it. */
function Connector({ label, reached }) {
  return (
    <div className="flex flex-col items-center justify-center min-w-[44px] flex-1 px-1 pt-[5px] self-start">
      <span className="text-[9px] leading-3 text-txt-secondary whitespace-nowrap tabular-nums h-3">
        {label ?? ''}
      </span>
      <div className={`h-0.5 w-full rounded-full ${reached ? 'bg-success' : 'bg-border'}`} />
    </div>
  );
}

/**
 * Horizontal route timeline: start depot → stops (by Priority__c) → end depot,
 * with per-stop times (clock times when anchored to a completed stop,
 * relative offsets otherwise), leg drive times on the connectors, and a
 * progress fill up to the last completed stop. Hover/click syncs with the
 * map markers via hoveredStopId / selectedStopId. Collapsible.
 */
export default function RouteTimeline({ route }) {
  const [open, setOpen] = useState(false);
  const hoveredStopId = useStore((s) => s.hoveredStopId);
  const selectedStopId = useStore((s) => s.selectedStopId);
  const setHoveredStopId = useStore((s) => s.setHoveredStopId);
  const setSelectedStopId = useStore((s) => s.setSelectedStopId);

  const { nodes, mode, isEstimate, totalSec, progressIndex, nextStop, nextStopEta, useTraffic, refreshTraffic, trafficLoading } = useRouteTimeline(route);
  const refreshingTraffic = trafficLoading;
  const nextStopId = nextStop?.Id ?? null;
  const nextStopName = nextStop?.Account_Name__c || nextStop?.Name || null;

  // First stop not yet completed — the timeline auto-centers on it when opened.
  const firstPendingKey = useMemo(
    () => nodes.find((n) => n.kind === 'stop' && !isCompletedStatus(n.stop?.Status__c))?.key ?? null,
    [nodes],
  );
  const pendingNodeRef = useRef(null);

  useEffect(() => {
    if (!open || !pendingNodeRef.current) return;
    pendingNodeRef.current.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [open, firstPendingKey]);

  if (nodes.length === 0) return null;

  return (
    <div className="bg-surface border border-border rounded-xl">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-xs font-semibold text-txt hover:bg-bg transition rounded-xl"
        onClick={() => setOpen((o) => !o)}
      >
        <span>{open ? '▾' : '▸'}</span>
        Route Timeline
        <span className="font-normal text-txt-secondary tabular-nums">
          {formatOffset(totalSec).replace('+', '')} est. total (drive + service)
        </span>
        {isEstimate && (
          <span className="text-[9px] font-medium text-txt-secondary border border-border rounded-full px-1.5 py-px">
            estimating…
          </span>
        )}
        {mode === 'clock' && (
          <span className="text-[9px] font-medium text-success bg-success-bg border border-success/20 rounded-full px-1.5 py-px">
            live times
          </span>
        )}
        <span
          role="button"
          tabIndex={0}
          title={useTraffic ? 'Refresh ETAs with current traffic' : 'Refresh drive times (manual)'}
          aria-label="Refresh route timeline drive times"
          onClick={(e) => { e.stopPropagation(); if (!refreshingTraffic) refreshTraffic(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (!refreshingTraffic) refreshTraffic(); }
          }}
          className="inline-flex items-center gap-0.5 text-[9px] font-medium text-warning bg-warning-bg border border-warning/20 rounded-full px-1.5 py-px cursor-pointer hover:bg-warning/20 transition"
        >
          <svg
            viewBox="0 0 24 24"
            width="9"
            height="9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={refreshingTraffic ? 'animate-spin' : ''}
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {refreshingTraffic ? 'refreshing…' : 'live traffic'}
        </span>
        {nextStopEta && nextStopName && (
          <span className="text-[9px] font-medium text-primary bg-primary/10 border border-primary/20 rounded-full px-1.5 py-px truncate max-w-[180px]">
            Next: {nextStopName} · {nextStopEta}
          </span>
        )}
      </button>

      {open && (
        <div className="overflow-x-auto px-3 pb-2">
          <div className="flex items-start min-w-max py-1">
            {nodes.map((node, i) => {
              const isStop = node.kind === 'stop';
              const highlighted = isStop && (hoveredStopId === node.stop?.Id || selectedStopId === node.stop?.Id);
              const isNext = isStop && node.stop?.Id === nextStopId;
              return (
                <div
                  key={node.key}
                  ref={node.key === firstPendingKey ? pendingNodeRef : undefined}
                  className="flex items-start"
                >
                  {i > 0 && <Connector label={node.legFromPrevLabel} reached={i <= progressIndex} />}
                  <div
                    className={`flex flex-col items-center gap-0.5 w-[74px] ${isStop ? 'cursor-pointer' : ''}`}
                    onMouseEnter={isStop ? () => node.stop?.Id && setHoveredStopId(node.stop.Id, 'list') : undefined}
                    onMouseLeave={isStop ? () => setHoveredStopId(null) : undefined}
                    onClick={isStop ? () => node.stop?.Id && setSelectedStopId(node.stop.Id) : undefined}
                    title={node.name}
                  >
                    <NodeCircle node={node} highlighted={highlighted} isNext={isNext} />
                    <span className="text-[10px] leading-tight text-txt text-center w-full truncate">
                      {node.name}
                    </span>
                    <span className="text-[10px] font-semibold text-txt-secondary tabular-nums">
                      {node.timeLabel}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
