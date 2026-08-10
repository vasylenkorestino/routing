/**
 * UCO / CDL service history loader.
 *
 * Replaces the old `(SELECT ... FROM Services__r ...)` subquery pattern. When a
 * SOQL query contains a subquery Salesforce reduces the batch to 200 records and
 * parent + child rows both count toward it, so accounts late in Id order came
 * back with no children at all — which the due engine read as "no UCO history".
 *
 * Querying Service__c directly keeps batching predictable and lets us page every
 * batch, so every requested account gets its real history.
 */

const logger = require('../utils/logger');

/** Fields the due engine + keep rules read from each Service__c row. */
const SERVICE_HISTORY_FIELDS =
  'Id, Account__c, Service_Date__c, Qty_Gallons__c, Code__c, isInaccessible__c, ' +
  'RecordType.Name, RecordType.DeveloperName';

/**
 * Service codes worth loading. Code__c is the formula
 * IF(isInaccessible__c, 'UCO-INC', ServiceCode__c), so an inaccessible visit of
 * any record type reports UCO-INC — without it, failed access attempts vanish
 * from history entirely.
 */
const HISTORY_CODES = ['UCO', 'CDL', 'UCO-INC'];

/** Account Ids per SOQL query (keeps the IN list well inside SOQL limits). */
const ACCOUNT_CHUNK_SIZE = 200;

/** Newest services kept per account — matches the old subquery LIMIT. */
const PER_ACCOUNT_LIMIT = 20;

/**
 * History window for the first pass. Covers 20 services at any cadence up to
 * ~8 weeks while bounding the row count when thousands of planner candidates
 * are evaluated at once.
 */
const HISTORY_MONTHS = 36;

/**
 * Rows below which an account is re-queried without a date bound. Slower
 * cadences (quarterly and up) fall outside the window, and a truncated count
 * would otherwise read as "new account" in the remain rules.
 */
const MIN_HISTORY_ROWS = 4;

/** Trims a Salesforce Id to the 15-char case-sensitive key shared by both forms. */
function historyKey(id) {
  if (id == null || id === '') return null;
  const s = String(id).trim();
  return s.length >= 15 ? s.slice(0, 15) : s || null;
}

/** Escapes a SOQL string literal. */
function escId(id) {
  return String(id).replace(/'/g, '');
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * YYYY-MM-DD boundary `months` before today, in UTC.
 * Computed rather than using LAST_N_MONTHS, which ends on the last day of the
 * previous month and so hides every service dated in the current month.
 */
function historySinceISO(months = HISTORY_MONTHS, today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Builds the history SOQL for one account chunk; sinceISO null loads all history. */
function buildHistorySoql(accountIds, sinceISO) {
  const inList = accountIds.map((id) => `'${escId(id)}'`).join(',');
  const codes = HISTORY_CODES.map((c) => `Code__c = '${c}'`).join(' OR ');
  return `SELECT ${SERVICE_HISTORY_FIELDS} FROM Service__c `
    + `WHERE Account__c IN (${inList}) `
    + `AND (${codes}) `
    + 'AND Service_Date__c != null '
    + (sinceISO ? `AND Service_Date__c >= ${sinceISO} ` : '')
    + 'ORDER BY Account__c, Service_Date__c DESC';
}

/** Runs a SOQL query and follows nextRecordsUrl until Salesforce reports done. */
async function queryAllPages(conn, soql) {
  const first = await conn.query(soql);
  let records = first.records || [];
  let nextRecordsUrl = first.done === false ? first.nextRecordsUrl : null;
  while (nextRecordsUrl) {
    const more = await conn.queryMore(nextRecordsUrl);
    records = records.concat(more.records || []);
    nextRecordsUrl = more.done === false ? more.nextRecordsUrl : null;
  }
  return records;
}

/**
 * Groups rows into a 15-char Account Id -> newest-first list, capped per account.
 * Relies on the query's ORDER BY Account__c, Service_Date__c DESC.
 */
function collectByAccount(rows, perAccountLimit, target = new Map()) {
  for (const row of rows) {
    const key = historyKey(row?.Account__c);
    if (!key) continue;
    const list = target.get(key);
    if (!list) {
      target.set(key, [row]);
    } else if (list.length < perAccountLimit) {
      list.push(row);
    }
  }
  return target;
}

/**
 * Loads UCO + CDL history for the given accounts, newest first.
 *
 * Two passes: a windowed query that satisfies normal cadences, then an
 * unbounded top-up for the sparse tail, so depth is driven by the per-account
 * row limit rather than by the calendar.
 *
 * @param {object} conn - jsforce connection
 * @param {string[]} accountIds - Account Ids (15- or 18-char)
 * @param {object} [opts]
 * @param {number} [opts.perAccountLimit] - newest rows kept per account
 * @param {number} [opts.minRows] - rows below which an account is re-queried unbounded
 * @returns {Promise<Map<string, object[]>>} 15-char Account Id -> rows, newest first
 */
async function loadServiceHistoryByAccountId(conn, accountIds = [], opts = {}) {
  const perAccountLimit = Number.isFinite(opts.perAccountLimit)
    ? opts.perAccountLimit
    : PER_ACCOUNT_LIMIT;
  const minRows = Number.isFinite(opts.minRows) ? opts.minRows : MIN_HISTORY_ROWS;

  const byAccount = new Map();
  const ids = [...new Set((accountIds || []).filter(Boolean).map(String))];
  if (!ids.length) return byAccount;

  const sinceISO = historySinceISO();

  for (const group of chunk(ids, ACCOUNT_CHUNK_SIZE)) {
    const rows = await queryAllPages(conn, buildHistorySoql(group, sinceISO));
    collectByAccount(rows, perAccountLimit, byAccount);

    // Accounts serviced less often than the window are truncated, not sparse —
    // and a truncated count reads as "new account" in the remain rules.
    const sparse = group.filter(
      (id) => (byAccount.get(historyKey(id)) || []).length < minRows,
    );
    if (!sparse.length) continue;

    const allRows = await queryAllPages(conn, buildHistorySoql(sparse, null));
    for (const [key, list] of collectByAccount(allRows, perAccountLimit)) {
      byAccount.set(key, list);
    }
  }

  return byAccount;
}

/**
 * Attaches loaded history onto account rows as `Services__r.records` so the
 * existing extractServiceHistory / keep-rule readers work unchanged.
 * Accounts with no rows get an empty list (verified empty, not unknown).
 */
function attachServiceHistory(accounts = [], historyByAccountId = new Map()) {
  return (accounts || []).map((acct) => {
    if (!acct?.Id) return acct;
    const records = historyByAccountId.get(historyKey(acct.Id)) || [];
    return { ...acct, Services__r: { records, done: true, totalSize: records.length } };
  });
}

/**
 * Loads history for the given accounts and returns them with it attached.
 * Errors are logged and the accounts are returned untouched so callers can tell
 * "history unavailable" apart from "verified no history".
 */
async function withServiceHistory(conn, accounts = []) {
  const ids = (accounts || []).map((a) => a?.Id).filter(Boolean);
  if (!ids.length) return accounts;
  try {
    const history = await loadServiceHistoryByAccountId(conn, ids);
    return attachServiceHistory(accounts, history);
  } catch (err) {
    logger.error('Service history load failed', { error: err.message, accounts: ids.length });
    return accounts;
  }
}

/**
 * Same as withServiceHistory but resolves the shared Salesforce connection
 * itself, for callers that only use the sf.query() helper.
 */
async function withServiceHistoryForAccounts(accounts = []) {
  if (!(accounts || []).some((a) => a?.Id)) return accounts;
  try {
    // Required lazily so pure-unit tests of this module need no SF config.
    const sf = require('../services/salesforce');
    const conn = await sf.getConnection();
    return withServiceHistory(conn, accounts);
  } catch (err) {
    logger.error('Service history load failed', { error: err.message });
    return accounts;
  }
}

module.exports = {
  SERVICE_HISTORY_FIELDS,
  HISTORY_CODES,
  ACCOUNT_CHUNK_SIZE,
  PER_ACCOUNT_LIMIT,
  HISTORY_MONTHS,
  MIN_HISTORY_ROWS,
  historySinceISO,
  loadServiceHistoryByAccountId,
  attachServiceHistory,
  withServiceHistory,
  withServiceHistoryForAccounts,
};
