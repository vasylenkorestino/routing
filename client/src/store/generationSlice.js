import * as routingApi from '../api/routing';

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

  /** Commits selected (or all) preview routes to Salesforce. */
  commitGeneratedRoutes: async (routeIds) => {
    const id = get().genJobId;
    if (!id) return null;
    set({ genCommitting: true });
    try {
      const body = routeIds && routeIds.length ? { routeIds } : {};
      const result = await routingApi.commitGeneratedRoutes(id, body);
      set({ genCommitting: false, genCommitResult: result });
      return result;
    } catch (err) {
      set({ genCommitting: false });
      throw err;
    }
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
