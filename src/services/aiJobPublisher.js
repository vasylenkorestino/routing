const aiJobs = require('./aiJobs');
const { publish, EVENT_AI_PROGRESS } = require('./notificationBus');

/** Publishes an ai-progress SSE event scoped to the job owner. */
function publishJobProgress(jobId, payload = {}) {
  const job = aiJobs.get(jobId);
  if (!job) return;
  publish(EVENT_AI_PROGRESS, {
    jobId: job.id,
    owner: job.owner,
    type: job.type,
    status: job.status,
    steps: job.steps,
    findings: job.findings,
    partialResults: job.partialResults,
    message: job.message,
    progress: job.progress,
    ...payload,
  });
}

/** Convenience: update job fields then publish. */
function progress(jobId, updates = {}) {
  const job = aiJobs.get(jobId);
  if (!job) return;
  if (updates.progress) aiJobs.updateProgress(jobId, updates.progress);
  if (updates.step) aiJobs.upsertStep(jobId, updates.step);
  if (updates.finding) aiJobs.addFinding(jobId, updates.finding);
  if (updates.partialResults) aiJobs.mergePartialResults(jobId, updates.partialResults);
  if (updates.message != null) aiJobs.setMessage(jobId, updates.message);
  publishJobProgress(jobId, {
    status: updates.status || job.status,
    ...updates.eventExtra,
  });
}

module.exports = { publishJobProgress, progress };
