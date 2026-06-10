import * as routingApi from '../api/routing';
import { getTodayET } from '../utils/date';
import { toast } from '../components/ui/Toast';
import { getErrorMessage } from '../utils/error';
import { applyPointStatusStyle, prepareGoogleRoutes } from '../utils/preparePoints';
import { ticketHasCoords } from '../utils/ticket';

const ROUTE_COLORS = ['#2563eb', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

/** Stamp a stable _color on each route based on its position in the full array */
function assignColors(routes) {
  return routes.map((r, i) => ({ ...r, _color: ROUTE_COLORS[i % ROUTE_COLORS.length] }));
}

/** Assign route colours then apply LWC-equivalent stop status display logic. */
function normalizeRoutes(routes) {
  return prepareGoogleRoutes(assignColors(routes));
}

/** Reads child stops whether Routes__r is an array or { records: [] }. */
function getRouteStops(route) {
  const r = route?.Routes__r;
  if (!r) return route?.points ?? [];
  if (Array.isArray(r)) return r;
  return r.records ?? route.points ?? [];
}

/** Writes prepared stops back onto a route header. */
function withPreparedStops(route, stops) {
  const prepared = Array.isArray(route?.Routes__r)
    ? stops
    : { ...(route?.Routes__r || {}), records: stops };
  return { ...route, points: stops, Routes__r: prepared };
}

function normalizeServiceDate(value) {
  if (!value) return null;
  const str = String(value);
  return str.includes('T') ? str.slice(0, 10) : str;
}
const routingSlice = (set, get) => ({
  isLoading: false,
  skipNextAutoLoad: false,
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

  loadRoutingData: async (options = {}) => {
    const { selectRouteId = null, skipTicketReset = false, skipDefaultRoute = false } = options;
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
      const routes = normalizeRoutes(data.routes ?? []);
      console.log('[loadRoutingData] response:', { routes: routes.length, drivers: data?.drivers?.length, serviceLocations: data?.serviceLocations?.length });

      let selectedRoute = null;
      if (selectRouteId) {
        selectedRoute = routes.find((r) => (r.Id ?? r.id) === selectRouteId) ?? null;
      } else if (routes.length > 0 && !skipDefaultRoute) {
        selectedRoute = routes[0];
      }

      set({
        routes,
        drivers: data.drivers ?? [],
        serviceLocations: data.serviceLocations ?? [],
        routeId: selectedRoute ? (selectedRoute.Id ?? selectedRoute.id) : null,
        route: selectedRoute,
        aiSelectedRouteIds: {},
      });

      get().setLayerData('routes', routes, false);
      if (selectRouteId && selectedRoute) {
        get().selectRoute(selectRouteId);
      } else if (routes.length > 0 && !skipDefaultRoute) {
        const hidden = {};
        routes.forEach((r, i) => { if (i > 0) hidden[r.Id ?? r.id] = true; });
        set({ hiddenRouteIds: hidden });
      } else if (skipDefaultRoute) {
        set({ hiddenRouteIds: {} });
      }

      if (!skipTicketReset) {
        get().setLayerData('tickets', [], true);
        get().clearTicketsIsolation?.();
      }
      if (!skipTicketReset) {
        get().setLayerData('shapes', [], true);
      }

      if (!get().sfInstanceUrl) {
        routingApi.getSfInstanceUrl().then((url) => set({ sfInstanceUrl: url })).catch(() => {});
      }

      return { routes, selectedRoute };
    } catch (err) {
      toast.error(getErrorMessage(err));
      return { routes: [], selectedRoute: null };
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

  /** Re-fetches routes for current filters; keeps the selected route when it still exists. */
  refreshRoutes: async () => {
    const { serviceDate, recordType, serviceLocation, routeId, routes: oldRoutes } = get();
    set({ isLoading: true });
    try {
      const params = {
        serviceDate: serviceDate || undefined,
        recordTypeName: recordType || undefined,
        serviceLocationId: serviceLocation || undefined,
      };
      const data = await routingApi.getRoutingData(params);
      const routes = normalizeRoutes(data.routes ?? []);
      set({
        routes,
        drivers: data.drivers ?? get().drivers,
        serviceLocations: data.serviceLocations ?? get().serviceLocations,
      });
      get().setLayerData('routes', routes);

      if (routeId) {
        const updated = routes.find((r) => (r.Id ?? r.id) === routeId) ?? null;
        if (updated) {
          set({ routeId, route: updated });
          return;
        }
      }
      const oldIds = new Set(oldRoutes.map((r) => r.Id ?? r.id));
      const newRoute = routes.find((r) => !oldIds.has(r.Id ?? r.id));
      if (newRoute) {
        set({ routeId: newRoute.Id ?? newRoute.id, route: newRoute });
      } else if (routes.length > 0 && !routeId) {
        set({ routeId: routes[0].Id ?? routes[0].id, route: routes[0] });
      } else if (routeId && !routes.some((r) => (r.Id ?? r.id) === routeId)) {
        set({ routeId: null, route: null });
      }
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      set({ isLoading: false });
    }
  },

  setServiceDate: (serviceDate) => set({ serviceDate }),
  setRecordType: (recordType) => set({ recordType }),
  setServiceLocation: (serviceLocation) => set({ serviceLocation }),

  /** One-click navigation from a bell notification: switch filters, open route, show single ticket. */
  navigateFromNotification: async (n) => {
    if (!n) return;

    if (!n.readAt) await get().markRead(n.id);

    const targetRecordType = n.routeRecordType || n.caseRecordType || get().recordType;
    const targetDate = normalizeServiceDate(n.routeServiceDate || n.suggestedDate) || get().serviceDate;
    const filtersChanged =
      targetRecordType !== get().recordType ||
      targetDate !== get().serviceDate;

    set({ skipNextAutoLoad: true });

    if (filtersChanged) {
      set({ recordType: targetRecordType, serviceDate: targetDate });
      const { selectedRoute } = await get().loadRoutingData({
        selectRouteId: n.googleRouteId || null,
        skipTicketReset: true,
        skipDefaultRoute: !n.googleRouteId,
      });
      if (n.googleRouteId && !selectedRoute) {
        toast.error('Route not found for the selected date and record type.');
      }
    } else if (n.googleRouteId) {
      get().selectRoute(n.googleRouteId);
      const found = get().routes.find((r) => (r.Id ?? r.id) === n.googleRouteId);
      if (!found) {
        toast.error('Route not found for the selected date and record type.');
      }
    }

    set({ skipNextAutoLoad: false });

    const { layers } = get();
    if (!layers.routes.visible) get().toggleLayer('routes');

    if (ticketHasCoords(n)) {
      get().showNotificationTicketOnMap(n);
    } else if (n.accountId) {
      toast.info('This ticket has no map coordinates.');
    }
  },

  /**
   * Apply a SF→AWS webhook patch to the in-memory route store. Driven by the
   * `sf-changed` SSE event so the UI reflects Salesforce changes without a
   * full re-fetch. Supports `google_route` (header upsert/delete) and
   * `route` (stop upsert/delete inside a header's Routes__r.records array).
   */
  applyServerPatch: ({ object, event, record }) => {
    if (!record) return;
    if (object === 'google_route') {
      applyGoogleRoutePatch(set, get, event, record);
    } else if (object === 'route') {
      applyRouteStopPatch(set, get, event, record);
    }
  },
});

/* ── helpers for selective server patches ───────────────────────────────── */

function getId(o) {
  return o && (o.Id ?? o.id) ? o.Id ?? o.id : null;
}

/** Upsert/remove a Google_Route__c header in the routes list. */
function applyGoogleRoutePatch(set, get, event, record) {
  const id = record.id || record.Id;
  if (!id) return;
  const current = get().routes || [];
  const existingIdx = current.findIndex((r) => getId(r) === id);

  if (event === 'deleted') {
    if (existingIdx === -1) return;
    const next = current.slice(0, existingIdx).concat(current.slice(existingIdx + 1));
    const patch = { routes: next };
    if (get().routeId === id) {
      patch.routeId = null;
      patch.route = null;
    }
    set(patch);
    if (get().setLayerData) get().setLayerData('routes', next);
    return;
  }

  const merged = mergeGoogleRoute(current[existingIdx], record);
  const next = existingIdx === -1 ? [...current, merged] : current.map((r, i) => (i === existingIdx ? merged : r));
  const colored = normalizeRoutes(next);
  const patch = { routes: colored };
  if (get().routeId === id) {
    patch.route = colored.find((r) => getId(r) === id) || null;
  }
  set(patch);
  if (get().setLayerData) get().setLayerData('routes', colored);
}

/** Upsert/remove a Route__c stop inside the parent Google_Route__c.Routes__r. */
function applyRouteStopPatch(set, get, event, record) {
  const stopId = record.id || record.Id;
  const parentId = record.googleRouteId || record.GRoute_Id__c || null;
  if (!stopId || !parentId) return;

  const current = get().routes || [];
  const parentIdx = current.findIndex((r) => getId(r) === parentId);
  if (parentIdx === -1) return;

  const parent = current[parentIdx];
  const stops = getRouteStops(parent).slice();

  if (event === 'deleted') {
    const filtered = stops.filter((s) => getId(s) !== stopId);
    if (filtered.length === stops.length) return;
    const updatedParent = withPreparedStops(parent, filtered);
    const next = current.map((r, i) => (i === parentIdx ? updatedParent : r));
    set({ routes: next, route: get().routeId === parentId ? updatedParent : get().route });
    return;
  }

  const stopIdx = stops.findIndex((s) => getId(s) === stopId);
  const merged = mergeRouteStop(stops[stopIdx], record);
  const nextStops = stopIdx === -1 ? [...stops, merged] : stops.map((s, i) => (i === stopIdx ? merged : s));
  const updatedParent = withPreparedStops(parent, nextStops);
  const next = current.map((r, i) => (i === parentIdx ? updatedParent : r));
  set({ routes: next, route: get().routeId === parentId ? updatedParent : get().route });
}

/** Map snake/camel webhook fields onto the SF-shaped record kept in store. */
function mergeGoogleRoute(existing, p) {
  const base = existing ? { ...existing } : { Id: p.id };
  return {
    ...base,
    Id: p.id,
    Name: p.name ?? base.Name,
    Service_Date__c: p.serviceDate ?? base.Service_Date__c,
    Driver__c: p.driverId ?? base.Driver__c,
    DriverName__c: p.driverName ?? base.DriverName__c,
    Driver_Name__c: p.driverNameField ?? base.Driver_Name__c,
    Service_Location_Start__c: p.serviceLocationStart ?? base.Service_Location_Start__c,
    Service_Location_End__c: p.serviceLocationEnd ?? base.Service_Location_End__c,
    Status__c: p.status ?? base.Status__c,
    Driver_Completed__c: nullable(p.driverCompleted, base.Driver_Completed__c),
    CompletionStatus__c: p.completionStatus ?? base.CompletionStatus__c,
    isLocked__c: nullable(p.isLocked, base.isLocked__c),
    isAI__c: nullable(p.isAI, base.isAI__c),
    isAIApproved__c: nullable(p.isAIApproved, base.isAIApproved__c),
    Total_Distance__c: p.totalDistance ?? base.Total_Distance__c,
    Total_Time__c: p.totalTime ?? base.Total_Time__c,
    Comment__c: p.comment ?? base.Comment__c,
    Polyline__c: p.polyline ?? base.Polyline__c,
    Notes__c: p.notes ?? base.Notes__c,
    Routes__r: base.Routes__r || { records: [] },
  };
}

/** Map webhook stop payload onto the SF-shaped Route__c kept in store. */
function mergeRouteStop(existing, p) {
  const base = existing ? { ...existing } : { Id: p.id };
  return {
    ...base,
    Id: p.id,
    Name: p.name ?? base.Name,
    Account__c: p.accountId ?? base.Account__c,
    AccountId__c: p.accountIdText ?? p.accountId ?? base.AccountId__c,
    Account_Name__c: p.accountName ?? base.Account_Name__c,
    GRoute_Id__c: p.googleRouteId ?? base.GRoute_Id__c,
    Priority__c: p.priority ?? base.Priority__c,
    Status__c: p.status ?? base.Status__c,
    ServiceType__c: p.serviceType ?? base.ServiceType__c,
    Gallons_Collected__c: nullable(p.gallonsCollected, base.Gallons_Collected__c),
    LastGallonsCollected__c: nullable(p.lastGallonsCollected, base.LastGallonsCollected__c),
    Notes__c: p.notes ?? base.Notes__c,
    Notes2__c: p.notes2 ?? base.Notes2__c,
    Driver_Notes__c: p.driverNotes ?? base.Driver_Notes__c,
    InvoiceNotes__c: p.invoiceNotes ?? base.InvoiceNotes__c,
    Latitude__c: p.latitude ?? base.Latitude__c,
    Longitude__c: p.longitude ?? base.Longitude__c,
    Container_Address__c: p.containerAddress ?? base.Container_Address__c,
    Service_Completed__c: nullable(p.serviceCompleted, base.Service_Completed__c),
    Inactive__c: nullable(p.inactive, base.Inactive__c),
    Fixed_point__c: nullable(p.fixedPoint, base.Fixed_point__c),
    isAI__c: nullable(p.isAI, base.isAI__c),
    Last_Route_Serviced_Date__c: p.lastRouteServicedDate ?? base.Last_Route_Serviced_Date__c,
  };
  applyPointStatusStyle(merged);
  return merged;
}

function nullable(incoming, fallback) {
  return incoming === undefined ? fallback : incoming;
}

export default routingSlice;
