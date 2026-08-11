/**
 * Unit tests for enhance stop facts / plain-English reasons.
 * Run: node agent/src/modules/enhanceStopFacts.test.js
 */
const assert = require('assert');
const {
  HISTORY_UNAVAILABLE_REASON,
  normalizeSfId,
  indexAccountsById,
  lookupAccount,
  resolveStopAccountId,
  formatShortDate,
  formatManagerReason,
  looksCrypticReason,
  buildEnhanceStopRow,
  indexStopFactsByAccountId,
  resolveDueTier,
  shouldForceNotDue,
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

/**
 * Builds stop facts for an account serviced 5 days before the route date on an
 * 8-week cadence, i.e. not due. Overrides let a case add VIP / fixed / fewer
 * services without repeating the setup.
 */
function notDueStopFacts({ account = {}, stop = {}, routeDate = '2026-07-25' } = {}) {
  const acctId = '001NOTDUE000000';
  const row = buildEnhanceStopRow(
    { Id: 'a0RND', AccountId__c: acctId, Account_Name__c: 'Fresh', ...stop },
    {
      Id: acctId,
      Estimated_Pickup_Frequency__c: '8 Weeks',
      Services__r: services(['2026-07-20', 50], ['2026-05-20', 45], ['2026-03-20', 40]),
      ...account,
    },
    routeDate,
  );
  const { _remain, ...publicRow } = row;
  return { row, acctId, factsById: indexStopFactsByAccountId([publicRow]) };
}

/** Runs one AI stop recommendation through the override for a not-due account. */
function overrideNotDue(rec, setup = {}) {
  const { acctId, factsById, row } = notDueStopFacts(setup);
  const out = applyServiceHistoryReasonOverride(
    [{ accountId: acctId, confidence: 75, ...rec }],
    factsById,
  );
  return { result: out[0], row };
}

test('not-due KEEP is downgraded to remove and loses the soft rationale', () => {
  const { result, row } = overrideNotDue({
    action: 'keep',
    reason: 'Last UCO: Jul 20, 2026 (50 gal). Next due ~Sep 14. Keep — not yet due, high single-visit volume warrants retention.',
  });

  assert.equal(row.due, false);
  assert.equal(result.action, 'remove');
  assert.equal(result._notDueOverride, true);
  assert.match(result.reason, /^Last UCO: Jul 20, 2026 \(50 gal\)\./);
  assert.match(result.reason, /Remove — not due yet\.$/);
  assert.doesNotMatch(result.reason, /warrants retention/i);
  assert.ok(result.confidence >= 90);
});

test('not-due OVERFLOW is downgraded to remove', () => {
  const { result } = overrideNotDue({ action: 'overflow', reason: 'Keep for load balance.' });
  assert.equal(result.action, 'remove');
  assert.equal(result._notDueOverride, true);
});

test('not-due KEEP survives when the account must remain on route', () => {
  // Two UCO services → new-account remain rule applies.
  const { result } = overrideNotDue(
    { action: 'keep', reason: 'Newer account building a pickup pattern.' },
    { account: { Services__r: services(['2026-07-20', 50], ['2026-05-20', 45]) } },
  );
  assert.equal(result.action, 'keep');
  assert.equal(result._notDueOverride, undefined);
});

test('not-due KEEP survives for fixed points and VIP accounts', () => {
  const fixed = overrideNotDue(
    { action: 'keep', reason: 'Fixed stop on every run.' },
    { stop: { Fixed_point__c: true } },
  );
  assert.equal(fixed.result.action, 'keep');

  const vip = overrideNotDue(
    { action: 'keep', reason: 'No-fail customer.' },
    { account: { Priority_Tier__c: 'VIP-No-fail' } },
  );
  assert.equal(vip.result.action, 'keep');
});

test('due stop is untouched by the not-due guard', () => {
  const { result, row } = overrideNotDue(
    { action: 'keep', reason: 'Last UCO: Jul 20, 2026 (50 gal). Next due ~Sep 14. Keep — overdue.' },
    { routeDate: '2026-09-30' },
  );
  assert.equal(row.due, true);
  assert.equal(result.action, 'keep');
  assert.equal(result._notDueOverride, undefined);
});

test('on-call account with no next due date is never auto-removed', () => {
  const { result } = overrideNotDue(
    { action: 'keep', reason: 'Last UCO: Jul 20, 2026 (50 gal). Keep — on-call pickup schedule.' },
    { account: { Estimated_Pickup_Frequency__c: 'On-Call' } },
  );
  assert.equal(result.action, 'keep');
  assert.equal(
    shouldForceNotDue({ hasUcoHistory: true, nextDueDate: null, due: false }),
    false,
  );
});

test('missing account row reports history unavailable, never "no pickups"', () => {
  const acctId = '001MISSING00000';
  // Account was not returned by the query → join yields an empty object.
  const row = buildEnhanceStopRow(
    { Id: 'a0R6', AccountId__c: acctId, Account_Name__c: 'Red Wok' },
    {},
    '2026-07-30',
  );
  assert.equal(row.historyUnavailable, true);
  assert.equal(row.reasonFacts.historyUnavailable, true);

  const { _remain, ...publicRow } = row;
  const factsById = indexStopFactsByAccountId([publicRow]);

  const out = applyServiceHistoryReasonOverride(
    [{
      accountId: acctId,
      action: 'flag',
      confidence: 40,
      reason: 'Red Wok: No UCO pickups on record and no last service date on file.',
    }],
    factsById,
  );

  assert.equal(out[0]._historyReasonOverride, true);
  assert.equal(out[0].action, 'flag');
  assert.equal(out[0].reason, HISTORY_UNAVAILABLE_REASON);
  assert.doesNotMatch(out[0].reason, /No UCO pickups/i);
});

test('formatManagerReason never claims no history when unavailable', () => {
  const reason = formatManagerReason(
    { hasUcoHistory: false, historyUnavailable: true },
    'remove',
    'not due yet',
  );
  assert.equal(reason, HISTORY_UNAVAILABLE_REASON);
});

test('joined account with genuinely empty history still reports no pickups', () => {
  const row = buildEnhanceStopRow(
    { Id: 'a0R7', AccountId__c: '001EMPTY0000000', Account_Name__c: 'Brand New' },
    { Id: '001EMPTY0000000', Services__r: { records: [] } },
    '2026-07-30',
  );
  assert.equal(row.historyUnavailable, false);
  assert.equal(row.hasUcoHistory, false);
  assert.match(formatManagerReason(row.reasonFacts, 'flag'), /^No UCO pickups on record\./);
});

/* ── due before the route's next run (Coral Gables Aug 11 route) ───────── */

/** Aug 11 route on a 13-day cadence: the truck is not back until Aug 24. */
const AUG_11_CTX = { nextVisitDate: '2026-08-24', cadenceDays: 13, cadenceSource: 'route_history' };

/** Builds facts + override input for one stop on the Aug 11 Coral Gables route. */
function aug11Stop(accountId, account, ctx = AUG_11_CTX) {
  const row = buildEnhanceStopRow(
    { Id: `a0R_${accountId}`, AccountId__c: accountId, Account_Name__c: accountId },
    { Id: accountId, ...account },
    '2026-08-11',
    ctx,
  );
  const { _remain, ...publicRow } = row;
  return { row, factsById: indexStopFactsByAccountId([publicRow]) };
}

test('Brightside Miami: due Aug 14, kept because the truck returns Aug 24', () => {
  // Real history — 80 gal on Jul 31, on a 2-week cadence.
  const { row, factsById } = aug11Stop('001BRIGHTSIDE00', {
    Estimated_Pickup_Frequency__c: '2 Weeks',
    Tank_Size__c: '140 Gallon',
    Services__r: services(
      ['2026-07-31', 80], ['2026-07-21', 60], ['2026-07-13', 80],
      ['2026-07-02', 80], ['2026-06-23', 80], ['2026-06-09', 80],
    ),
  });

  assert.equal(row.due, false, 'not due on the route date itself');
  assert.equal(row.nextDueDate, '2026-08-14');
  assert.equal(row.dueTier, 'due_before_next_visit');
  assert.equal(row.dueBeforeNextVisit, true);
  assert.equal(row.daysUntilDue, 3);
  assert.equal(shouldForceNotDue(row.reasonFacts), false);

  const out = applyServiceHistoryReasonOverride(
    [{
      accountId: '001BRIGHTSIDE00',
      action: 'remove',
      confidence: 88,
      reason: 'Brightside Miami: Last UCO: Jul 31, 2026 (80 gal). Not due until Aug 14. Remove — not yet due and no protective flag.',
    }],
    factsById,
  );

  assert.equal(out[0].action, 'keep');
  assert.doesNotMatch(out[0].reason, /not (yet )?due/i);
  assert.equal(
    out[0].reason,
    "Last UCO: Jul 31, 2026 (80 gal). Due Aug 14, 2026 — before this route's next run "
    + '(~Aug 24, 2026). Keep — comes due before this route returns.',
  );
});

test('Pinecrest Bakery F5: due Aug 17, still inside the Aug 24 horizon', () => {
  const { row } = aug11Stop('001PINECRESTF5', {
    Estimated_Pickup_Frequency__c: '2 Weeks',
    Tank_Size__c: '240 Gallon',
    Services__r: services(
      ['2026-08-03', 180], ['2026-07-16', 160], ['2026-07-02', 160],
      ['2026-06-19', 0], ['2026-06-10', 110],
    ),
  });
  assert.equal(row.due, false);
  assert.equal(row.nextDueDate, '2026-08-17');
  assert.equal(row.dueTier, 'due_before_next_visit');
});

test('an account due after the next run is still removed as not due', () => {
  const { row, factsById } = aug11Stop('001LATE00000000', {
    Estimated_Pickup_Frequency__c: '8 Weeks',
    Services__r: services(['2026-08-03', 60], ['2026-06-08', 55], ['2026-04-13', 50]),
  });

  assert.equal(row.nextDueDate, '2026-09-28');
  assert.equal(row.dueTier, 'not_due');
  assert.equal(row.dueBeforeNextVisit, false);
  assert.equal(shouldForceNotDue(row.reasonFacts), true);

  const out = applyServiceHistoryReasonOverride(
    [{ accountId: '001LATE00000000', action: 'keep', confidence: 70, reason: 'Strong volume account.' }],
    factsById,
  );
  assert.equal(out[0].action, 'remove');
  assert.match(out[0].reason, /Remove — not due yet\.$/);
});

test('without a next-visit horizon the old strict behaviour is unchanged', () => {
  const { row } = aug11Stop(
    '001NOCTX0000000',
    { Services__r: services(['2026-07-31', 80], ['2026-07-17', 80], ['2026-07-03', 80]) },
    {},
  );
  assert.equal(row.nextVisitDate, null);
  assert.equal(row.dueTier, 'not_due');
  assert.equal(shouldForceNotDue(row.reasonFacts), true);
});

test('a manager who declined a removal keeps the stop on the route', () => {
  const acctId = '001MANAGER00000';
  const { row, factsById } = aug11Stop(acctId, {
    Estimated_Pickup_Frequency__c: '8 Weeks',
    Services__r: services(['2026-08-03', 60], ['2026-06-08', 55], ['2026-04-13', 50]),
  }, {
    ...AUG_11_CTX,
    feedback: {
      keepSignal: true,
      comments: [{ author: 'Russell Kamalov', date: '2026-08-10', body: 'they are due this week might as well go' }],
    },
  });

  assert.equal(row.dueTier, 'not_due');
  assert.equal(row.managerKeepSignal, true);
  assert.equal(row.managerComments.length, 1);
  assert.equal(shouldForceNotDue(row.reasonFacts), false);

  const out = applyServiceHistoryReasonOverride(
    [{ accountId: acctId, action: 'remove', confidence: 80, reason: 'Remove — not due yet.' }],
    factsById,
  );
  assert.equal(out[0].action, 'keep');
  assert.match(out[0].reason, /manager kept this stop previously/);
});

test('resolveDueTier classifies against the next visit date', () => {
  const base = { hasUcoHistory: true, nextDueDate: '2026-08-17', nextVisitDate: '2026-08-24' };
  assert.equal(resolveDueTier({ ...base, daysUntilDue: -3 }), 'overdue');
  assert.equal(resolveDueTier({ ...base, daysUntilDue: 0 }), 'due_today');
  assert.equal(resolveDueTier({ ...base, daysUntilDue: 6 }), 'due_before_next_visit');
  assert.equal(
    resolveDueTier({ ...base, nextDueDate: '2026-09-30', daysUntilDue: 50 }),
    'not_due',
  );
  assert.equal(resolveDueTier({ hasUcoHistory: false, daysUntilDue: 6 }), 'unknown');
  assert.equal(resolveDueTier({ hasUcoHistory: true, nextDueDate: null }), 'unknown');
});

console.log('\nAll enhanceStopFacts tests passed.');
