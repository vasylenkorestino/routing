/**
 * Unit tests for due-aware AI Enhance ADD candidates.
 * Run: node src/services/enhanceAddCandidates.test.js
 */
const assert = require('assert');
const {
  isDueForAdd,
  mapCandidate,
  rankCandidates,
  loadRecentlyDeclinedAddAccountIds,
  isAddReason,
  DECLINED_ADD_LOOKBACK_DAYS,
} = require('./enhanceAddCandidates');

const pending = [];

function test(name, fn) {
  pending.push(
    Promise.resolve()
      .then(() => fn())
      .then(() => console.log(`✓ ${name}`))
      .catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      }),
  );
}

/** Builds a Services__r-shaped subquery result from [date, gallons] pairs. */
function services(...pairs) {
  return { records: pairs.map(([date, gallons]) => ({ Service_Date__c: date, Qty_Gallons__c: gallons })) };
}

/* ── due hard filter (Manjay-like) ────────────────────────── */

test('Manjay-like: serviced ~10 days ago on 4 Weeks is not due for ADD', () => {
  // Service on 2026-07-06, route date 2026-07-16 → 10 days into a 28-day cycle.
  // 3+ UCO history so new-account remain rules do not force ADD.
  const account = {
    Id: '001MANJAY',
    Name: 'Manjay',
    UCOLastServiceDate__c: '2026-07-06',
    Estimated_Pickup_Frequency__c: '4 Weeks',
    Tank_Size__c: '100 Gallon',
    Services__r: services(['2026-07-06', 40], ['2026-06-08', 45], ['2026-05-11', 50]),
  };
  assert.equal(isDueForAdd(account, '2026-07-16'), false);
});

test('overdue account on 2 Weeks is due for ADD', () => {
  const account = {
    Id: '001DUE',
    Name: 'Due Cafe',
    UCOLastServiceDate__c: '2026-06-20',
    Estimated_Pickup_Frequency__c: '2 Weeks',
    Services__r: services(['2026-06-20', 50]),
  };
  assert.equal(isDueForAdd(account, '2026-07-16'), true);
});

test('On-Call accounts are never due for ADD', () => {
  const account = {
    UCOLastServiceDate__c: '2020-01-01',
    Estimated_Pickup_Frequency__c: 'On-Call',
  };
  assert.equal(isDueForAdd(account, '2026-07-16'), false);
});

test('stale UCOLastServiceDate with recent history is not ADD (Wings & More)', () => {
  const account = {
    Id: '001WINGS',
    UCOLastServiceDate__c: '2020-09-18',
    Estimated_Pickup_Frequency__c: '3 Weeks',
    Services__r: services(['2024-07-16', 15], ['2024-07-01', 50], ['2024-04-10', 70]),
  };
  assert.equal(isDueForAdd(account, '2024-07-30'), false);
});

test('CDL >14 days with no UCO is ADD-eligible via mustRemain', () => {
  const account = {
    Id: '001CDL',
    Services__r: {
      records: [{
        Service_Date__c: '2026-07-01',
        Qty_Gallons__c: null,
        RecordType: { Name: 'Deliver Container' },
      }],
    },
  };
  assert.equal(isDueForAdd(account, '2026-07-20'), true);
});

test('account with 1 UCO is ADD-eligible via first-three remain rule', () => {
  const account = {
    Id: '001NEW',
    UCOLastServiceDate__c: '2026-07-10',
    Estimated_Pickup_Frequency__c: '4 Weeks',
    Services__r: {
      records: [{
        Service_Date__c: '2026-07-10',
        Qty_Gallons__c: 40,
        RecordType: { Name: 'UCO Collection' },
      }],
    },
  };
  // Not due by frequency (10 days into 28-day cycle) but must remain.
  assert.equal(isDueForAdd(account, '2026-07-20'), true);
});

test('mature recently serviced account stays excluded from ADD', () => {
  const account = {
    Id: '001MATURE',
    UCOLastServiceDate__c: '2026-07-10',
    Estimated_Pickup_Frequency__c: '4 Weeks',
    Services__r: {
      records: [
        { Service_Date__c: '2026-07-10', Qty_Gallons__c: 40, RecordType: { Name: 'UCO Collection' } },
        { Service_Date__c: '2026-06-12', Qty_Gallons__c: 45, RecordType: { Name: 'UCO Collection' } },
        { Service_Date__c: '2026-05-15', Qty_Gallons__c: 50, RecordType: { Name: 'UCO Collection' } },
      ],
    },
  };
  assert.equal(isDueForAdd(account, '2026-07-20'), false);
});

/* ── map + rank ───────────────────────────────────────────── */

test('mapCandidate includes due context and shape flags', () => {
  const account = {
    Id: '001MAP',
    Name: 'Mapped',
    MALatitude__c: 40.1,
    MALongitude__c: -74.1,
    UCOLastServiceDate__c: '2026-06-01',
    Estimated_Pickup_Frequency__c: '2 Weeks',
    Shape__c: 'a0sROUTE',
    Shape_Name__c: 'Route Shape',
    Priority_Tier__c: 'VIP',
    DaysInterval__c: 77,
    Services__r: services(['2026-06-01', 60]),
  };
  const mapped = mapCandidate(account, '2026-07-16', {
    routeShapeId: 'a0sROUTE',
    neighborShapeIds: ['a0sN1'],
  });
  assert.equal(mapped.accountId, '001MAP');
  assert.equal(mapped.lastServiceDate, '2026-06-01');
  assert.ok(mapped.nextDueDate);
  assert.ok(mapped.daysOverdue > 0);
  assert.equal(mapped.inRouteShape, true);
  assert.equal(mapped.inNeighborShape, false);
  assert.equal(mapped.shapeName, 'Route Shape');
  assert.ok(mapped.dueReason);
  assert.equal(mapped.gpdHistorySpanDays, 77);
  assert.equal(mapped.interval, undefined);
});

test('rankCandidates sorts by overdue days then estimated gallons', () => {
  const ranked = rankCandidates([
    { accountId: 'a', daysOverdue: 2, estimatedGallonsAtDate: 90, inRouteShape: true, inNeighborShape: false },
    { accountId: 'b', daysOverdue: 10, estimatedGallonsAtDate: 20, inRouteShape: false, inNeighborShape: true },
    { accountId: 'c', daysOverdue: 10, estimatedGallonsAtDate: 80, inRouteShape: false, inNeighborShape: false },
  ]);
  assert.deepEqual(ranked.map((c) => c.accountId), ['c', 'b', 'a']);
});

/* ── declined ADD exclusion ───────────────────────────────── */

test('isAddReason detects [ADD] prefix only', () => {
  assert.equal(isAddReason('[ADD] Cafe: overdue'), true);
  assert.equal(isAddReason('[REMOVE] Cafe: skip'), false);
  assert.equal(isAddReason(null), false);
});

test('loadRecentlyDeclinedAddAccountIds filters [ADD] in memory (Reason__c not filterable)', async () => {
  const calls = [];
  const conn = {
    query: async (soql) => {
      calls.push(soql);
      return {
        records: [
          { Account__c: '001DECLINED', Reason__c: '[ADD] Cafe: not a fit' },
          { Account__c: '001DECLINED', Reason__c: '[ADD] Cafe: again' },
          { Account__c: '001REMOVE', Reason__c: '[REMOVE] Skip this' },
          { Account__c: '001OTHER', Reason__c: '[ADD] Other: declined' },
        ],
      };
    },
  };
  const set = await loadRecentlyDeclinedAddAccountIds(conn, ['001DECLINED', '001OTHER', '001REMOVE', '001OK']);
  assert.equal(set.has('001DECLINED'), true);
  assert.equal(set.has('001OTHER'), true);
  assert.equal(set.has('001REMOVE'), false);
  assert.equal(set.has('001OK'), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Skill__c = 'AI Enhance'/);
  assert.match(calls[0], /Status__c = 'Declined'/);
  assert.match(calls[0], /SELECT Account__c, Reason__c/);
  assert.doesNotMatch(calls[0], /Reason__c LIKE/);
  assert.ok(Number.isInteger(DECLINED_ADD_LOOKBACK_DAYS) && DECLINED_ADD_LOOKBACK_DAYS === 45);
});

test('loadRecentlyDeclinedAddAccountIds returns empty set for no ids', async () => {
  let queried = false;
  const conn = { query: async () => { queried = true; return { records: [] }; } };
  const set = await loadRecentlyDeclinedAddAccountIds(conn, []);
  assert.equal(set.size, 0);
  assert.equal(queried, false);
});

Promise.all(pending)
  .then(() => {
    console.log('\nAll enhanceAddCandidates tests passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
