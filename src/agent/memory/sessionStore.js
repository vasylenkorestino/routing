const { randomUUID } = require('crypto');
const { redactFreeText } = require('../../utils/aiDataPolicy');
const config = require('../../config/anthropic');
const logger = require('../../utils/logger');
const chatSessionAdapter = require('./chatSessionAdapter');

const TTL_MS = config.memory?.sessionTtlMs || 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 20;
const MAX_TRANSCRIPT_CHARS = 130000; // fits AI_Chat_Session__c.Transcript__c (131072)
const KEY_PREFIX = 'chat:session:';

/**
 * Chat session store: Redis-backed when REDIS_URL is set, in-memory Map otherwise.
 * Session shape: { summary, messages, transcript, updatedAt }.
 * Keeps last MAX_MESSAGES verbatim; older turns are folded into `summary`.
 */

/** @type {Map<string, object>} in-memory fallback for dev / Redis outages */
const memorySessions = new Map();

let redis = null;
if (process.env.REDIS_URL) {
  const Redis = require('ioredis');
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 });
  redis.on('error', (err) => logger.warn('[sessionStore] redis error', { error: err.message }));
}

/** Creates a new session id. */
function createId() {
  return randomUUID();
}

/** Returns an empty session object. */
function emptySession() {
  return { summary: '', messages: [], transcript: '', updatedAt: Date.now() };
}

/** Loads a session from Redis (or the in-memory fallback). Returns null when absent/expired. */
async function loadSession(sessionId) {
  if (!sessionId) return null;

  if (redis) {
    try {
      const raw = await redis.get(KEY_PREFIX + sessionId);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      logger.warn('[sessionStore] redis get failed — using in-memory fallback', { error: err.message });
    }
  }

  const s = memorySessions.get(sessionId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) {
    memorySessions.delete(sessionId);
    return null;
  }
  return s;
}

/** Saves a session with TTL to Redis (or the in-memory fallback). */
async function saveSession(sessionId, session) {
  session.updatedAt = Date.now();

  if (redis) {
    try {
      await redis.set(KEY_PREFIX + sessionId, JSON.stringify(session), 'PX', TTL_MS);
      return;
    } catch (err) {
      logger.warn('[sessionStore] redis set failed — using in-memory fallback', { error: err.message });
    }
  }

  memorySessions.set(sessionId, session);
}

/** Returns recent messages for Claude (role/content only). */
async function getMessages(sessionId) {
  const s = await loadSession(sessionId);
  if (!s) return [];
  return s.messages.map(({ role, content }) => ({ role, content }));
}

/** Returns the rolling summary of turns that no longer fit the message window. */
async function getSummary(sessionId) {
  const s = await loadSession(sessionId);
  return s?.summary || '';
}

/** Folds trimmed turns into the session summary via a cheap model call (best effort). */
async function foldIntoSummary(sessionId, trimmedMessages) {
  try {
    // Lazy require to avoid a circular dependency (services/anthropic ↔ memory).
    const { summarizeConversation } = require('../../services/anthropic');
    const updated = await summarizeConversation(
      (await loadSession(sessionId))?.summary || '',
      trimmedMessages,
    );
    if (!updated) return;
    const session = await loadSession(sessionId);
    if (!session) return;
    session.summary = updated;
    await saveSession(sessionId, session);
  } catch (err) {
    // Fallback is plain truncation — the old summary (if any) is kept.
    logger.warn('[sessionStore] summary update failed', { error: err.message });
  }
}

/** Appends a redacted message; trims + summarizes overflow and persists transcripts to Salesforce. */
async function append(sessionId, { role, content }, meta = {}) {
  if (!sessionId || !content) return;

  const session = (await loadSession(sessionId)) || emptySession();
  const redacted = redactFreeText(String(content));

  session.messages.push({ role, content: redacted });
  const line = `[${new Date().toISOString()}] ${role}: ${redacted}`;
  session.transcript = `${session.transcript}${session.transcript ? '\n' : ''}${line}`.slice(-MAX_TRANSCRIPT_CHARS);

  let trimmed = [];
  if (session.messages.length > MAX_MESSAGES) {
    trimmed = session.messages.slice(0, session.messages.length - MAX_MESSAGES);
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }

  await saveSession(sessionId, session);

  // Both run in the background — never blocks or fails the chat response.
  if (trimmed.length) {
    foldIntoSummary(sessionId, trimmed).catch(() => {});
  }
  if (role === 'assistant') {
    chatSessionAdapter.upsertTranscript({
      sessionId,
      transcript: session.transcript,
      summary: session.summary,
      recordType: meta.recordType,
    }).catch(() => {});
  }
}

module.exports = { createId, getMessages, getSummary, append };
