import { useMemo, useState } from 'react';
import useStore from '../../store';
import { STOP_STATUSES } from '../../utils/stopStatus';
import { parseReason } from '../../utils/routeLogFlags';

/**
 * Map legend — explains the stop marker status colors (bottom-left overlay).
 * Collapsed to a small button by default; click to expand/close.
 * Shifts right when the AI Flags legend is visible.
 */
export default function MapLegend() {
  const [open, setOpen] = useState(false);
  const routeId = useStore((s) => s.routeId);
  const routeLogs = useStore((s) => s.routeLogs);
  const routeLogsRouteId = useStore((s) => s.routeLogsRouteId);
  const haztrackVisible = useStore((s) => !!s.layers.haztrack?.visible);

  const hasAiFlags = useMemo(() => {
    if (!routeId || routeLogsRouteId !== routeId) return false;
    return routeLogs.some((l) => l.Status__c === 'Proposed' && parseReason(l.Reason__c).flag);
  }, [routeId, routeLogsRouteId, routeLogs]);

  // Shift right for AI flags; shift up when HazTrack legend occupies bottom-left.
  const pos = [
    hasAiFlags ? 'left-[11.5rem]' : 'left-2',
    haztrackVisible ? 'bottom-16' : 'bottom-6',
  ].join(' ');

  if (!open) {
    return (
      <button
        type="button"
        className={`absolute ${pos} z-10 flex items-center gap-1.5 px-2.5 py-1.5 bg-surface/95 border border-border rounded-lg shadow-md text-[11px] font-medium text-txt-secondary hover:text-txt hover:bg-surface transition`}
        onClick={() => setOpen(true)}
        title="Show stop status legend"
      >
        <span className="flex items-center -space-x-1">
          {Object.values(STOP_STATUSES).map((s) => (
            <span
              key={s.key}
              className="w-2.5 h-2.5 rounded-full border border-white"
              style={{ background: s.color }}
            />
          ))}
        </span>
        Legend
      </button>
    );
  }

  return (
    <div className={`absolute ${pos} z-10 bg-surface/95 border border-border rounded-lg shadow-md px-3 py-2`}>
      <div className="flex items-center gap-3 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-txt-secondary">Stops</span>
        <button
          type="button"
          className="ml-auto w-4 h-4 flex items-center justify-center rounded text-txt-secondary hover:text-txt transition"
          onClick={() => setOpen(false)}
          title="Hide legend"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {Object.values(STOP_STATUSES).map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span
              className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm shrink-0"
              style={{ background: s.color }}
            />
            <span className="text-[11px] text-txt">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
