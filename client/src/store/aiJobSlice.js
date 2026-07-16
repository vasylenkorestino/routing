import * as routingApi from '../api/routing';

/**
 * AI job slice — async chat/enhance job lifecycle with SSE progress.
 */
const aiJobSlice = (set, get) => ({
  aiJobId: null,
  aiJobType: null,
  aiJobMeta: null,
  aiJobStatus: 'idle',
  aiJobSteps: [],
  aiJobFindings: [],
  aiJobPartialResults: {},
  aiJobMessage: '',
  aiJobProgress: { step: 'idle', label: '', percent: 0 },
  aiJobResult: null,
  aiJobError: null,

  /** Starts tracking a job and fetches an immediate snapshot. */
  trackAIJob: async (jobId, type, meta = null) => {
    set({
      aiJobId: jobId,
      aiJobType: type,
      aiJobMeta: meta || null,
      aiJobStatus: 'running',
      aiJobSteps: [],
      aiJobFindings: [],
      aiJobPartialResults: {},
      aiJobMessage: '',
      aiJobProgress: { step: 'queued', label: 'Starting…', percent: 0 },
      aiJobResult: null,
      aiJobError: null,
    });
    await get().refreshAIJob();
    return jobId;
  },

  /** Fetches full job snapshot from server (handles missed SSE / sub-second jobs). */
  refreshAIJob: async () => {
    const id = get().aiJobId;
    if (!id) return;
    try {
      const job = await routingApi.getAIJob(id);
      set({
        aiJobStatus: job.status,
        aiJobSteps: job.steps || [],
        aiJobFindings: job.findings || [],
        aiJobPartialResults: job.partialResults || {},
        aiJobMessage: job.message || '',
        aiJobProgress: job.progress || get().aiJobProgress,
        aiJobResult: job.result || null,
        aiJobError: job.error || null,
      });
    } catch (err) {
      console.warn('[aiJobSlice] refreshAIJob failed', err.message);
    }
  },

  /** Handles SSE ai-progress events for the active job. */
  onAIProgress: (payload) => {
    if (!payload || payload.jobId !== get().aiJobId) return;

    if (payload.status === 'error') {
      set({
        aiJobStatus: 'error',
        aiJobError: payload.error || 'Job failed',
        aiJobSteps: payload.steps || get().aiJobSteps,
        aiJobFindings: payload.findings || get().aiJobFindings,
      });
      return;
    }

    if (payload.status === 'complete') {
      set({
        aiJobStatus: 'complete',
        aiJobSteps: payload.steps || get().aiJobSteps,
        aiJobFindings: payload.findings || get().aiJobFindings,
        aiJobPartialResults: payload.partialResults || get().aiJobPartialResults,
        aiJobMessage: payload.message || get().aiJobMessage,
        aiJobProgress: { ...(payload.progress || get().aiJobProgress), percent: 100, step: 'complete' },
      });
      get().refreshAIJob();
      return;
    }

    set({
      aiJobStatus: 'running',
      aiJobSteps: payload.steps ?? get().aiJobSteps,
      aiJobFindings: payload.findings ?? get().aiJobFindings,
      aiJobPartialResults: payload.partialResults ?? get().aiJobPartialResults,
      aiJobMessage: payload.message ?? get().aiJobMessage,
      aiJobProgress: payload.progress
        ? { ...get().aiJobProgress, ...payload.progress }
        : get().aiJobProgress,
    });
  },

  clearAIJob: () => set({
    aiJobId: null,
    aiJobType: null,
    aiJobMeta: null,
    aiJobStatus: 'idle',
    aiJobSteps: [],
    aiJobFindings: [],
    aiJobPartialResults: {},
    aiJobMessage: '',
    aiJobProgress: { step: 'idle', label: '', percent: 0 },
    aiJobResult: null,
    aiJobError: null,
  }),
});

export default aiJobSlice;
