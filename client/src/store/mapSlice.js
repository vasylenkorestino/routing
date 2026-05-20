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
