const EventEmitter = require('events');

/**
 * In-process pub/sub for live notifications (SSE).
 * Singleton EventEmitter — swap for Redis pub/sub when scaling horizontally.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

const EVENT_TICKET_TRIAGED = 'ticket-triaged';

/** Publishes a notification payload to all SSE subscribers. */
function publish(event, payload) {
  bus.emit('notification', { event, payload, ts: Date.now() });
}

/** Subscribes a listener; returns an unsubscribe function. */
function subscribe(listener) {
  bus.on('notification', listener);
  return () => bus.off('notification', listener);
}

module.exports = { publish, subscribe, EVENT_TICKET_TRIAGED };
