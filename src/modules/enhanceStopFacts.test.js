/**
 * Unit tests for enhance stop facts / plain-English reasons.
 * Run: node agent/src/modules/enhanceStopFacts.test.js
 */
const assert = require('assert');
const {
  normalizeSfId,
  indexAccountsById,
  lookupAccount,
  resolveStopAccountId,
  formatShortDate,
  formatManagerReason,
  looksCrypticReason,
  buildEnhanceStopRow,
  indexStopFactsByAccountId,
  applyServiceHistoryReasonOverride,
} = require('./enhanceStopFacts');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

/** Builds Services__r with Code__c + optional RecordType Name / DeveloperName. */
function services(...rows) {
  return {
    records: rows.map(([date, gallons, recordType = 'UCO Collection', developerName]) => ({
      Service_Date__c: date,
      Qty_Gallons__c: gallons,
      Code__c: recordType === 'Deliver Container' ? 'CDL' : 'UCO',
      RecordType: {
        Name: recordType,
        DeveloperName: developerName
          || (recordType === 'Deliver Container' ? 'Tank_Delivered' : 'WVO_Collection'),
      },
    })),
  };
}

test('normalizeSfId trims to 15 chars', () => {
  assert.equal(normalizeSfId('001XXXXXXXXXXXXAAA'), '001XXXXXXXXXXXX');
  assert.equal(normalizeSfId('001XXXXXXXXXXXX'), '001XXXXXXXXXXXX');
});

test('15-char AccountId__c finds 18-char Account Id', () => {
  const full = '001ABCDEFGHIJKLMNOP';
  const map = indexAccountsById([{ Id: full, Name: 'Test' }]);
  assert.ok(lookupAccount(map, full));
  assert.ok(lookupAccount(map, full.slice(0, 15)));
  assert.equal(lookupAccount(map, full.slice(0, 15)).Name, 'Test');
});

test('resolveStopAccountId prefers Account__c', () => {
  assert.equal(
    resolveStopAccountId({ Account__c: '001A', AccountId__c: '001B' }),
    '001A',
  );
  assert.equal(resolveStopAccountId({ AccountId__c: '001B' }), '001B');
});

test('formatShortDate and formatManagerReason with 0 gal history', () => {
  assert.equal(formatShortDate('2026-06-08'), 'Jun 8, 2026');
  const reason = formatManagerReason(
    {
      hasUcoHistory: true,
      lastUcoDate: '2026-06-08',
      lastUcoGallons: 0,
      nextDueDate: '2026-07-06',
      daysOverdue: 5,
      due: true,
    },
    'keep',
    'overdue',
  );
  assert.equal(
    reason,
    'Last UCO: Jun 8, 2026 (0 gal). Next due ~Jul 6, 2026. Keep — overdue.',
  );
});

test('formatManagerReason for empty history', () => {
  const reason = formatManagerReason(
    { hasUcoHistory: false },
    'flag',
    'verify before committing to route',
  );
  assert.match(reason, /^No UCO pickups on record\./);
  assert.match(reason, /Flag —/);
});

test('looksCrypticReason detects field dumps', () => {
  assert.equal(looksCrypticReason('No lastServiceDate, ucoServiceCount=0'), true);
  assert.equal(looksCrypticReason('Last UCO: Jun 8, 2026 (0 gal). Keep — overdue.'), false);
});

test('buildEnhanceStopRow uses UCO history including 0 gal', () => {
  const acctId = '001ABCDEFGHIJKLMNOP';
  const stop = {
    Id: 'a0R1',
    Account__c: acctId,
    Account_Name__c: 'Tijuana Flats',
    LastGallonsCollected__c: 0,
    Fixed_point__c: false,
  };
  const account = {
    Id: acctId,
    Estimated_Pickup_Frequency__c: '4 Weeks',
    Priority_Tier__c: 'Standard',
    Services__r: services(
      ['2026-06-08', 0, 'UCO Collection'],
      ['2026-04-23', 20, 'UCO Collection'],
      ['2026-03-02', 40, 'UCO Collection'],
    ),
  };
  const row = buildEnhanceStopRow(stop, account, '2026-07-30');
  assert.equal(row.hasUcoHistory, true);
  assert.equal(row.lastServiceDate, '2026-06-08');
  assert.equal(row.lastGallons, 0);
  assert.equal(row.ucoServiceCount, 3);
  assert.equal(row.reasonFacts.lastUcoDate, '2026-06-08');
  assert.equal(row.reasonFacts.lastUcoGallons, 0);
  assert.ok(row.nextDueDate);
  assert.equal(row.recentServices.length, 3);
});

test('buildEnhanceStopRow joins when Services__r is a plain array', () => {
  const account = {
    Id: '001ARR',
    Estimated_Pickup_Frequency__c: '3 Weeks',
    Services__r: [
      {
        Service_Date__c: '2026-06-08',
        Qty_Gallons__c: 45,
        Code__c: 'UCO',
        RecordType: { Name: 'UCO Collection', DeveloperName: 'WVO_Collection' },
      },
    ],
  };
  const row = buildEnhanceStopRow(
    { Id: 'a0R2', AccountId__c: '001ARR', Account_Name__c: 'Rosati' },
    account,
    '2026-07-30',
  );
  assert.equal(row.hasUcoHistory, true);
  assert.equal(row.lastServiceDate, '2026-06-08');
  assert.equal(row.lastGallons, 45);
});

test('override rewrites false empty-history FLAG when UCO history exists', () => {
  const acctId = '001HIST';
  const account = {
    Id: acctId,
    Estimated_Pickup_Frequency__c: '4 Weeks',
    Services__r: services(
      ['2026-06-08', 0],
      ['2026-04-23', 20],
      ['2026-03-02', 40],
    ),
  };
  const row = buildEnhanceStopRow(
    { Id: 'a0R3', AccountId__c: acctId, Account_Name__c: 'Busy Bee' },
    account,
    '2026-07-30',
  );
  const { _remain, ...publicRow } = row;
  const factsById = indexStopFactsByAccountId([publicRow]);

  const out = applyServiceHistoryReasonOverride(
    [{
      accountId: acctId,
      action: 'flag',
      confidence: 35,
      reason: 'Busy Bee: No lastServiceDate, no nextDueDate, ucoServiceCount=0, lastGallons=0. No service history.',
    }],
    factsById,
  );

  assert.equal(out[0].action, 'keep');
  assert.equal(out[0]._historyReasonOverride, true);
  assert.match(out[0].reason, /^Last UCO: Jun 8, 2026 \(0 gal\)\./);
  assert.doesNotMatch(out[0].reason, /lastServiceDate|ucoServiceCount/);
});

test('override Id normalize: AI 15-char id matches 18-char stop facts', () => {
  const full = '001ABCDEFGHIJKLMNOP';
  const account = {
    Id: full,
    Estimated_Pickup_Frequency__c: '4 Weeks',
    Priority_Tier__c: 'VIP-No-fail',
    Services__r: services(['2026-06-08', 45], ['2026-05-01', 40], ['2026-04-01', 35]),
  };
  const row = buildEnhanceStopRow(
    { Id: 'a0R4', Account__c: full, Account_Name__c: 'VIP Spot' },
    account,
    '2026-07-30',
  );
  const { _remain, ...publicRow } = row;
  const factsById = indexStopFactsByAccountId([publicRow]);

  const out = applyServiceHistoryReasonOverride(
    [{
      accountId: full.slice(0, 15),
      action: 'remove',
      confidence: 20,
      reason: 'No lastServiceDate, ucoServiceCount=0',
    }],
    factsById,
  );
  assert.equal(out[0].action, 'keep');
  assert.match(out[0].reason, /Last UCO: Jun 8, 2026 \(45 gal\)/);
});

test('not-due history allows remove with plain English (not no-history)', () => {
  const acctId = '001NOTDUE';
  const account = {
    Id: acctId,
    Estimated_Pickup_Frequency__c: '8 Weeks',
    Services__r: services(
      ['2026-07-20', 50],
      ['2026-05-20', 45],
      ['2026-03-20', 40],
    ),
  };
  // Route date soon after last service → not due
  const row = buildEnhanceStopRow(
    { Id: 'a0R5', AccountId__c: acctId, Account_Name__c: 'Fresh' },
    account,
    '2026-07-25',
  );
  assert.equal(row.due, false);
  const { _remain, ...publicRow } = row;
  const factsById = indexStopFactsByAccountId([publicRow]);

  const out = applyServiceHistoryReasonOverride(
    [{
      accountId: acctId,
      action: 'remove',
      confidence: 80,
      reason: 'No lastServiceDate, ucoServiceCount=0',
    }],
    factsById,
  );
  assert.equal(out[0].action, 'remove');
  assert.match(out[0].reason, /^Last UCO:/);
  assert.match(out[0].reason, /Remove — not due yet/);
});

console.log('\nAll enhanceStopFacts tests passed.');
