/**
 * In-memory job store for "Generate by Service Location" runs.
 *
 * Generation runs server-side and asynchronously, so the client can hide the
 * progress panel and keep using the app while the job continues. Jobs are kept
 * for a TTL window so the panel can be re-opened and rehydrated via GET /jobs/:id.
 *
 * NOTE: single-instance store (pm2). Swap for Redis to scale horizontally.
 */

const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

const TTL_MS = 60 * 60 * 1000; // keep finished jobs for 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

/** Creates a new running job and returns it. */
function create(params, owner = null) {
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    owner,
    status: 'running', // running | complete | error
    params,
    progress: { step: 'queued', label: 'Queued', counters: {}, percent: 0 },
    result: null,
    error: null,
    committed: null, // set after a successful commit
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

/** Merges the latest progress snapshot onto a running job. */
function updateProgress(id, progress) {
  const job = jobs.get(id);
  if (!job) return;
  job.progress = { ...job.progress, ...progress };
  job.updatedAt = Date.now();
}

function complete(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'complete';
  job.result = result;
  job.progress = { ...job.progress, step: 'complete', percent: 100 };
  job.updatedAt = Date.now();
}

function fail(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.error = error?.message || String(error);
  job.progress = { ...job.progress, step: 'error' };
  job.updatedAt = Date.now();
}

/** Records commit outcome on the job and marks the named preview routes committed. */
function markCommitted(id, committed) {
  const job = jobs.get(id);
  if (!job) return;
  job.committed = committed;
  job.updatedAt = Date.now();
}

/** Public-facing view (omits internal owner field). */
function toView(job) {
  if (!job) return null;
  const { owner, ...view } = job;
  return view;
}

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.updatedAt < cutoff) {
      jobs.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) logger.info('[generationJobs] cleaned up expired jobs', { removed });
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { create, get, updateProgress, complete, fail, markCommitted, toView };
