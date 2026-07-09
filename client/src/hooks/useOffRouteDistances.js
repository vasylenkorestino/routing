import { useMemo } from 'react';
import useStore from '../store';
import { buildRoutePath, offRouteMiles } from '../utils/routeDistance';
import { ticketHasCoords, ticketLat, ticketLng } from '../utils/ticket';

/** Stable key for a ticket row (CaseId preferred; Id is the Account Id). */
export const ticketKey = (t) => t.CaseId ?? t.Id;

/**
 * Returns a Map of ticketKey -> miles off the selected route's path.
 * Empty map when no route is selected. Memoized per route + ticket set.
 */
export default function useOffRouteDistances(tickets = []) {
  const route = useStore((s) => s.route);

  return useMemo(() => {
    const result = new Map();
    if (!route || !tickets.length) return result;
    const path = buildRoutePath(route);
    if (!path.length) return result;
    tickets.forEach((t) => {
      if (!ticketHasCoords(t)) return;
      const mi = offRouteMiles({ lat: Number(ticketLat(t)), lng: Number(ticketLng(t)) }, path);
      if (mi != null) result.set(ticketKey(t), mi);
    });
    return result;
  }, [route, tickets]);
}
