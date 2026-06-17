const { randomUUID } = require('crypto');
const { redactFreeText } = require('../../utils/aiDataPolicy');
const config = require('../../config/anthropic');

const TTL_MS = config.memory?.sessionTtlMs || 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 20;

/** @type {Map<string, { messages: object[], updatedAt: number }>} */
const sessions = new Map();

/** Creates a new session id. */
function createId() {
  return randomUUID();
}

/** Returns recent messages for Claude (role/content only). */
function getMessages(sessionId) {
  if (!sessionId) return [];
  const s = sessions.get(sessionId);
  if (!s) return [];
  if (Date.now() - s.updatedAt > TTL_MS) {
    sessions.delete(sessionId);
    return [];
  }
  return s.messages.map(({ role, content }) => ({ role, content }));
}

/** Appends a redacted message to the session. */
function append(sessionId, { role, content }) {
  if (!sessionId || !content) return;
  let s = sessions.get(sessionId);
  if (!s) {
    s = { messages: [], updatedAt: Date.now() };
    sessions.set(sessionId, s);
  }
  s.messages.push({ role, content: redactFreeText(String(content)) });
  if (s.messages.length > MAX_MESSAGES) s.messages = s.messages.slice(-MAX_MESSAGES);
  s.updatedAt = Date.now();
}

module.exports = { createId, getMessages, append };
