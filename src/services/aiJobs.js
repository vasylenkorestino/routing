/**
 * In-memory job store for async AI runs (chat, enhance).
 * Single-instance (pm2); swap for Redis to scale horizontally.
 */

const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

const TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

/** Resolves a stable owner key from an authenticated request. */
function resolveOwner(req) {
  return req.driver?.email || req.driver?.name || req.driver?.id || 'api';
}

/** Creates a new running AI job. */
function create({ type, params, owner }) {
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    type,
    owner: owner || 'api',
    status: 'running',
    params,
    steps: [],
    findings: [],
    partialResults: {},
    message: '',
    progress: { step: 'queued', label: 'Starting…', percent: 0 },
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

/** Returns job if id exists and owner matches (or request is same owner). */
function getForOwner(id, owner) {
  const job = jobs.get(id);
  if (!job) return null;
  if (owner && job.owner !== owner && job.owner !== 'api' && owner !== 'api') return null;
  return job;
}

/** Returns the first running job for an owner and optional type. */
function findActiveForOwner(owner, type) {
  if (!owner) return null;
  for (const job of jobs.values()) {
    if (job.status !== 'running' || job.owner !== owner) continue;
    if (type && job.type !== type) continue;
    return job;
  }
  return null;
}

/** Upserts a step in the job's step history. */
function upsertStep(id, step) {
  const job = jobs.get(id);
  if (!job) return;
  const idx = job.steps.findIndex((s) => s.id === step.id);
  const entry = { ...step, updatedAt: Date.now() };
  if (idx >= 0) job.steps[idx] = { ...job.steps[idx], ...entry };
  else job.steps.push(entry);
  job.updatedAt = Date.now();
}

/** Appends a human-readable finding string. */
function addFinding(id, text) {
  const job = jobs.get(id);
  if (!job || !text) return;
  job.findings.push(text);
  job.updatedAt = Date.now();
}

/** Merges partial structured results. */
function mergePartialResults(id, partial) {
  const job = jobs.get(id);
  if (!job) return;
  job.partialResults = { ...job.partialResults, ...partial };
  job.updatedAt = Date.now();
}

function setMessage(id, message) {
  const job = jobs.get(id);
  if (!job) return;
  job.message = message;
  job.updatedAt = Date.now();
}

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
  job.progress = { ...job.progress, step: 'complete', label: 'Complete', percent: 100 };
  job.updatedAt = Date.now();
}

function fail(id, error) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'error';
  job.error = error?.message || String(error);
  job.progress = { ...job.progress, step: 'error', label: 'Error' };
  job.updatedAt = Date.now();
}

/** Public snapshot for GET /ai-jobs/:id (includes full history). */
function toView(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    steps: job.steps,
    findings: job.findings,
    partialResults: job.partialResults,
    message: job.message,
    progress: job.progress,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
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
  if (removed > 0) logger.info('[aiJobs] cleaned up expired jobs', { removed });
}, CLEANUP_INTERVAL_MS);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = {
  create,
  get,
  getForOwner,
  findActiveForOwner,
  upsertStep,
  addFinding,
  mergePartialResults,
  setMessage,
  updateProgress,
  complete,
  fail,
  toView,
  resolveOwner,
};
