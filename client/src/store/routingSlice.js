import * as routingApi from '../api/routing';
import { getTodayET } from '../utils/date';
import { toast } from '../components/ui/Toast';
import { getErrorMessage } from '../utils/error';

const ROUTE_COLORS = ['#2563eb', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

/** Stamp a stable _color on each route based on its position in the full array */
function assignColors(routes) {
  return routes.map((r, i) => ({ ...r, _color: ROUTE_COLORS[i % ROUTE_COLORS.length] }));
}

/** Routing slice — route list, filters, and selected route state */
const routingSlice = (set, get) => ({
  isLoading: false,
  serviceDate: getTodayET(),
  recordType: 'EZG',
  recordTypes: ['EZG', 'ENJ'],
  serviceLocation: null,
  serviceLocations: [],
  routeId: null,
  route: null,
  routes: [],
  driverId: null,
  drivers: [],
  sfInstanceUrl: null,
  aiSelectedRouteIds: {},

  toggleRouteAiSelected: (routeId) =>
    set((s) => {
      const next = { ...s.aiSelectedRouteIds };
      if (next[routeId]) delete next[routeId];
      else next[routeId] = true;
      return { aiSelectedRouteIds: next };
    }),

  clearAiSelection: () => set({ aiSelectedRouteIds: {} }),

  loadRoutingData: async () => {
    const { serviceDate, recordType, serviceLocation } = get();
    set({ isLoading: true });
    try {
      const params = {
        serviceDate: serviceDate || undefined,
        recordTypeName: recordType || undefined,
        serviceLocationId: serviceLocation || undefined,
      };
      console.log('[loadRoutingData] params:', params);
      const data = await routingApi.getRoutingData(params);
      const routes = assignColors(data.routes ?? []);
      console.log('[loadRoutingData] response:', { routes: routes.length, drivers: data?.drivers?.length, serviceLocations: data?.serviceLocations?.length });
      const firstRoute = routes.length > 0 ? routes[0] : null;
      set({
        routes,
        drivers: data.drivers ?? [],
        serviceLocations: data.serviceLocations ?? [],
        routeId: firstRoute ? (firstRoute.Id ?? firstRoute.id) : null,
        route: firstRoute,
        aiSelectedRouteIds: {},
      });
      get().setLayerData('routes', routes, true);
      get().setLayerData('tickets', [], true);
      get().setLayerData('shapes', [], true);

      if (!get().sfInstanceUrl) {
        routingApi.getSfInstanceUrl().then((url) => set({ sfInstanceUrl: url })).catch(() => {});
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      set({ isLoading: false });
    }
  },

  selectRoute: (routeId) => {
    const route = get().routes.find((r) => (r.Id ?? r.id) === routeId) ?? null;
    set({ routeId, route });
    if (routeId) {
      const hidden = {};
      get().routes.forEach((r) => {
        const id = r.Id ?? r.id;
        if (id !== routeId) hidden[id] = true;
      });
      set({ hiddenRouteIds: hidden });
    }
  },

  refreshRoutes: async () => {
    const { serviceDate, recordType, serviceLocation, routeId, routes: oldRoutes } = get();
    const params = {
      serviceDate: serviceDate || undefined,
      recordTypeName: recordType || undefined,
      serviceLocationId: serviceLocation || undefined,
    };
    const data = await routingApi.getRoutingData(params);
    const routes = assignColors(data.routes ?? []);
    set({
      routes,
      drivers: data.drivers ?? get().drivers,
      serviceLocations: data.serviceLocations ?? get().serviceLocations,
    });
    get().setLayerData('routes', routes);

    if (routeId) {
      const updated = routes.find((r) => (r.Id ?? r.id) === routeId) ?? null;
      if (updated) {
        set({ route: updated });
        return;
      }
    }
    const oldIds = new Set(oldRoutes.map((r) => r.Id ?? r.id));
    const newRoute = routes.find((r) => !oldIds.has(r.Id ?? r.id));
    if (newRoute) {
      set({ routeId: newRoute.Id ?? newRoute.id, route: newRoute });
    } else if (routes.length > 0 && !routeId) {
      set({ routeId: routes[0].Id ?? routes[0].id, route: routes[0] });
    }
  },

  setServiceDate: (serviceDate) => set({ serviceDate }),
  setRecordType: (recordType) => set({ recordType }),
  setServiceLocation: (serviceLocation) => set({ serviceLocation }),
});

export default routingSlice;
