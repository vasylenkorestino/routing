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

  setSelectedLayerTab: (selectedLayerTab) => set({ selectedLayerTab }),
  setSelectedShapeId: (selectedShapeId) => set({ selectedShapeId }),
  setMapCenter: (mapCenter) => set({ mapCenter }),
  setMapZoom: (mapZoom) => set({ mapZoom }),
});

export default mapSlice;
