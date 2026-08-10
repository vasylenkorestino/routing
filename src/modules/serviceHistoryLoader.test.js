/**
 * Unit tests for the paginated service history loader.
 * Run: node agent/src/modules/serviceHistoryLoader.test.js
 */
const assert = require('assert');
const {
  loadServiceHistoryByAccountId,
  attachServiceHistory,
  historySinceISO,
} = require('./serviceHistoryLoader');
const { extractServiceHistory } = require('./serviceDue');

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

/** Stub jsforce conn returning canned batches; records every SOQL it receives. */
function stubConn(batches) {
  const queries = [];
  const pages = [...batches];
  return {
    queries,
    async query(soql) {
      queries.push(soql);
      return pages.shift() || { records: [], done: true };
    },
    async queryMore(url) {
      queries.push(`queryMore:${url}`);
      return pages.shift() || { records: [], done: true };
    },
  };
}

function row(accountId, date, gallons, code = 'UCO') {
  return {
    Id: `a0G${date}${accountId}`,
    Account__c: accountId,
    Service_Date__c: date,
    Qty_Gallons__c: gallons,
    Code__c: code,
  };
}

test('groups rows by 15-char account Id, newest first', async () => {
  const conn = stubConn([
    {
      done: true,
      records: [
        row('001AAAAAAAAAAAAAAA', '2026-06-11', 35),
        row('001AAAAAAAAAAAAAAA', '2026-04-13', 30),
        row('001BBBBBBBBBBBBBBB', '2026-07-23', 60),
      ],
    },
  ]);

  const map = await loadServiceHistoryByAccountId(conn, [
    '001AAAAAAAAAAAAAAA',
    '001BBBBBBBBBBBBBBB',
  ]);

  assert.equal(map.size, 2);
  assert.equal(map.get('001AAAAAAAAAAAA').length, 2);
  assert.equal(map.get('001AAAAAAAAAAAA')[0].Service_Date__c, '2026-06-11');
  assert.equal(map.get('001BBBBBBBBBBBB')[0].Qty_Gallons__c, 60);
});

test('queries Service__c directly with Code__c and a computed date boundary', async () => {
  const conn = stubConn([{ done: true, records: [] }]);
  await loadServiceHistoryByAccountId(conn, ['001AAAAAAAAAAAAAAA']);

  const soql = conn.queries[0];
  assert.match(soql, /FROM Service__c/);
  assert.match(soql, /Account__c IN \('001AAAAAAAAAAAAAAA'\)/);
  assert.match(soql, /Code__c = 'UCO'/);
  assert.match(soql, /Code__c = 'CDL'/);
  assert.match(soql, /Code__c = 'UCO-INC'/, 'inaccessible visits are loaded');
  assert.match(soql, /isInaccessible__c/);
  assert.match(soql, /Service_Date__c != null/);
  assert.match(soql, new RegExp(`Service_Date__c >= ${historySinceISO()}`));
  assert.doesNotMatch(soql, /LAST_N_MONTHS/, 'the literal hides the current month');
  assert.doesNotMatch(soql, /Services__r/);
});

test('history boundary rolls daily, so the current month is never cut off', () => {
  assert.equal(historySinceISO(36, new Date('2026-08-01T12:00:00Z')), '2023-08-01');
  assert.equal(historySinceISO(36, new Date('2026-08-31T12:00:00Z')), '2023-08-31');
  // A service dated today is inside the window on any day of the month.
  assert.ok('2026-08-02' >= historySinceISO(36, new Date('2026-08-02T12:00:00Z')));
});

test('re-queries sparse accounts without a date bound', async () => {
  const conn = stubConn([
    { done: true, records: [row('001AAAAAAAAAAAAAAA', '2026-06-11', 35)] },
    {
      done: true,
      records: [
        row('001AAAAAAAAAAAAAAA', '2026-06-11', 35),
        row('001AAAAAAAAAAAAAAA', '2021-02-10', 30),
        row('001AAAAAAAAAAAAAAA', '2020-02-10', 25),
      ],
    },
  ]);
  const map = await loadServiceHistoryByAccountId(conn, ['001AAAAAAAAAAAAAAA']);

  assert.equal(conn.queries.length, 2);
  assert.match(conn.queries[0], /Service_Date__c >= \d{4}-\d{2}-\d{2}/);
  assert.doesNotMatch(conn.queries[1], /Service_Date__c >=/);
  assert.equal(map.get('001AAAAAAAAAAAA').length, 3, 'older history replaces the truncated pass');
});

test('skips the top-up query when the window returns enough history', async () => {
  const conn = stubConn([{
    done: true,
    records: [
      row('001AAAAAAAAAAAAAAA', '2026-06-11', 35),
      row('001AAAAAAAAAAAAAAA', '2026-05-14', 30),
      row('001AAAAAAAAAAAAAAA', '2026-04-16', 32),
      row('001AAAAAAAAAAAAAAA', '2026-03-19', 28),
    ],
  }]);
  await loadServiceHistoryByAccountId(conn, ['001AAAAAAAAAAAAAAA']);
  assert.equal(conn.queries.length, 1);
});

test('caps history at 20 rows per account', async () => {
  const records = [];
  for (let i = 0; i < 30; i += 1) {
    records.push(row('001AAAAAAAAAAAAAAA', `2026-01-${String(i + 1).padStart(2, '0')}`, i));
  }
  const conn = stubConn([{ done: true, records }]);
  const map = await loadServiceHistoryByAccountId(conn, ['001AAAAAAAAAAAAAAA']);
  assert.equal(map.get('001AAAAAAAAAAAA').length, 20);
});

test('follows nextRecordsUrl and merges every batch', async () => {
  const conn = stubConn([
    { done: false, nextRecordsUrl: '/next/1', records: [row('001AAAAAAAAAAAAAAA', '2026-06-11', 35)] },
    { done: false, nextRecordsUrl: '/next/2', records: [row('001BBBBBBBBBBBBBBB', '2026-06-12', 40)] },
    { done: true, records: [row('001CCCCCCCCCCCCCCC', '2026-06-13', 45)] },
  ]);

  const map = await loadServiceHistoryByAccountId(conn, [
    '001AAAAAAAAAAAAAAA',
    '001BBBBBBBBBBBBBBB',
    '001CCCCCCCCCCCCCCC',
  ]);

  assert.equal(map.size, 3, 'every batch is merged');
  assert.deepEqual(conn.queries.slice(1, 3), ['queryMore:/next/1', 'queryMore:/next/2']);
});

test('chunks more than 200 account Ids into multiple queries', async () => {
  const ids = Array.from({ length: 450 }, (_, i) => `001${String(i).padStart(15, '0')}`);
  const conn = stubConn([]);
  await loadServiceHistoryByAccountId(conn, ids);
  assert.equal(conn.queries.length, 6, '3 chunks, each followed by a top-up pass');
});

test('deduplicates account Ids before querying', async () => {
  const conn = stubConn([{ done: true, records: [] }]);
  await loadServiceHistoryByAccountId(conn, ['001AAAAAAAAAAAAAAA', '001AAAAAAAAAAAAAAA']);
  assert.equal(conn.queries[0].match(/001AAAAAAAAAAAAAAA/g).length, 1);
});

test('attachServiceHistory shapes rows for extractServiceHistory', async () => {
  const conn = stubConn([
    {
      done: true,
      records: [
        row('001AAAAAAAAAAAAAAA', '2026-06-11', 35),
        row('001AAAAAAAAAAAAAAA', '2026-01-07', null, 'CDL'),
      ],
    },
  ]);
  const map = await loadServiceHistoryByAccountId(conn, ['001AAAAAAAAAAAAAAA']);

  const [withHistory, withoutHistory] = attachServiceHistory(
    [{ Id: '001AAAAAAAAAAAAAAA' }, { Id: '001ZZZZZZZZZZZZZZZ' }],
    map,
  );

  const hist = extractServiceHistory(withHistory);
  assert.equal(hist.length, 1, 'CDL rows are excluded from UCO history');
  assert.equal(hist[0].date, '2026-06-11');
  assert.equal(hist[0].gallons, 35);
  assert.deepEqual(withoutHistory.Services__r.records, [], 'verified empty, not undefined');
});

test('no account Ids means no query', async () => {
  const conn = stubConn([]);
  const map = await loadServiceHistoryByAccountId(conn, []);
  assert.equal(map.size, 0);
  assert.equal(conn.queries.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(err);
      process.exit(1);
    }
  }
  console.log(`\n${tests.length} serviceHistoryLoader tests passed`);
})();
