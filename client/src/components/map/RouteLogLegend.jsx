import { useMemo, useState } from 'react';
import useStore from '../../store';
import { FLAG_META, FLAG_ORDER, parseReason } from '../../utils/routeLogFlags';

/**
 * Map legend with per-flag visibility toggles for AI Route Log markers.
 */
export default function RouteLogLegend() {
  const routeId = useStore((s) => s.routeId);
  const routeLogs = useStore((s) => s.routeLogs);
  const routeLogsRouteId = useStore((s) => s.routeLogsRouteId);
  const flagVisible = useStore((s) => s.routeLogFlagVisible);
  const toggleFlag = useStore((s) => s.toggleRouteLogFlagVisible);
  const [open, setOpen] = useState(true);

  const counts = useMemo(() => {
    const c = { ADD: 0, KEEP: 0, REMOVE: 0, FLAG: 0, OVERFLOW: 0 };
    if (!routeId || routeLogsRouteId !== routeId) return c;
    routeLogs.forEach((l) => {
      if (l.Status__c !== 'Proposed') return;
      const { flag } = parseReason(l.Reason__c);
      if (c[flag] != null) c[flag] += 1;
    });
    return c;
  }, [routeId, routeLogsRouteId, routeLogs]);

  const total = FLAG_ORDER.reduce((sum, f) => sum + (counts[f] || 0), 0);
  if (!total) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="absolute bottom-6 left-2 z-10 flex items-center gap-1.5 px-2.5 py-1.5 bg-surface/95 border border-border rounded-lg shadow-md text-[11px] font-medium text-txt-secondary hover:text-txt hover:bg-surface transition"
        onClick={() => setOpen(true)}
        title="Show AI log flag layers"
      >
        <span className="flex items-center -space-x-1">
          {FLAG_ORDER.filter((f) => counts[f] > 0).slice(0, 4).map((f) => (
            <span
              key={f}
              className="w-2.5 h-2.5 rounded-full border border-white"
              style={{ background: FLAG_META[f].hex }}
            />
          ))}
        </span>
        AI Flags
      </button>
    );
  }

  return (
    <div className="absolute bottom-6 left-2 z-10 bg-surface/95 border border-border rounded-lg shadow-md px-3 py-2 min-w-[160px]">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-ai">AI Flags</span>
        <span className="text-[10px] text-txt-secondary tabular-nums">{total}</span>
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
      <div className="flex flex-col gap-0.5">
        {FLAG_ORDER.map((flag) => {
          const meta = FLAG_META[flag];
          const count = counts[flag] || 0;
          if (!count) return null;
          const visible = flagVisible[flag] !== false;
          return (
            <button
              key={flag}
              type="button"
              className={`flex items-center gap-2 w-full px-1 py-1 rounded-md text-left transition ${visible ? 'hover:bg-bg' : 'opacity-50 hover:opacity-70'}`}
              onClick={() => toggleFlag(flag)}
              title={visible ? `Hide ${meta.label} markers` : `Show ${meta.label} markers`}
            >
              <span
                className="w-3 h-3 rounded-full border border-white shadow-sm shrink-0"
                style={{ background: meta.hex }}
              />
              <span className="text-[11px] text-txt flex-1">{meta.label}</span>
              <span className="text-[10px] text-txt-secondary tabular-nums mr-1">{count}</span>
              <EyeIcon on={visible} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Small eye icon indicating layer visibility. */
function EyeIcon({ on }) {
  if (on) {
    return (
      <svg className="w-3.5 h-3.5 text-txt-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 text-txt-secondary shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228L3 3m13.532 13.532L21 21" />
    </svg>
  );
}
