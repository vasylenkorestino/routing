import React, { useState, useCallback, useEffect } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
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
};

/** Ticket markers on map — Account objects with Description = ticket type */
export default function TicketLayer({ tickets = [] }) {
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const sfInstanceUrl = useStore((s) => s.sfInstanceUrl);
  const routeId = useStore((s) => s.routeId);
  const route = useStore((s) => s.route);
  const refreshRoutes = useStore((s) => s.refreshRoutes);
  const focusTicketId = useStore((s) => s.focusTicketId);
  const clearFocusTicket = useStore((s) => s.clearFocusTicket);
  const showTicketOnMap = useStore((s) => s.showTicketOnMap);
  const handleClose = useCallback(() => setSelected(null), []);

  useEffect(() => {
    if (!focusTicketId) return;
    const match = tickets.find((t) => t.Id === focusTicketId);
    if (match && ticketHasCoords(match)) {
      setSelected(match);
    }
    clearFocusTicket();
  }, [focusTicketId, tickets, clearFocusTicket]);

  const handleAdd = useCallback(async (ticket) => {
    if (!routeId) return;
    setAdding(true);
    try {
      await routingApi.addPoint({
        accountId: ticket.Id,
        routeId,
        ticketType: ticket.Description || '',
      });
      await refreshRoutes();
      setSelected(null);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }, [routeId, refreshRoutes]);

  const handleShowOnMap = useCallback((ticket) => {
    if (!ticketHasCoords(ticket)) {
      toast.info('This ticket has no map coordinates.');
      return;
    }
    showTicketOnMap({
      accountId: ticket.Id,
      lat: ticketLat(ticket),
      lng: ticketLng(ticket),
    });
    setSelected(ticket);
  }, [showTicketOnMap]);

  const valid = tickets.filter(ticketHasCoords);

  return (
    <>
      {valid.map((t, i) => {
        const color = TICKET_COLORS[t.Description] ?? '#64748b';
        return (
          <Marker
            key={t.Id ?? i}
            position={{ lat: Number(ticketLat(t)), lng: Number(ticketLng(t)) }}
            onClick={() => setSelected(t)}
            icon={{
              path: window.google?.maps?.SymbolPath?.BACKWARD_CLOSED_ARROW ?? 3,
              fillColor: color,
              fillOpacity: 0.9,
              strokeColor: '#fff',
              strokeWeight: 1.5,
              scale: 5,
            }}
          />
        );
      })}

      {selected && (
        <InfoWindow
          position={{ lat: Number(ticketLat(selected)), lng: Number(ticketLng(selected)) }}
          onCloseClick={handleClose}
        >
          <div style={{ fontFamily: 'sans-serif', fontSize: 13, minWidth: 200 }}>
            <a
              href={sfInstanceUrl && selected.Id ? `${sfInstanceUrl}/${selected.Id}` : '#'}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontWeight: 600, color: '#2563eb', fontSize: 14, marginBottom: 4, display: 'block', textDecoration: 'none', cursor: 'pointer' }}
              onMouseEnter={(e) => { e.target.style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { e.target.style.textDecoration = 'none'; }}
            >{selected.Name ?? 'Account'}</a>
            {selected.ShippingStreet && (
              <div style={{ fontSize: 12, color: '#666', marginBottom: 2 }}>
                <strong>Address:</strong> {selected.ShippingStreet}
                {selected.ShippingCity ? `, ${selected.ShippingCity}` : ''}
                {selected.ShippingState ? `, ${selected.ShippingState}` : ''}
              </div>
            )}
            <TicketDetailFields ticket={selected} variant="popup" />
            {ticketNotes(selected) && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{ticketNotes(selected)}</div>
            )}
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button
                type="button"
                onClick={() => handleShowOnMap(selected)}
                style={{
                  padding: '5px 14px', fontSize: 12, fontWeight: 600,
                  color: '#2563eb', background: '#fff', border: '1px solid #2563eb', borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                Show on map
              </button>
              {routeId && (
                <button
                  type="button"
                  onClick={() => handleAdd(selected)}
                  disabled={adding}
                  style={{
                    padding: '5px 14px', fontSize: 12, fontWeight: 600,
                    color: '#fff', background: '#2563eb', border: 'none', borderRadius: 6,
                    cursor: adding ? 'wait' : 'pointer', opacity: adding ? 0.6 : 1,
                  }}
                >
                  {adding ? 'Adding…' : `Add to ${route?.Name || 'Route'}`}
                </button>
              )}
            </div>
          </div>
        </InfoWindow>
      )}
    </>
  );
}
