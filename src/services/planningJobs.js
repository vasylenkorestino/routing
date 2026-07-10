/**
 * In-memory run store for AI Route Planning generation runs.
 *
 * A "job" here is a single planner execution tied to a persistent
 * Route_Plan_Session__c. The durable state (mock routes, edits, admin notes)
 * lives in Salesforce; this store only holds the transient trace/progress of an
 * in-flight or recently finished run so the workspace can poll or re-open it.
 *
 * NOTE: single-instance store. Swap for Redis to scale horizontally. The
 * workspace never DEPENDS on this store — it can always rehydrate from the
 * Salesforce session record.
 */

const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

const TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

function create(sessionId, params, owner = null) {
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    sessionId,
    owner,
    status: 'running', // running | complete | error
    params,
    progress: { step: 'queued', label: 'Queued', percent: 0, counters: {}, routes: [] },
    trace: [],
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

function updateProgress(id, progress) {
  const job = jobs.get(id);
  if (!job) return;
  job.progress = { ...job.progress, ...progress };
  job.trace.push(progress);
  job.updatedAt = Date.now();
}

function complete(id, result) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'complete';
  job.result = result;
  job.trace = result?.trace || job.trace;
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
  if (removed > 0) logger.info('[planningJobs] cleaned up expired jobs', { removed });
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { create, get, updateProgress, complete, fail, toView };
