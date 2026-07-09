import { useMemo, useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import TicketDetailFields from '../shared/TicketDetailFields';
import { ticketHasCoords, ticketLat, ticketLng, ticketNotes } from '../../utils/ticket';
import { formatMiles } from '../../utils/routeDistance';
import { TICKET_COLORS } from '../../utils/ticketMarker';
import EyeIcon from '../ui/EyeIcon';
import useOffRouteDistances, { ticketKey } from '../../hooks/useOffRouteDistances';
import { isRouteCompleted } from '../../utils/route';

const EMPTY_CANDIDATES = {};

/** Chip classes for an off-route distance (green = quick grab, amber = short detour). */
function distanceChipCls(mi) {
  if (mi < 1) return 'bg-success-bg text-success';
  if (mi < 3) return 'bg-warning-bg text-warning';
  return 'bg-bg text-txt-secondary';
}

/**
 * Lists every known ticket type as a row with an eye toggle that shows/hides that
 * type on the map (loading it on first show). Only UCO Collection is visible by
 * default. Expanding a type reveals its tickets with Add / Show-on-map actions.
 */
export default function TicketList({ tickets = [], onToggleType, loadingType = null }) {
  const showTicketOnMap = useStore((st) => st.showTicketOnMap);
  const storeRouteId = useStore((st) => st.routeId);
  const routes = useStore((st) => st.routes);
  const sfInstanceUrl = useStore((st) => st.sfInstanceUrl);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const setTicketCandidates = useStore((st) => st.setTicketCandidates);
  const clearTicketCandidates = useStore((st) => st.clearTicketCandidates);
  const candidates = useStore((st) =>
    (st.routeId && st.ticketCandidates[st.routeId]?.byAccountId) || EMPTY_CANDIDATES);
  const visibleTicketTypes = useStore((st) => st.visibleTicketTypes);
  const [expanded, setExpanded] = useState(null);
  const [adding, setAdding] = useState(null);
  const [bulkAdding, setBulkAdding] = useState(false);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const routeId = storeRouteId || selectedRouteId;

  const distances = useOffRouteDistances(tickets);

  const groups = useMemo(() => {
    const map = {};
    tickets.forEach((t) => {
      const type = t.Description || 'Other';
      if (!map[type]) map[type] = [];
      map[type].push(t);
    });
    // AI candidates first (by confidence), then nearest to the route, then original order.
    const rank = (t) => {
      const c = candidates[t.Id];
      if (c) return -1000 + (100 - (c.confidence ?? 0));
      const mi = distances.get(ticketKey(t));
      return mi ?? 9999;
    };
    Object.values(map).forEach((list) => list.sort((a, b) => rank(a) - rank(b)));
    return map;
  }, [tickets, candidates, distances]);

  // Every known type + any present in the data, ordered by loaded count then name.
  const orderedTypes = useMemo(() => {
    const all = new Set([...Object.keys(TICKET_COLORS), ...Object.keys(groups)]);
    return [...all].sort((a, b) => (groups[b]?.length ?? 0) - (groups[a]?.length ?? 0) || a.localeCompare(b));
  }, [groups]);

  /** Removes one account from the cached AI suggestions after it was added. */
  const dropCandidate = (accountId) => {
    if (!storeRouteId || !candidates[accountId]) return;
    const remaining = Object.entries(candidates)
      .filter(([id]) => id !== accountId)
      .map(([id, c]) => ({ accountId: id, ...c }));
    setTicketCandidates(storeRouteId, remaining);
  };

  const handleAdd = async (ticket) => {
    if (!routeId) {
      toast.info('Please select a route first');
      return;
    }
    if (isRouteCompleted(routes.find((r) => r.Id === routeId))) {
      toast.info('Route is completed — stops cannot be added');
      return;
    }
    const id = ticket.Id;
    setAdding(id);
    try {
      await routingApi.addPoint({
        accountId: ticket.Id,
        routeId,
        ticketType: ticket.Description || '',
      });
      dropCandidate(ticket.Id);
      await refreshRoutes();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(null);
    }
  };

  /** Adds every AI-suggested ticket sequentially, then refreshes once. */
  const handleAddAllSuggested = async () => {
    if (!routeId || bulkAdding) return;
    if (isRouteCompleted(routes.find((r) => r.Id === routeId))) {
      toast.info('Route is completed — stops cannot be added');
      return;
    }
    const seen = new Set();
    const toAdd = tickets.filter((t) => {
      if (!candidates[t.Id] || seen.has(t.Id)) return false;
      seen.add(t.Id);
      return true;
    });
    if (!toAdd.length) return;
    setBulkAdding(true);
    const failed = [];
    for (const t of toAdd) {
      try {
        // Sequential on purpose — each add triggers an async server re-optimize.
        await routingApi.addPoint({ accountId: t.Id, routeId, ticketType: t.Description || '' });
      } catch {
        failed.push(t.Name || t.Id);
      }
    }
    clearTicketCandidates(storeRouteId || routeId);
    await refreshRoutes();
    setBulkAdding(false);
    if (failed.length) {
      toast.error(`Added ${toAdd.length - failed.length} of ${toAdd.length}. Failed: ${failed.join(', ')}`);
    } else {
      toast.success(`${toAdd.length} suggested ticket${toAdd.length === 1 ? '' : 's'} added to the route`);
    }
  };

  const candidateCount = tickets.reduce((n, t) => n + (candidates[t.Id] ? 1 : 0), 0);

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 pb-1 text-[10px] text-txt-secondary">
        <EyeIcon open className="w-3.5 h-3.5" />
        <span>Toggle a type's eye to show it on the map</span>
      </div>
      {!storeRouteId && routes.length > 0 && (
        <div className="mb-2">
          <select
            className="input-field w-full text-[12px]"
            value={selectedRouteId}
            onChange={(e) => setSelectedRouteId(e.target.value)}
          >
            <option value="">Select route to add to…</option>
            {routes.filter((r) => !isRouteCompleted(r)).map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
          </select>
        </div>
      )}

      {/* Bulk-add AI suggestions */}
      {candidateCount > 0 && routeId && (
        <button
          type="button"
          className="w-full mb-1 px-3 py-2 rounded-lg bg-ai text-white text-[12px] font-semibold hover:bg-ai-hover transition disabled:opacity-50 flex items-center justify-center gap-1.5"
          onClick={handleAddAllSuggested}
          disabled={bulkAdding}
        >
          <span>✦</span>
          {bulkAdding ? 'Adding…' : `Add all ${candidateCount} suggested ticket${candidateCount === 1 ? '' : 's'}`}
        </button>
      )}

      {orderedTypes.map((type) => {
        const items = groups[type] ?? [];
        const color = TICKET_COLORS[type] ?? '#64748b';
        const isOpen = expanded === type;
        const visible = !!visibleTicketTypes[type];
        const isLoading = loadingType === type;
        const groupCandidates = items.filter((t) => candidates[t.Id]).length;

        return (
          <div key={type} className={`rounded-lg border overflow-hidden transition ${visible ? 'border-border' : 'border-border/60'}`}>
            {/* Group header */}
            <div className={`flex items-center gap-1.5 w-full px-2 py-2 ${visible ? '' : 'opacity-60'}`}>
              {/* Eye toggle — shows/hides this type on the map (loads on first show) */}
              <button
                type="button"
                className={`w-6 h-6 flex items-center justify-center rounded-md shrink-0 transition ${
                  visible ? 'text-primary hover:bg-primary/10' : 'text-txt-secondary hover:bg-bg'
                }`}
                onClick={(e) => { e.stopPropagation(); onToggleType?.(type); }}
                title={visible ? `Hide ${type} on map` : `Show ${type} on map`}
              >
                {isLoading
                  ? <span className="w-3.5 h-3.5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                  : <EyeIcon open={visible} className="w-4 h-4" />}
              </button>

              <button
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
                onClick={() => setExpanded(isOpen ? null : type)}
              >
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: color }} />
                <span className="flex-1 font-medium text-[13px] text-txt truncate">{type}</span>
                {groupCandidates > 0 && (
                  <span className="text-[10px] font-semibold text-ai bg-ai/10 px-1.5 py-0.5 rounded shrink-0" title="AI-suggested tickets in this group">
                    ✦ {groupCandidates}
                  </span>
                )}
                {items.length > 0 && (
                  <span className="text-[11px] text-txt-secondary bg-bg px-1.5 py-0.5 rounded shrink-0 tabular-nums">
                    {items.length}
                  </span>
                )}
                <span
                  className="text-txt-secondary text-[10px] transition-transform duration-200 shrink-0"
                  style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0)' }}
                >
                  ▶
                </span>
              </button>
            </div>

            {/* Ticket items */}
            {isOpen && items.length === 0 && (
              <div className="border-t border-border px-3 py-2 text-[11px] text-txt-secondary">
                {isLoading ? 'Loading…' : visible ? 'No tickets of this type in the current area.' : 'Click the eye to load & show this type.'}
              </div>
            )}
            {isOpen && items.length > 0 && (
              <div className="border-t border-border divide-y divide-border/50">
                {items.map((t, i) => {
                  const candidate = candidates[t.Id];
                  const mi = distances.get(ticketKey(t));
                  return (
                    <div
                      key={ticketKey(t) ?? i}
                      className={`flex items-center gap-2 px-3 py-2 transition ${
                        candidate ? 'bg-ai/5 hover:bg-ai/10' : 'hover:bg-bg/30'
                      }`}
                    >
                      {/* Clickable account info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <a
                            href={sfInstanceUrl && t.Id ? `${sfInstanceUrl}/${t.Id}` : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-[13px] text-primary truncate hover:underline"
                          >
                            {t.Name ?? 'Account'}
                          </a>
                          {candidate && (
                            <span
                              className="text-[9px] font-bold text-white bg-ai rounded px-1.5 py-px shrink-0"
                              title={`AI suggested (${candidate.confidence ?? 0}%): ${candidate.reason || ''}`}
                            >
                              ✦ AI
                            </span>
                          )}
                          {mi != null && (
                            <span
                              className={`text-[9px] font-semibold px-1.5 py-px rounded tabular-nums shrink-0 ${distanceChipCls(mi)}`}
                              title="Approximate distance from the selected route's path"
                            >
                              ≈{formatMiles(mi)} off route
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-txt-secondary truncate">
                          {[t.ShippingStreet, t.ShippingCity, t.ShippingState].filter(Boolean).join(', ')}
                        </div>
                        <TicketDetailFields ticket={t} />
                        {candidate?.reason && (
                          <div className="text-[10px] text-ai truncate mt-0.5" title={candidate.reason}>
                            ✦ {candidate.reason}
                          </div>
                        )}
                        {ticketNotes(t) && (
                          <div className="text-[10px] text-txt-secondary truncate mt-0.5 italic">
                            {ticketNotes(t)}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 flex-col gap-1">
                        {ticketHasCoords(t) && (
                          <button
                            type="button"
                            className="px-2.5 py-1 text-[11px] font-semibold rounded border border-primary text-primary hover:bg-primary/5 transition"
                            onClick={(e) => {
                              e.stopPropagation();
                              showTicketOnMap({
                                accountId: t.Id,
                                lat: ticketLat(t),
                                lng: ticketLng(t),
                              });
                            }}
                          >
                            Show on map
                          </button>
                        )}
                        <button
                          type="button"
                          className="px-2.5 py-1 text-[11px] font-semibold rounded bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition"
                          onClick={(e) => { e.stopPropagation(); handleAdd(t); }}
                          disabled={adding === t.Id || bulkAdding || !routeId}
                          title={routeId ? 'Add to selected route' : 'Select a route first'}
                        >
                          {adding === t.Id ? '…' : 'Add'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
