/**
 * Manager feedback loader for AI Enhance.
 *
 * Managers already tell us when the engine is wrong — by typing on the
 * recommendation ("they are due this week might as well go") or by declining a
 * REMOVE. Both signals were previously write-only: the pipeline never read them
 * back, so the same account got recommended for removal run after run.
 *
 *   comments   : RouteLogComment__c bodies, any route, recent window
 *   keepSignal : a declined [REMOVE] recommendation — the manager already
 *                overruled us on this account, so treat it as protected
 */

const logger = require('../utils/logger');

const DEFAULT_LOOKBACK_DAYS = 90;
const COMMENTS_PER_ACCOUNT = 3;
const COMMENT_BODY_MAX = 400;
const SOQL_LIMIT = 500;

/** Escapes a Salesforce Id for SOQL string literals. */
function escId(id) {
  return String(id).replace(/'/g, "\\'");
}

/** YYYY-MM-DD for today UTC minus N days. */
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Trims a Salesforce Id to the 15-char key so 15- and 18-char Ids join. */
function sfKey(id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  return s.length >= 15 ? s.slice(0, 15) : s || null;
}

/** True when Reason__c is an AI Enhance REMOVE recommendation. */
function isRemoveReason(reason) {
  return /^\s*\[REMOVE\]/i.test(String(reason || ''));
}

/** Empty feedback entry — keeps callers free of null checks. */
function emptyFeedback() {
  return { comments: [], keepSignal: false, declinedRemoveCount: 0 };
}

/** Writes an entry under both the full and 15-char Id keys. */
function setBothKeys(map, accountId, entry) {
  map[accountId] = entry;
  const key = sfKey(accountId);
  if (key) map[key] = entry;
}

/**
 * Loads non-AI comments for the given accounts, newest first.
 * RouteLogComment__c has no Account lookup, so it is reached through the
 * RouteLog__c parent.
 * @returns {Promise<Map<string, object[]>>} 15-char account key -> comments
 */
async function loadComments(conn, idList, since) {
  const q = `
    SELECT Body__c, Author__c, CreatedDate, Route_Log__r.Account__c
    FROM RouteLogComment__c
    WHERE Route_Log__r.Account__c IN (${idList})
      AND Is_AI__c = false
      AND CreatedDate >= ${since}T00:00:00.000Z
    ORDER BY CreatedDate DESC
    LIMIT ${SOQL_LIMIT}
  `;
  const res = await conn.query(q);
  const byAccount = new Map();
  for (const row of res.records || []) {
    const key = sfKey(row.Route_Log__r?.Account__c);
    if (!key) continue;
    const list = byAccount.get(key) || [];
    if (list.length >= COMMENTS_PER_ACCOUNT) continue;
    list.push({
      author: row.Author__c || null,
      date: String(row.CreatedDate || '').slice(0, 10),
      body: String(row.Body__c || '').slice(0, COMMENT_BODY_MAX),
    });
    byAccount.set(key, list);
  }
  return byAccount;
}

/**
 * Counts declined REMOVE recommendations per account.
 * Reason__c is a Long Text Area and cannot be filtered in SOQL, so the [REMOVE]
 * prefix is matched in memory (same approach as loadRecentlyDeclinedAddAccountIds).
 * @returns {Promise<Map<string, number>>} 15-char account key -> count
 */
async function loadDeclinedRemoves(conn, idList, since) {
  const q = `
    SELECT Account__c, Reason__c
    FROM RouteLog__c
    WHERE Skill__c = 'AI Enhance'
      AND Status__c = 'Declined'
      AND Account__c IN (${idList})
      AND CreatedDate >= ${since}T00:00:00.000Z
    LIMIT ${SOQL_LIMIT}
  `;
  const res = await conn.query(q);
  const counts = new Map();
  for (const row of res.records || []) {
    if (!isRemoveReason(row.Reason__c)) continue;
    const key = sfKey(row.Account__c);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Loads manager comments and keep signals for a set of accounts.
 * Never throws — feedback is an enrichment, not a prerequisite for routing.
 *
 * @param {object} conn - jsforce connection
 * @param {string[]} accountIds
 * @param {{ lookbackDays?: number }} [opts]
 * @returns {Promise<Record<string, { comments: object[], keepSignal: boolean,
 *   declinedRemoveCount: number }>>} keyed by full and 15-char account Id
 */
async function loadAccountFeedback(conn, accountIds = [], { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const ids = [...new Set(accountIds.filter(Boolean))];
  const byAccountId = {};
  if (!ids.length) return byAccountId;

  const idList = ids.map((id) => `'${escId(id)}'`).join(',');
  const since = daysAgoISO(lookbackDays);

  const [comments, declined] = await Promise.all([
    loadComments(conn, idList, since).catch((err) => {
      logger.warn('Manager feedback: comment load failed', { error: err.message });
      return new Map();
    }),
    loadDeclinedRemoves(conn, idList, since).catch((err) => {
      logger.warn('Manager feedback: declined REMOVE load failed', { error: err.message });
      return new Map();
    }),
  ]);

  for (const id of ids) {
    const key = sfKey(id);
    const declinedRemoveCount = declined.get(key) || 0;
    setBothKeys(byAccountId, id, {
      comments: comments.get(key) || [],
      keepSignal: declinedRemoveCount > 0,
      declinedRemoveCount,
    });
  }
  return byAccountId;
}

/** Looks up feedback by 15- or 18-char Id, always returning an entry. */
function lookupFeedback(byAccountId, accountId) {
  if (!accountId || !byAccountId) return emptyFeedback();
  return byAccountId[accountId] || byAccountId[sfKey(accountId)] || emptyFeedback();
}

module.exports = {
  DEFAULT_LOOKBACK_DAYS,
  COMMENTS_PER_ACCOUNT,
  isRemoveReason,
  emptyFeedback,
  lookupFeedback,
  loadAccountFeedback,
  // Exported for unit tests
  daysAgoISO,
  sfKey,
};
