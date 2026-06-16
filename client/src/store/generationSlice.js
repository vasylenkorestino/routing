import * as routingApi from '../api/routing';
import { combineRoutes, splitRoute, recomputeSummary } from '../utils/routeRecompute';

const IDLE_PROGRESS = { step: 'idle', label: '', counters: {}, percent: 0 };
const MAX_HISTORY = 25;

/**
 * Generation slice — "Generate by Service Location" job lifecycle.
 * The job runs server-side, so the progress panel can be hidden/reopened while
 * generation continues. Live progress arrives over SSE (generation-progress);
 * full results are fetched via GET /jobs/:id once complete.
 */
const generationSlice = (set, get) => ({
  genJobId: null,
  genStatus: 'idle', // idle | running | complete | error
  genProgress: IDLE_PROGRESS,
  genResult: null, // { routes, summary, warnings }
  genError: null,
  genParams: null,
  genPanelOpen: false,
  genReviewOpen: false,
  genCommitting: false,
  genCommitResult: null,
  genHistory: [],

  /** Starts a new generation job and opens the progress panel. */
  startLocationGeneration: async (params) => {
    set({
      genStatus: 'running',
      genProgress: { step: 'queued', label: 'Queued', counters: {}, percent: 0 },
      genResult: null,
      genError: null,
      genParams: params,
      genPanelOpen: true,
      genReviewOpen: false,
      genCommitting: false,
    });
    try {
      const { jobId } = await routingApi.generateRoutesByLocation(params);
      set((s) => ({
        genJobId: jobId,
        genHistory: [
          { jobId, startedAt: new Date().toISOString(), date: params.date, recordType: params.recordType || 'All', status: 'running', routeCount: null },
          ...s.genHistory,
        ].slice(0, MAX_HISTORY),
      }));
      return jobId;
    } catch (err) {
      set({ genStatus: 'error', genError: err?.response?.data?.error || err.message });
      throw err;
    }
  },

  /** Handles an SSE generation-progress event for the active job. */
  onGenerationProgress: (payload) => {
    if (!payload || payload.jobId !== get().genJobId) return;

    if (payload.status === 'error') {
      set({ genStatus: 'error', genError: payload.error || 'Generation failed' });
      get()._patchHistory(payload.jobId, { status: 'error' });
      return;
    }

    if (payload.status === 'complete') {
      set((s) => ({
        genProgress: { ...s.genProgress, step: 'complete', percent: 100, counters: payload.counters || s.genProgress.counters },
      }));
      // Full route list isn't in the SSE payload — fetch it, then open review.
      get().refreshGenJob({ openReviewOnComplete: true });
      return;
    }

    set({
      genStatus: 'running',
      genProgress: {
        step: payload.step ?? get().genProgress.step,
        label: payload.label ?? get().genProgress.label,
        counters: payload.counters ?? get().genProgress.counters,
        percent: payload.percent ?? get().genProgress.percent,
      },
    });
  },

  /** Fetches the current job snapshot from the server (panel reopen / SSE fallback). */
  refreshGenJob: async ({ openReviewOnComplete = false } = {}) => {
    const id = get().genJobId;
    if (!id) return;
    try {
      const job = await routingApi.getGenerationJob(id);
      const patch = {
        genStatus: job.status,
        genProgress: job.progress || get().genProgress,
      };
      if (job.status === 'complete') {
        patch.genResult = job.result || null;
        if (openReviewOnComplete) patch.genReviewOpen = true;
        get()._patchHistory(id, { status: 'complete', routeCount: job.result?.routes?.length ?? 0 });
      } else if (job.status === 'error') {
        patch.genError = job.error || 'Generation failed';
        get()._patchHistory(id, { status: 'error' });
      }
      set(patch);
    } catch (err) {
      console.warn('[generationSlice] refreshGenJob failed', err.message);
    }
  },

  /** Commits selected (or all) preview routes to Salesforce, honoring local edits. */
  commitGeneratedRoutes: async (routeIds) => {
    const id = get().genJobId;
    if (!id) return null;
    const all = get().genResult?.routes || [];
    const ids = routeIds && routeIds.length ? new Set(routeIds) : null;
    const selected = ids ? all.filter((r) => ids.has(r.id)) : all;
    const routes = selected.map((r) => ({
      id: r.id,
      routeName: r.routeName,
      recordType: r.recordType,
      serviceLocationId: r.serviceLocationId,
      accountIds: r.accountIds,
    }));
    set({ genCommitting: true });
    try {
      const result = await routingApi.commitGeneratedRoutes(id, { routes });
      set({ genCommitting: false, genCommitResult: result });
      return result;
    } catch (err) {
      set({ genCommitting: false });
      throw err;
    }
  },

  /** Replaces the preview route list and recomputes summary totals. */
  setGeneratedRoutes: (routes) => set((s) => ({
    genResult: s.genResult ? { ...s.genResult, routes, summary: recomputeSummary(s.genResult.summary, routes) } : s.genResult,
  })),

  /** Merges the given route ids into a single route (in-memory preview only). */
  combineGeneratedRoutes: (routeIds) => {
    const state = get();
    const routes = state.genResult?.routes || [];
    const caps = state.genResult?.summary?.caps || {};
    const ids = new Set(routeIds);
    const toMerge = routes.filter((r) => ids.has(r.id));
    if (toMerge.length < 2) return null;
    const merged = combineRoutes(toMerge, caps);
    const next = [merged, ...routes.filter((r) => !ids.has(r.id))];
    state.setGeneratedRoutes(next);
    return merged.id;
  },

  /** Splits a single route into two halves (in-memory preview only). */
  splitGeneratedRoute: (routeId) => {
    const state = get();
    const routes = state.genResult?.routes || [];
    const caps = state.genResult?.summary?.caps || {};
    const target = routes.find((r) => r.id === routeId);
    if (!target || target.stops.length < 2) return null;
    const [a, b] = splitRoute(target, caps);
    const next = routes.flatMap((r) => (r.id === routeId ? [a, b] : [r]));
    state.setGeneratedRoutes(next);
    return a.id;
  },

  /** Re-runs generation with the last-used parameters. */
  regenerateRoutes: async () => {
    const params = get().genParams;
    if (!params) return null;
    return get().startLocationGeneration(params);
  },

  showGenPanel: () => set({ genPanelOpen: true }),
  hideGenPanel: () => set({ genPanelOpen: false }),
  toggleGenPanel: () => set((s) => ({ genPanelOpen: !s.genPanelOpen })),
  openGenReview: () => set({ genReviewOpen: true }),
  closeGenReview: () => set({ genReviewOpen: false }),

  resetGeneration: () => set({
    genJobId: null,
    genStatus: 'idle',
    genProgress: IDLE_PROGRESS,
    genResult: null,
    genError: null,
    genReviewOpen: false,
    genCommitResult: null,
  }),

  /** Internal: patches a history entry by jobId. */
  _patchHistory: (jobId, patch) => set((s) => ({
    genHistory: s.genHistory.map((h) => (h.jobId === jobId ? { ...h, ...patch } : h)),
  })),
});

export default generationSlice;
