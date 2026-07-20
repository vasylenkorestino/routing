import * as routingApi from '../api/routing';

/** Default map layers: only Remove + Add (Keep / Flag / Overflow off). */
const DEFAULT_FLAG_VISIBLE = {
  ADD: true,
  KEEP: false,
  REMOVE: true,
  FLAG: false,
  OVERFLOW: false,
};

/**
 * Route logs slice — shared AI Enhance log list for the panel and map layer.
 */
const routeLogsSlice = (set, get) => ({
  routeLogs: [],
  routeLogsLoading: false,
  routeLogsRouteId: null,
  routeLogsSummary: null,
  routeLogsApproving: {},
  /** Multi-select for Approve/Decline All — shared by list + map checkboxes. */
  routeLogSelectedIds: {},
  /** Log currently opened/focused in the AI Logs panel (map highlight). */
  routeLogFocusedId: null,
  /** Per-flag map marker visibility toggles. */
  routeLogFlagVisible: { ...DEFAULT_FLAG_VISIBLE },

  /** Loads RouteLog__c rows for a Google Route. */
  fetchRouteLogs: async (googleRouteId) => {
    if (!googleRouteId) {
      set({
        routeLogs: [],
        routeLogsLoading: false,
        routeLogsRouteId: null,
        routeLogSelectedIds: {},
        routeLogFocusedId: null,
      });
      return;
    }
    const prevRoute = get().routeLogsRouteId;
    set({
      routeLogsLoading: true,
      routeLogsRouteId: googleRouteId,
      ...(prevRoute !== googleRouteId
        ? { routeLogSelectedIds: {}, routeLogFocusedId: null }
        : {}),
    });
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

  toggleRouteLogSelected: (id) => {
    if (!id) return;
    set((s) => {
      const next = { ...s.routeLogSelectedIds };
      if (next[id]) delete next[id];
      else next[id] = true;
      return { routeLogSelectedIds: next };
    });
  },

  /** Replaces selection with the given id list (or clears when empty). */
  setRouteLogSelectedIds: (ids = []) => {
    const next = {};
    (ids || []).forEach((id) => { if (id) next[id] = true; });
    set({ routeLogSelectedIds: next });
  },

  clearRouteLogSelection: () => set({ routeLogSelectedIds: {} }),

  setRouteLogFocusedId: (id) => set({ routeLogFocusedId: id || null }),

  toggleRouteLogFlagVisible: (flag) => {
    if (!flag) return;
    set((s) => ({
      routeLogFlagVisible: {
        ...s.routeLogFlagVisible,
        [flag]: !s.routeLogFlagVisible[flag],
      },
    }));
  },

  setRouteLogFlagVisible: (flag, visible) => {
    if (!flag) return;
    set((s) => ({
      routeLogFlagVisible: {
        ...s.routeLogFlagVisible,
        [flag]: !!visible,
      },
    }));
  },

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
      set((s) => {
        const selected = { ...s.routeLogSelectedIds };
        ids.forEach((id) => { delete selected[id]; });
        return {
          routeLogs: s.routeLogs.map((l) => {
            const outcome = byId[l.Id];
            if (!outcome) return l;
            const st = outcome === 'add' || outcome === 'keep' ? 'Accepted' : 'Declined';
            return { ...l, Status__c: st, Accepted_By__c: driverName, Accepted_Date__c: now, _outcome: outcome };
          }),
          routeLogSelectedIds: selected,
          routeLogFocusedId: ids.includes(s.routeLogFocusedId) ? null : s.routeLogFocusedId,
        };
      });
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

  /**
   * Undoes accept/decline for the given log ids — restores Proposed and reverses
   * add/remove stop changes on the server.
   */
  undoRouteLogs: async (logIds) => {
    const ids = (logIds || []).filter(Boolean);
    if (!ids.length) return null;
    set((s) => {
      const next = { ...s.routeLogsApproving };
      ids.forEach((id) => { next[id] = true; });
      return { routeLogsApproving: next };
    });
    try {
      const outcomes = {};
      get().routeLogs.forEach((l) => {
        if (ids.includes(l.Id) && l._outcome) outcomes[l.Id] = l._outcome;
      });
      const res = await routingApi.undoRouteLogs({ logIds: ids, outcomes });
      set((s) => ({
        routeLogs: s.routeLogs.map((l) => {
          if (!ids.includes(l.Id)) return l;
          const { _outcome, ...rest } = l;
          return {
            ...rest,
            Status__c: 'Proposed',
            Accepted_By__c: null,
            Accepted_Date__c: null,
          };
        }),
      }));
      if (res?.undidAdd?.length || res?.undidRemove?.length) get().refreshRoutes?.();
      return res;
    } finally {
      set((s) => {
        const next = { ...s.routeLogsApproving };
        ids.forEach((id) => { next[id] = false; });
        return { routeLogsApproving: next };
      });
    }
  },

  undoRouteLog: async (logId) => get().undoRouteLogs([logId]),
});

export default routeLogsSlice;
