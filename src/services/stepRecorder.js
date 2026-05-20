const logger = require('../utils/logger');

const MAX_FIELD = 30000;

function stringify(val) {
  if (val == null) return '';
  if (typeof val === 'string') return val;
  try { return JSON.stringify(val); } catch { return String(val); }
}

function trunc(val, max = MAX_FIELD) {
  const s = stringify(val);
  return s.length > max ? s.substring(0, max) : s;
}

/**
 * Creates an in-memory step recorder for a single request.
 * Steps are pushed in order; pass `recorder.steps` to logAction when the request completes.
 */
function createRecorder() {
  const steps = [];

  function pushStep(partial) {
    const step = {
      stepNumber: steps.length + 1,
      skill: partial.skill || '',
      type: partial.type || 'Skill',
      status: partial.status || 'Success',
      prompt: partial.prompt != null ? trunc(partial.prompt) : '',
      input: partial.input != null ? trunc(partial.input) : '',
      output: partial.output != null ? trunc(partial.output) : '',
      durationMs: partial.durationMs != null ? Math.round(partial.durationMs) : null,
      error: partial.error ? trunc(partial.error, 32000) : '',
    };
    steps.push(step);
    return step;
  }

  /** Runs an async fn, records duration + output (or error) as a step, then re-throws on failure. */
  async function wrap(skill, type, fn, { prompt, input } = {}) {
    const t0 = Date.now();
    try {
      const output = await fn();
      pushStep({ skill, type, status: 'Success', prompt, input, output, durationMs: Date.now() - t0 });
      return output;
    } catch (err) {
      pushStep({ skill, type, status: 'Error', prompt, input, error: err?.message || String(err), durationMs: Date.now() - t0 });
      throw err;
    }
  }

  /** Manual push for cases where the wrapper is awkward (e.g. partial outputs across branches). */
  function record(partial) {
    try {
      return pushStep(partial);
    } catch (err) {
      logger.error('[stepRecorder] failed to record step', { error: err.message });
      return null;
    }
  }

  return { steps, wrap, record };
}

module.exports = { createRecorder };
