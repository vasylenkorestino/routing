import { useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import StopRow from '../routes/StopRow';
import AccountTicketSearch from '../shared/AccountTicketSearch';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';

/** Reads child stops (sorted by Priority__c so numbering matches map markers). */
function getStops(route) {
  const raw = route.Routes__r?.records ?? route.Routes__r ?? route.points ?? [];
  return [...raw].sort((a, b) => (a.Priority__c ?? 9999) - (b.Priority__c ?? 9999));
}

/** Grace period before a removed stop is actually deleted on the server. */
const UNDO_MS = 5000;

/** Expandable list of routes with colored visibility checkboxes, AI context selectors and editable stops */
export default function RouteList({ routes = [] }) {
  const [expanded, setExpanded] = useState(null);
  const [query, setQuery] = useState('');
  const selectRoute = useStore((st) => st.selectRoute);
  const hiddenRouteIds = useStore((st) => st.hiddenRouteIds);
  const toggleRouteVisibility = useStore((st) => st.toggleRouteVisibility);
  const aiSelectedRouteIds = useStore((st) => st.aiSelectedRouteIds);
  const toggleRouteAiSelected = useStore((st) => st.toggleRouteAiSelected);
  const applyRouteStopOrder = useStore((st) => st.applyRouteStopOrder);

  if (!routes.length) {
    return <div className="text-txt-secondary text-sm text-center py-8">No routes for this date</div>;
  }

  /**
   * Optimistic remove with Undo: drops the stop from the list + map instantly,
   * then deletes on the server after a grace period unless the user undoes.
   */
  const removeStop = (route, stop) => {
    const routeId = route.Id ?? route.id;
    if (!routeId || !stop.Id) return;
    const snapshot = getStops(route).map((s) => ({ ...s }));
    const remaining = snapshot.filter((s) => s.Id !== stop.Id);
    applyRouteStopOrder(routeId, remaining);

    const timer = setTimeout(async () => {
      try {
        await routingApi.deletePoint(stop.Id);
      } catch (err) {
        applyRouteStopOrder(routeId, snapshot);
        toast.error(getErrorMessage(err));
      }
    }, UNDO_MS + 300);

    toast.action(
      `Removed "${stop.Account_Name__c || stop.Name || 'stop'}" from ${route.Name || 'route'}`,
      {
        label: 'Undo',
        onClick: () => {
          clearTimeout(timer);
          applyRouteStopOrder(routeId, snapshot);
        },
      },
      UNDO_MS,
    );
  };

  const q = query.trim().toLowerCase();
  const matchesQuery = (pt) =>
    !q ||
    (pt.Account_Name__c || '').toLowerCase().includes(q) ||
    (pt.Container_Address__c || '').toLowerCase().includes(q);

  return (
    <div>
      {/* Stop search — filters stops inside expanded routes */}
      <div className="px-1 pb-1.5">
        <input
          className="input-field w-full text-[12px]"
          placeholder="Filter stops by account or address…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="divide-y divide-border">
        {routes.map((route, idx) => {
          const color = route._color ?? '#2563eb';
          const id = route.Id ?? route.id;
          const stops = getStops(route);
          const open = expanded === (id ?? idx) || (q && stops.some(matchesQuery));
          const visible = !hiddenRouteIds[id];
          const aiSelected = !!aiSelectedRouteIds[id];
          const visibleStops = q ? stops.filter(matchesQuery) : stops;

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
                    setExpanded(open && !q ? null : (id ?? idx));
                    if (id) selectRoute(id);
                  }}
                >
                  <span className="flex-1 font-medium text-[13px] text-txt truncate">{route.Name ?? `Route ${idx + 1}`}</span>
                  <span className="text-xs text-txt-secondary truncate max-w-[90px]">{route.DriverName__c ?? ''}</span>
                  <span className="text-xs text-txt-secondary tabular-nums bg-bg px-1.5 py-0.5 rounded shrink-0">
                    {q ? `${visibleStops.length}/${stops.length}` : stops.length} stops
                  </span>
                  <span className="text-txt-secondary text-[10px] transition-transform duration-200 shrink-0" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>
                    ▶
                  </span>
                </button>
              </div>

              {open && (
                <div className="mt-1.5 ml-7 mb-1.5">
                  {/* Search accounts & tickets to add directly to this route */}
                  <AccountTicketSearch />
                </div>
              )}

              {open && visibleStops.length > 0 && (
                <div className="mt-1 ml-7 space-y-0.5">
                  {visibleStops.map((pt) => (
                    <StopRow
                      key={pt.Id ?? `${id}-${stops.indexOf(pt)}`}
                      stop={pt}
                      index={stops.indexOf(pt)}
                      color={color}
                      onRemove={(stop) => removeStop(route, stop)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
