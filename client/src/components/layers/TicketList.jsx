import { useMemo, useState } from 'react';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import TicketDetailFields from '../shared/TicketDetailFields';
import { ticketHasCoords, ticketLat, ticketLng, ticketNotes } from '../../utils/ticket';

const TICKET_COLORS = {
  'Deliver Container': '#2563eb',
  'Grease Trap Cleaning': '#ec4899',
  'Pressure Washing': '#f59e0b',
  'Relocate Container': '#22c55e',
  'Remove Container': '#14b8a6',
  'Remove FSP Container': '#6366f1',
  'Replace Container': '#8b5cf6',
  'Replace Grill': '#a855f7',
  'Rotisserie Water': '#22c55e',
  'UCO Collection': '#f97316',
  'Future Services': '#64748b',
};

/** Groups tickets by Description (Case Type) and renders collapsible sections with Add button */
export default function TicketList({ tickets = [] }) {
  const showTicketOnMap = useStore((st) => st.showTicketOnMap);
  const storeRouteId = useStore((st) => st.routeId);
  const routes = useStore((st) => st.routes);
  const sfInstanceUrl = useStore((st) => st.sfInstanceUrl);
  const refreshRoutes = useStore((st) => st.refreshRoutes);
  const [expanded, setExpanded] = useState(null);
  const [adding, setAdding] = useState(null);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const routeId = storeRouteId || selectedRouteId;

  const groups = useMemo(() => {
    const map = {};
    tickets.forEach((t) => {
      const type = t.Description || 'Other';
      if (!map[type]) map[type] = [];
      map[type].push(t);
    });
    return Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  }, [tickets]);

  if (!tickets.length) {
    return <div className="text-txt-secondary text-sm text-center py-8">No tickets loaded. Click the eye icon to toggle visibility.</div>;
  }

  const handleAdd = async (ticket) => {
    if (!routeId) {
      toast.info('Please select a route first');
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
      await refreshRoutes();
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="space-y-1">
      {!storeRouteId && routes.length > 0 && (
        <div className="mb-2">
          <select
            className="input-field w-full text-[12px]"
            value={selectedRouteId}
            onChange={(e) => setSelectedRouteId(e.target.value)}
          >
            <option value="">Select route to add to…</option>
            {routes.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
          </select>
        </div>
      )}
      {groups.map(([type, items]) => {
        const color = TICKET_COLORS[type] ?? '#64748b';
        const isOpen = expanded === type;

        return (
          <div key={type} className="rounded-lg border border-border overflow-hidden">
            {/* Group header */}
            <button
              className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-bg/50 transition"
              onClick={() => setExpanded(isOpen ? null : type)}
            >
              <span
                className="w-3 h-3 rounded-sm shrink-0"
                style={{ backgroundColor: color }}
              />
              <span className="flex-1 font-medium text-[13px] text-txt">{type}</span>
              <span className="text-[11px] text-txt-secondary bg-bg px-1.5 py-0.5 rounded">
                {items.length} ticket{items.length !== 1 ? 's' : ''}
              </span>
              <span
                className="text-txt-secondary text-[10px] transition-transform duration-200"
                style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0)' }}
              >
                ▶
              </span>
            </button>

            {/* Ticket items */}
            {isOpen && (
              <div className="border-t border-border divide-y divide-border/50">
                {items.map((t, i) => (
                  <div
                    key={t.Id ?? i}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-bg/30 transition"
                  >
                    {/* Clickable account info */}
                    <div className="flex-1 min-w-0">
                      <a
                        href={sfInstanceUrl && t.Id ? `${sfInstanceUrl}/${t.Id}` : '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-[13px] text-primary truncate hover:underline block"
                      >
                        {t.Name ?? 'Account'}
                      </a>
                      <div className="text-[11px] text-txt-secondary truncate">
                        {[t.ShippingStreet, t.ShippingCity, t.ShippingState].filter(Boolean).join(', ')}
                      </div>
                      <TicketDetailFields ticket={t} />
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
                        disabled={adding === t.Id || !routeId}
                        title={routeId ? 'Add to selected route' : 'Select a route first'}
                      >
                        {adding === t.Id ? '…' : 'Add'}
                      </button>
                    </div>
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
