import * as api from '../api/planning';
import {
  reorderStop, moveStop, combineRoutesById, splitRouteById, removeStop, recomputeKeepingOrder,
} from '../utils/planningEdits';

const MAX_HISTORY = 40;
const AUTOSAVE_DELAY_MS = 3500;

// Module-scoped autosave timer (kept out of state so it isn't serialized).
let saveTimer = null;

const IDLE_PROGRESS = { step: 'idle', label: '', percent: 0, counters: {}, routes: [] };

/**
 * Planning slice — AI Route Planning workspace lifecycle.
 * Durable state lives in Salesforce (Route_Plan_Session__c); this slice holds the
 * live working copy, undo/redo history, trace playback and autosave scheduling.
 */
const planningSlice = (set, get) => ({
  planningOpen: false,
  planningSessionId: null,
  planningSession: null,
  planningRoutes: [],
  planningTray: [], // stops removed from routes, draggable back in
  planningSummary: null,
  planningStatus: 'idle', // idle | running | complete | error
  planningProgress: IDLE_PROGRESS,
  planningTrace: [],
  planningJobId: null,
  planningEditVersion: 0,
  planningResumeList: [],
  planningCommitting: false,
  planningSaving: false,
  planningDirty: false,
  planningError: null,
  planningSelectedDay: null,
  planningPlayback: { index: 0, playing: false },
  _undo: [],
  _redo: [],

  /** Caps used for client-side metric recompute. */
  _planningCaps: () => get().planningSummary?.caps || get().planningSession?.params || { avgSpeedMph: 30, serviceTimeMin: 15 },

  /* ── Entry / lifecycle ─────────────────────────────────── */

  /** Creates a session, starts the planner and opens the workspace. */
  startPlanning: async (params) => {
    set({ planningStatus: 'running', planningError: null, planningRoutes: [], planningTray: [], _undo: [], _redo: [], planningProgress: { ...IDLE_PROGRESS, step: 'queued', label: 'Queued' } });
    const { session } = await api.createSession(params);
    set({
      planningOpen: true,
      planningSessionId: session.id,
      planningSession: session,
      planningEditVersion: session.editVersion || 0,
      planningSelectedDay: params.dateFrom || null,
    });
    await get()._startPlanRun(params);
    return session.id;
  },

  /** Loads the list of resumable sessions. */
  loadPlanningSessions: async () => {
    try {
      const { sessions } = await api.listSessions();
      set({ planningResumeList: sessions || [] });
      return sessions;
    } catch (err) {
      console.warn('[planningSlice] loadPlanningSessions failed', err.message);
      return [];
    }
  },

  /** Reopens an existing session and shows the workspace exactly where it was left. */
  resumePlanning: async (sessionId) => {
    set({ planningStatus: 'running', planningError: null, planningProgress: { ...IDLE_PROGRESS, step: 'loading', label: 'Loading session' } });
    const { session, routes } = await api.getSession(sessionId);
    set({
      planningOpen: true,
      planningSessionId: session.id,
      planningSession: session,
      planningRoutes: routes || [],
      planningTray: [],
      planningSummary: { caps: session.params || {} },
      planningEditVersion: session.editVersion || 0,
      planningStatus: 'complete',
      planningSelectedDay: session.dateFrom || routes?.[0]?.serviceDate || null,
      _undo: [], _redo: [],
      planningProgress: { ...IDLE_PROGRESS, step: 'complete', percent: 100 },
    });
    return session.id;
  },

  /**
   * Re-runs the planner for the current session with updated guidance settings,
   * re-evaluating every mock route. Committed routes are always preserved; manual
   * edits are preserved when keepEdited (their stops are excluded from re-discovery).
   */
  regeneratePlan: async (newParams = {}, { keepEdited = true } = {}) => {
    const id = get().planningSessionId;
    if (!id) return;
    // Persist current manual edits first so the server can preserve them.
    await get().flushPlanningSave().catch(() => {});
    const params = { ...(get().planningSession?.params || {}), ...newParams };
    set((s) => ({
      planningStatus: 'running',
      planningError: null,
      planningRoutes: [],
      planningTray: [],
      _undo: [], _redo: [],
      planningSession: s.planningSession ? { ...s.planningSession, params } : s.planningSession,
      planningSummary: { ...(s.planningSummary || {}), caps: { ...(s.planningSummary?.caps || {}), ...newParams } },
      planningProgress: { ...IDLE_PROGRESS, step: 'queued', label: keepEdited ? 'Re-planning (keeping manual routes)' : 'Re-planning from scratch' },
    }));
    await get()._startPlanRun({ ...params, keepEdited });
  },

  /** Starts (or restarts) the planner run for the current session. */
  _startPlanRun: async (overrideParams) => {
    const id = get().planningSessionId;
    if (!id) return;
    set({ planningStatus: 'running', planningError: null });
    try {
      const { jobId } = await api.startPlan(id, overrideParams || {});
      set({ planningJobId: jobId });
    } catch (err) {
      set({ planningStatus: 'error', planningError: err?.response?.data?.error || err.message });
      throw err;
    }
  },

  /** SSE handler for planning-progress events (live "watch the AI think"). */
  onPlanningProgress: (payload) => {
    if (!payload || payload.jobId !== get().planningJobId) return;
    if (payload.status === 'error') {
      set({ planningStatus: 'error', planningError: payload.error || 'Planning failed' });
      return;
    }
    if (payload.status === 'complete') {
      set((s) => ({ planningProgress: { ...s.planningProgress, step: 'complete', percent: 100 }, planningSummary: payload.summary ? { ...s.planningSummary, ...payload.summary } : s.planningSummary }));
      get()._loadRunResult();
      return;
    }
    set({
      planningStatus: 'running',
      planningProgress: {
        step: payload.step ?? get().planningProgress.step,
        label: payload.label ?? get().planningProgress.label,
        percent: payload.percent ?? get().planningProgress.percent,
        counters: payload.counters ?? get().planningProgress.counters,
        routes: payload.routes ?? get().planningProgress.routes,
      },
    });
  },

  /** After a run completes, load persisted routes + trace from the server. */
  _loadRunResult: async () => {
    const sessionId = get().planningSessionId;
    const jobId = get().planningJobId;
    try {
      const [{ session, routes }, job] = await Promise.all([
        api.getSession(sessionId),
        jobId ? api.getPlanJob(jobId).catch(() => null) : Promise.resolve(null),
      ]);
      set({
        planningSession: session,
        planningRoutes: routes || [],
        planningEditVersion: session.editVersion || 0,
        planningSummary: job?.result?.summary ? { ...job.result.summary } : { caps: session.params || {} },
        planningTrace: job?.result?.trace || job?.trace || [],
        planningStatus: 'complete',
        planningPlayback: { index: 0, playing: false },
      });
    } catch (err) {
      set({ planningStatus: 'error', planningError: err.message });
    }
  },

  /** Poll fallback if SSE is unavailable. */
  refreshPlanJob: async () => {
    const jobId = get().planningJobId;
    if (!jobId) return;
    try {
      const job = await api.getPlanJob(jobId);
      if (job.status === 'complete') get()._loadRunResult();
      else if (job.status === 'error') set({ planningStatus: 'error', planningError: job.error });
      else set({ planningStatus: 'running', planningProgress: job.progress || get().planningProgress });
    } catch { /* ignore */ }
  },

  /* ── Editing (undo/redo + autosave) ─────────────────────── */

  /** Applies a new route list, pushing the previous onto the undo stack. */
  _applyRoutes: (routes, { pushHistory = true, tray } = {}) => {
    set((s) => ({
      _undo: pushHistory ? [...s._undo, { routes: s.planningRoutes, tray: s.planningTray }].slice(-MAX_HISTORY) : s._undo,
      _redo: pushHistory ? [] : s._redo,
      planningRoutes: routes,
      planningTray: tray !== undefined ? tray : s.planningTray,
      planningDirty: true,
    }));
    get()._scheduleAutosave();
  },

  reorderRouteStop: (routeId, fromIndex, toIndex) => {
    get()._applyRoutes(reorderStop(get().planningRoutes, routeId, fromIndex, toIndex, get()._planningCaps()));
  },

  moveStopBetweenRoutes: (fromRouteId, toRouteId, accountId, toIndex) => {
    get()._applyRoutes(moveStop(get().planningRoutes, fromRouteId, toRouteId, accountId, toIndex, get()._planningCaps()));
  },

  combineRoutes: (ids) => {
    const { routes, mergedId } = combineRoutesById(get().planningRoutes, ids, get()._planningCaps());
    if (mergedId) get()._applyRoutes(routes);
    return mergedId;
  },

  splitRoute: (routeId) => {
    const { routes, firstId } = splitRouteById(get().planningRoutes, routeId, get()._planningCaps());
    if (firstId) get()._applyRoutes(routes);
    return firstId;
  },

  removeStopToTray: (routeId, accountId) => {
    const { routes, stop } = removeStop(get().planningRoutes, routeId, accountId, get()._planningCaps());
    if (!stop) return;
    get()._applyRoutes(routes, { tray: [...get().planningTray, stop] });
  },

  addStopFromTray: (accountId, toRouteId, toIndex = 0) => {
    const stop = get().planningTray.find((s) => s.accountId === accountId);
    if (!stop) return;
    const caps = get()._planningCaps();
    const routes = get().planningRoutes.map((r) => {
      if (r.id !== toRouteId) return r;
      const stops = r.stops.slice();
      stops.splice(Math.min(toIndex, stops.length), 0, stop);
      return recomputeKeepingOrder({ ...r, stops }, caps);
    });
    get()._applyRoutes(routes, { tray: get().planningTray.filter((s) => s.accountId !== accountId) });
  },

  /** Regenerates a single route (server), optionally pulling in extra tray accounts. */
  regenerateSingleRoute: async (routeId, extraAccountIds = []) => {
    const route = get().planningRoutes.find((r) => r.id === routeId);
    if (!route) return;
    const accountIds = [...new Set([...(route.accountIds || []), ...extraAccountIds])];
    const { route: rebuilt } = await api.regenerateRoute(get().planningSessionId, {
      routeId,
      serviceDate: route.serviceDate,
      recordType: route.recordType,
      depot: route.depot,
      accountIds,
      ...(get().planningSummary?.caps || {}),
    });
    if (!rebuilt) return;
    rebuilt.id = routeId; // keep the same slot
    rebuilt.sfId = route.sfId;
    rebuilt.adminNotes = route.adminNotes;
    get()._applyRoutes(get().planningRoutes.map((r) => (r.id === routeId ? rebuilt : r)),
      { tray: get().planningTray.filter((s) => !extraAccountIds.includes(s.accountId)) });
  },

  setRouteAdminNotes: (routeId, notes) => {
    get()._applyRoutes(get().planningRoutes.map((r) => (r.id === routeId ? { ...r, adminNotes: notes } : r)));
  },

  toggleRouteKeepOrder: (routeId) => {
    get()._applyRoutes(get().planningRoutes.map((r) => (r.id === routeId ? { ...r, keepOrder: !r.keepOrder } : r)));
  },

  setSessionAdminNotes: (notes) => {
    set((s) => ({ planningSession: { ...s.planningSession, adminNotes: notes }, planningDirty: true }));
    get()._scheduleAutosave();
  },

  undo: () => {
    const undoStack = get()._undo;
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    set((s) => ({
      _undo: s._undo.slice(0, -1),
      _redo: [...s._redo, { routes: s.planningRoutes, tray: s.planningTray }].slice(-MAX_HISTORY),
      planningRoutes: prev.routes,
      planningTray: prev.tray,
      planningDirty: true,
    }));
    get()._scheduleAutosave();
  },

  redo: () => {
    const redoStack = get()._redo;
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    set((s) => ({
      _redo: s._redo.slice(0, -1),
      _undo: [...s._undo, { routes: s.planningRoutes, tray: s.planningTray }].slice(-MAX_HISTORY),
      planningRoutes: next.routes,
      planningTray: next.tray,
      planningDirty: true,
    }));
    get()._scheduleAutosave();
  },

  /* ── Autosave ───────────────────────────────────────────── */

  _scheduleAutosave: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { get().flushPlanningSave(); }, AUTOSAVE_DELAY_MS);
  },

  flushPlanningSave: async () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const state = get();
    if (!state.planningSessionId || !state.planningDirty) return;
    set({ planningSaving: true });
    try {
      const res = await api.saveSession(state.planningSessionId, {
        routes: state.planningRoutes,
        adminNotes: state.planningSession?.adminNotes ?? '',
        editVersion: state.planningEditVersion,
      });
      // Backend replaced working rows; adopt returned sfIds so future saves diff cleanly.
      const saved = res.saved || [];
      const working = state.planningRoutes.filter((r) => !r.committed);
      const withIds = state.planningRoutes.map((r) => {
        if (r.committed) return r;
        const idx = working.indexOf(r);
        const match = saved.find((s) => s.index === idx);
        return match?.sfId ? { ...r, sfId: match.sfId } : r;
      });
      set({ planningEditVersion: res.editVersion, planningDirty: false, planningSaving: false, planningRoutes: withIds });
    } catch (err) {
      set({ planningSaving: false });
      if (err?.response?.status === 409) {
        set({ planningError: 'This session was changed elsewhere. Reloading…' });
        await get().resumePlanning(state.planningSessionId);
      } else {
        console.warn('[planningSlice] autosave failed', err.message);
      }
    }
  },

  /* ── Trace playback ─────────────────────────────────────── */

  setPlaybackIndex: (index) => set((s) => ({ planningPlayback: { ...s.planningPlayback, index, playing: false } })),
  togglePlayback: () => set((s) => ({ planningPlayback: { ...s.planningPlayback, playing: !s.planningPlayback.playing } })),
  stepPlayback: () => set((s) => {
    const max = Math.max(0, (s.planningTrace?.length || 1) - 1);
    const next = s.planningPlayback.index + 1;
    if (next > max) return { planningPlayback: { index: max, playing: false } };
    return { planningPlayback: { ...s.planningPlayback, index: next } };
  }),

  /* ── Commit ─────────────────────────────────────────────── */

  commitPlanning: async (routeIds) => {
    const id = get().planningSessionId;
    if (!id) return null;
    await get().flushPlanningSave();
    set({ planningCommitting: true });
    try {
      const result = await api.commitSession(id, routeIds && routeIds.length ? { routeIds } : {});
      // Reload session to reflect committed flags / status.
      const { session, routes } = await api.getSession(id);
      set({ planningCommitting: false, planningSession: session, planningRoutes: routes || [], planningEditVersion: session.editVersion || 0 });
      const refresh = get().refreshAfterAiCreate;
      if (result?.googleRoutes?.length && typeof refresh === 'function') {
        await refresh(result.googleRoutes);
      }
      return result;
    } catch (err) {
      set({ planningCommitting: false });
      throw err;
    }
  },

  /* ── Close / archive ────────────────────────────────────── */

  setPlanningSelectedDay: (day) => set({ planningSelectedDay: day }),

  closePlanning: async () => {
    await get().flushPlanningSave().catch(() => {});
    set({ planningOpen: false });
  },

  archiveCurrentPlanning: async () => {
    const id = get().planningSessionId;
    if (!id) return;
    try { await api.archiveSession(id); } catch { /* ignore */ }
    set({ planningOpen: false, planningSessionId: null, planningSession: null, planningRoutes: [], planningTray: [], planningStatus: 'idle' });
  },

  resetPlanning: () => set({
    planningOpen: false, planningSessionId: null, planningSession: null, planningRoutes: [],
    planningTray: [], planningSummary: null, planningStatus: 'idle', planningProgress: IDLE_PROGRESS,
    planningTrace: [], planningJobId: null, planningEditVersion: 0, _undo: [], _redo: [],
  }),
});

export default planningSlice;
