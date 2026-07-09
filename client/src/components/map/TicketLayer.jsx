import React, { useState, useCallback, useEffect } from 'react';
import { Marker, InfoWindow } from '@react-google-maps/api';
import useStore from '../../store';
import * as routingApi from '../../api/routing';
import { toast } from '../ui/Toast';
import { getErrorMessage } from '../../utils/error';
import TicketDetailFields from '../shared/TicketDetailFields';
import { ticketHasCoords, ticketLat, ticketLng, ticketNotes } from '../../utils/ticket';
import { formatMiles } from '../../utils/routeDistance';
import { ticketMarkerIcon } from '../../utils/ticketMarker';
import useOffRouteDistances, { ticketKey } from '../../hooks/useOffRouteDistances';
import { isRouteCompleted } from '../../utils/route';

const EMPTY_CANDIDATES = {};

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
  const ticketsIsolated = useStore((s) => s.ticketsIsolated);
  const candidates = useStore((s) =>
    (s.routeId && s.ticketCandidates[s.routeId]?.byAccountId) || EMPTY_CANDIDATES);
  const visibleTicketTypes = useStore((s) => s.visibleTicketTypes);
  const distances = useOffRouteDistances(tickets);
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
    if (isRouteCompleted(route)) {
      toast.info('Route is completed — stops cannot be added');
      return;
    }
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
  }, [routeId, route, refreshRoutes]);

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

  // Only render markers for ticket types the user has enabled (eye toggle). In
  // isolated mode (single notification ticket) the visibility filter is skipped.
  const valid = tickets.filter(
    (t) => ticketHasCoords(t) && (ticketsIsolated || visibleTicketTypes[t.Description]),
  );

  return (
    <>
      {valid.map((t, i) => {
        const candidate = candidates[t.Id];
        const mi = distances.get(ticketKey(t));
        const tooltip = [
          t.Name,
          t.Description,
          mi != null ? `≈${formatMiles(mi)} off route` : null,
          candidate ? `✦ AI suggested (${candidate.confidence ?? 0}%)` : null,
        ].filter(Boolean).join(' · ');
        return (
          <Marker
            key={ticketKey(t) ?? i}
            position={{ lat: Number(ticketLat(t)), lng: Number(ticketLng(t)) }}
            onClick={() => setSelected(t)}
            title={tooltip}
            zIndex={candidate ? 5000 : undefined}
            icon={ticketMarkerIcon(t.Description, { candidate: !!candidate })}
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
            {candidates[selected.Id]?.reason && (
              <div style={{ fontSize: 11, color: '#7c3aed', marginTop: 4, fontWeight: 500 }}>
                ✦ AI: {candidates[selected.Id].reason}
              </div>
            )}
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
