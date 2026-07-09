/** Maps a bell notification to a single Account-shaped ticket for TicketLayer. */
function notificationToTicket(n) {
  return {
    Id: n.accountId,
    Name: n.accountName || n.caseNumber || 'Ticket',
    MALatitude__c: n.accountLat,
    MALongitude__c: n.accountLng,
    Description: n.ticketType || 'UCO Collection',
    caseRecordType: n.caseRecordType,
    ticketOpenedAt: n.ticketOpenedAt,
    caseNumber: n.caseNumber,
    ticketSubject: n.ticketSubject,
    ticketType: n.ticketType,
  };
}

/** Max tickets kept in the merged layer cache (oldest dropped first). */
const TICKET_CACHE_CAP = 1000;

/** Ticket type shown/loaded by default; all others are opt-in via the eye toggle. */
export const DEFAULT_TICKET_TYPE = 'UCO Collection';

/** Map slice — layer visibility, per-route visibility, map viewport */
const mapSlice = (set, get) => ({
  layers: {
    routes: { visible: true, data: [] },
    tickets: { visible: false, data: [] },
    shapes: { visible: false, data: [] },
  },
  hiddenRouteIds: {},
  selectedLayerTab: 'routes',
  selectedShapeId: null,
  mapCenter: { lat: 33.749, lng: -84.388 },
  mapZoom: 7,
  /** Account Id to focus on the map (opens ticket info window when layer is visible) */
  focusTicketId: null,
  /** True when tickets layer shows only one notification ticket (not full open-tickets list) */
  ticketsIsolated: false,
  /** Stop Id hovered in a list or on the map, and where the hover originated ('list' | 'map') */
  hoveredStopId: null,
  hoveredStopSource: null,
  /** Sticky stop selection from a list row click */
  selectedStopId: null,
  /** Current map viewport { minLat, maxLat, minLng, maxLng, zoom } — updated on map idle */
  mapBounds: null,
  /** Ticket types visible on the map (also drives which types are fetched). UCO only by default. */
  visibleTicketTypes: { [DEFAULT_TICKET_TYPE]: true },
  /** AI ticket suggestions keyed by routeId -> { byAccountId: { [accountId]: { confidence, reason } }, at } */
  ticketCandidates: {},

  setHoveredStopId: (hoveredStopId, source = 'list') =>
    set({ hoveredStopId, hoveredStopSource: hoveredStopId ? source : null }),

  setSelectedStopId: (id) =>
    set((s) => ({ selectedStopId: s.selectedStopId === id ? null : id })),

  setMapBounds: (mapBounds) => set({ mapBounds }),

  /** Flips a ticket type's visibility on the map (the panel loads it on first show). */
  toggleTicketTypeVisibility: (type) =>
    set((s) => ({ visibleTicketTypes: { ...s.visibleTicketTypes, [type]: !s.visibleTicketTypes[type] } })),

  setTicketTypeVisible: (type, visible) =>
    set((s) => ({ visibleTicketTypes: { ...s.visibleTicketTypes, [type]: visible } })),

  /** Resets visibility to the default (UCO only) — used when the tickets tab (re)loads. */
  resetTicketTypeVisibility: () => set({ visibleTicketTypes: { [DEFAULT_TICKET_TYPE]: true } }),

  /** Merges tickets into the layer cache by Id (existing entries refreshed, cap enforced). */
  mergeTicketLayerData: (incoming = []) => {
    if (!incoming.length) return;
    set((s) => {
      const byId = new Map(s.layers.tickets.data.map((t) => [t.CaseId ?? t.Id, t]));
      incoming.forEach((t) => byId.set(t.CaseId ?? t.Id, t));
      let data = [...byId.values()];
      if (data.length > TICKET_CACHE_CAP) data = data.slice(data.length - TICKET_CACHE_CAP);
      return { layers: { ...s.layers, tickets: { ...s.layers.tickets, data } } };
    });
  },

  /** Caches AI candidate tickets for a route (list of { accountId, confidence, reason }). */
  setTicketCandidates: (routeId, candidates = []) => {
    if (!routeId) return;
    const byAccountId = {};
    candidates.forEach((c) => {
      if (c?.accountId) byAccountId[c.accountId] = { confidence: c.confidence, reason: c.reason };
    });
    set((s) => ({ ticketCandidates: { ...s.ticketCandidates, [routeId]: { byAccountId, at: Date.now() } } }));
  },

  /** Drops cached AI candidates (stale after route stops change). */
  clearTicketCandidates: (routeId) =>
    set((s) => {
      if (!routeId) return { ticketCandidates: {} };
      if (!s.ticketCandidates[routeId]) return {};
      const next = { ...s.ticketCandidates };
      delete next[routeId];
      return { ticketCandidates: next };
    }),

  /** Pans the map to a ticket and optionally opens its marker popup */
  showTicketOnMap: ({ accountId, lat, lng }) => {
    const id = accountId;
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!id || Number.isNaN(latitude) || Number.isNaN(longitude)) return;
    set((s) => ({
      mapCenter: { lat: latitude, lng: longitude },
      mapZoom: 14,
      focusTicketId: id,
      layers: {
        ...s.layers,
        tickets: { ...s.layers.tickets, visible: true },
      },
    }));
  },

  /** Shows only the notification ticket on the map (single marker + InfoWindow). */
  showNotificationTicketOnMap: (notification) => {
    const ticket = notificationToTicket(notification);
    const lat = Number(ticket.MALatitude__c);
    const lng = Number(ticket.MALongitude__c);
    if (!ticket.Id || Number.isNaN(lat) || Number.isNaN(lng)) return;
    set((s) => ({
      ticketsIsolated: true,
      mapCenter: { lat, lng },
      mapZoom: 14,
      focusTicketId: ticket.Id,
      layers: {
        ...s.layers,
        tickets: { visible: true, data: [ticket] },
      },
    }));
  },

  clearTicketsIsolation: () => set({ ticketsIsolated: false }),

  clearFocusTicket: () => set({ focusTicketId: null }),

  toggleLayer: (name) =>
    set((s) => ({
      layers: {
        ...s.layers,
        [name]: { ...s.layers[name], visible: !s.layers[name].visible },
      },
    })),

  setLayerData: (name, data, resetVisibility = false) => {
    set((s) => ({
      layers: {
        ...s.layers,
        [name]: { ...s.layers[name], data },
      },
    }));
    if (name === 'routes' && resetVisibility) {
      // Show only the first route by default
      const hidden = {};
      data.forEach((r, i) => { if (i > 0) hidden[r.Id ?? r.id] = true; });
      set({ hiddenRouteIds: hidden });
    }
    if (name === 'tickets' && data.length !== 1) {
      set({ ticketsIsolated: false });
    }
  },

  toggleRouteVisibility: (routeId) =>
    set((s) => {
      const next = { ...s.hiddenRouteIds };
      if (next[routeId]) {
        delete next[routeId];
      } else {
        next[routeId] = true;
      }
      return { hiddenRouteIds: next };
    }),

  isRouteVisible: (routeId) => !get().hiddenRouteIds[routeId],

  /** Per-shape map visibility (empty = all shapes shown). */
  hiddenShapeIds: {},

  toggleShapeVisibility: (shapeId) =>
    set((s) => {
      const next = { ...s.hiddenShapeIds };
      if (next[shapeId]) delete next[shapeId]; else next[shapeId] = true;
      return { hiddenShapeIds: next };
    }),

  isShapeVisible: (shapeId) => !get().hiddenShapeIds[shapeId],

  setSelectedLayerTab: (selectedLayerTab) => set({ selectedLayerTab }),
  setSelectedShapeId: (selectedShapeId) => set({ selectedShapeId }),
  setMapCenter: (mapCenter) => set({ mapCenter }),
  setMapZoom: (mapZoom) => set({ mapZoom }),
});

export default mapSlice;
