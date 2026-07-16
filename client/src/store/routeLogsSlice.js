import * as routingApi from '../api/routing';

/**
 * Route logs slice — shared AI Enhance log list for the panel and map layer.
 */
const routeLogsSlice = (set, get) => ({
  routeLogs: [],
  routeLogsLoading: false,
  routeLogsRouteId: null,
  routeLogsSummary: null,
  routeLogsApproving: {},

  /** Loads RouteLog__c rows for a Google Route. */
  fetchRouteLogs: async (googleRouteId) => {
    if (!googleRouteId) {
      set({ routeLogs: [], routeLogsLoading: false, routeLogsRouteId: null });
      return;
    }
    set({ routeLogsLoading: true, routeLogsRouteId: googleRouteId });
    try {
      const data = await routingApi.getRouteLogs(googleRouteId);
      if (get().routeLogsRouteId !== googleRouteId) return;
      set({ routeLogs: Array.isArray(data) ? data : [], routeLogsLoading: false });
    } catch {
      if (get().routeLogsRouteId !== googleRouteId) return;
      set({ routeLogs: [], routeLogsLoading: false });
    }
  },

  setRouteLogsSummary: (summary) => set({ routeLogsSummary: summary || null }),
  clearRouteLogsSummary: () => set({ routeLogsSummary: null }),

  /** Applies a batch of { logId, outcome } resolutions and patches local state. */
  resolveRouteLogs: async (items) => {
    if (!items?.length) return null;
    const ids = items.map((i) => i.logId);
    set((s) => {
      const next = { ...s.routeLogsApproving };
      ids.forEach((id) => { next[id] = true; });
      return { routeLogsApproving: next };
    });
    try {
      const res = await routingApi.approveRouteLogs({ resolutions: items });
      const now = new Date().toISOString();
      const byId = Object.fromEntries(items.map((i) => [i.logId, i.outcome]));
      const driverName = get().driver?.name || 'You';
      set((s) => ({
        routeLogs: s.routeLogs.map((l) => {
          const outcome = byId[l.Id];
          if (!outcome) return l;
          const st = outcome === 'add' || outcome === 'keep' ? 'Accepted' : 'Declined';
          return { ...l, Status__c: st, Accepted_By__c: driverName, Accepted_Date__c: now, _outcome: outcome };
        }),
      }));
      if (res?.added?.length || res?.removed?.length) get().refreshRoutes?.();
      return res;
    } finally {
      set((s) => {
        const next = { ...s.routeLogsApproving };
        ids.forEach((id) => { next[id] = false; });
        return { routeLogsApproving: next };
      });
    }
  },

  /** Convenience wrapper for a single log resolution. */
  resolveRouteLog: async ({ logId, outcome }) => get().resolveRouteLogs([{ logId, outcome }]),
});

export default routeLogsSlice;
