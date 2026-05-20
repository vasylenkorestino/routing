import { useState } from 'react';
import useStore from '../../store';

/** Expandable list of routes with colored visibility checkboxes and AI context selectors */
export default function RouteList({ routes = [] }) {
  const [expanded, setExpanded] = useState(null);
  const selectRoute = useStore((st) => st.selectRoute);
  const hiddenRouteIds = useStore((st) => st.hiddenRouteIds);
  const toggleRouteVisibility = useStore((st) => st.toggleRouteVisibility);
  const aiSelectedRouteIds = useStore((st) => st.aiSelectedRouteIds);
  const toggleRouteAiSelected = useStore((st) => st.toggleRouteAiSelected);

  if (!routes.length) {
    return <div className="text-txt-secondary text-sm text-center py-8">No routes for this date</div>;
  }

  return (
    <div className="divide-y divide-border">
      {routes.map((route, idx) => {
        const color = route._color ?? '#2563eb';
        const id = route.Id ?? route.id;
        const stops = route.Routes__r?.records ?? route.Routes__r ?? route.points ?? [];
        const open = expanded === (id ?? idx);
        const visible = !hiddenRouteIds[id];
        const aiSelected = !!aiSelectedRouteIds[id];

        return (
          <div key={id ?? idx} className="py-1.5">
            <div className="flex items-center gap-1.5 px-1">
              {/* AI context checkbox (sparkle) */}
              <button
                className={`w-5 h-5 rounded shrink-0 border flex items-center justify-center transition-all ${
                  aiSelected ? 'bg-ai border-ai text-white' : 'bg-transparent border-border text-txt-secondary hover:border-ai hover:text-ai'
                }`}
                onClick={(e) => { e.stopPropagation(); if (id) toggleRouteAiSelected(id); }}
                title={aiSelected ? 'Remove from AI context' : 'Add to AI context'}
                disabled={!id}
              >
                <span className="text-[11px] leading-none">✦</span>
              </button>

              {/* Colored visibility checkbox */}
              <button
                className="w-5 h-5 rounded shrink-0 border-2 flex items-center justify-center transition-all"
                style={{
                  borderColor: color,
                  background: visible ? color : 'transparent',
                }}
                onClick={(e) => { e.stopPropagation(); toggleRouteVisibility(id); }}
                title={visible ? 'Hide on map' : 'Show on map'}
              >
                {visible && (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
              </button>

              {/* Route info — click to select & expand */}
              <button
                className="flex items-center gap-2 flex-1 min-w-0 text-left py-1 rounded hover:bg-bg transition group"
                onClick={() => {
                  setExpanded(open ? null : (id ?? idx));
                  if (id) selectRoute(id);
                }}
              >
                <span className="flex-1 font-medium text-[13px] text-txt truncate">{route.Name ?? `Route ${idx + 1}`}</span>
                <span className="text-xs text-txt-secondary truncate max-w-[90px]">{route.DriverName__c ?? ''}</span>
                <span className="text-xs text-txt-secondary tabular-nums bg-bg px-1.5 py-0.5 rounded shrink-0">
                  {stops.length} stops
                </span>
                <span className="text-txt-secondary text-[10px] transition-transform duration-200 shrink-0" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>
                  ▶
                </span>
              </button>
            </div>

            {open && stops.length > 0 && (
              <div className="mt-1 ml-7 space-y-0.5">
                {stops.map((pt, pIdx) => (
                  <div key={pt.Id ?? pIdx} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-bg text-xs transition">
                    <div
                      className="w-5 h-5 rounded-full text-white flex items-center justify-center text-[10px] font-semibold shrink-0"
                      style={{ background: color }}
                    >
                      {pIdx + 1}
                    </div>
                    <span className="flex-1 text-txt truncate">{pt.Container_Address__c ?? pt.Account_Name__c ?? pt.Name ?? '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
