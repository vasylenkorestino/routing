const logger = require('../../utils/logger');

/** @type {Array<object>} */
const queue = [];

/** Queues a feedback event for the reflection job. */
function enqueueFeedback(event) {
  queue.push({ ...event, ts: Date.now() });
  logger.info('[feedbackObserver] queued event', { type: event.type });
}

function drainQueue(max = 100) {
  const batch = queue.splice(0, max);
  return batch;
}

function queueLength() {
  return queue.length;
}

module.exports = { enqueueFeedback, drainQueue, queueLength };
