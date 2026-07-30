/**
 * Unit tests for the service-due evaluation engine.
 * Run: node agent/src/modules/serviceDue.test.js
 */
const assert = require('assert');
const {
  parsePicklistFrequencyDays,
  parseFrequencyDays,
  isOnCall,
  isUcoCollectionService,
  extractServiceHistory,
  estimateFrequencyFromHistory,
  parseTankCapacity,
  estimateFillRate,
  resolveLastServiceDate,
  estimateGallonsAtDate,
  evaluateAccount,
  SERVICE_HISTORY_SUBQUERY,
} = require('./serviceDue');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

/** Builds a Services__r-shaped subquery result from [date, gallons] pairs. */
function services(...pairs) {
  return {
    records: pairs.map(([date, gallons]) => ({
      Service_Date__c: date,
      Qty_Gallons__c: gallons,
      Code__c: 'UCO',
    })),
  };
}

test('SERVICE_HISTORY_SUBQUERY filters by Code__c UCO/CDL', () => {
  assert.match(SERVICE_HISTORY_SUBQUERY, /Code__c = 'UCO'/);
  assert.match(SERVICE_HISTORY_SUBQUERY, /Code__c = 'CDL'/);
  assert.match(SERVICE_HISTORY_SUBQUERY, /\bCode__c\b/);
});

test('isUcoCollectionService prefers Code__c', () => {
  assert.equal(isUcoCollectionService({ Code__c: 'UCO', Service_Date__c: '2026-06-01' }), true);
  assert.equal(isUcoCollectionService({ Code__c: 'CDL', Service_Date__c: '2026-06-01' }), false);
  assert.equal(
    isUcoCollectionService({ RecordType: { Name: 'UCO Collection' }, Service_Date__c: '2026-06-01' }),
    true,
  );
});

test('extractServiceHistory keeps Code__c UCO and drops CDL', () => {
  const hist = extractServiceHistory({
    Services__r: {
      records: [
        { Service_Date__c: '2026-06-01', Qty_Gallons__c: 40, Code__c: 'UCO' },
        { Service_Date__c: '2026-05-01', Qty_Gallons__c: null, Code__c: 'CDL' },
      ],
    },
  });
  assert.equal(hist.length, 1);
  assert.equal(hist[0].date, '2026-06-01');
  assert.equal(hist[0].gallons, 40);
});

/* ── frequency picklist parsing ───────────────────────────── */

test('parses every picklist value to the right number of days', () => {
  assert.equal(parsePicklistFrequencyDays('1 Week'), 7);
  assert.equal(parsePicklistFrequencyDays('2 Weeks'), 14);
  assert.equal(parsePicklistFrequencyDays('3 Weeks'), 21);
  assert.equal(parsePicklistFrequencyDays('4 Weeks'), 28);
  assert.equal(parsePicklistFrequencyDays('5 Weeks'), 35);
  assert.equal(parsePicklistFrequencyDays('6 Weeks'), 42);
  assert.equal(parsePicklistFrequencyDays('8 Weeks'), 56);
  assert.equal(parsePicklistFrequencyDays('10 Weeks'), 70);
  assert.equal(parsePicklistFrequencyDays('12 Weeks'), 84);
  assert.equal(parsePicklistFrequencyDays('16 Weeks'), 112);
  assert.equal(parsePicklistFrequencyDays('Bi-Annually'), 182);
  assert.equal(parsePicklistFrequencyDays('Anually'), 365);
  assert.equal(parsePicklistFrequencyDays('Annually'), 365);
});

test('On-Call, empty and junk labels parse to null', () => {
  assert.equal(parsePicklistFrequencyDays('On-Call'), null);
  assert.equal(parsePicklistFrequencyDays(''), null);
  assert.equal(parsePicklistFrequencyDays(null), null);
  assert.equal(parsePicklistFrequencyDays('whenever'), null);
});

test('isOnCall detects the On-Call picklist value only', () => {
  assert.equal(isOnCall({ Estimated_Pickup_Frequency__c: 'On-Call' }), true);
  assert.equal(isOnCall({ Estimated_Pickup_Frequency__c: '3 Weeks' }), false);
  assert.equal(isOnCall({}), false);
});

test('picklist wins over Pickup_Frequency_in_Days__c; numeric field is the fallback', () => {
  assert.deepEqual(
    parseFrequencyDays({ Estimated_Pickup_Frequency__c: '3 Weeks', Pickup_Frequency_in_Days__c: 10 }),
    { days: 21, source: 'picklist' },
  );
  assert.deepEqual(
    parseFrequencyDays({ Pickup_Frequency_in_Days__c: 10 }),
    { days: 10, source: 'pickup_frequency_in_days' },
  );
  assert.equal(parseFrequencyDays({}), null);
});

/* ── frequency estimation from history ────────────────────── */

test('estimates frequency from history: ~21-day intervals snap to 3 Weeks', () => {
  const hist = extractServiceHistory({
    Services__r: services(['2026-06-01', 50], ['2026-05-11', 45], ['2026-04-20', 55]),
  });
  const est = estimateFrequencyFromHistory(hist);
  assert.equal(est.days, 21);
  assert.equal(est.label, '3 Weeks');
});

test('estimation needs at least 2 dated services', () => {
  assert.equal(estimateFrequencyFromHistory([]), null);
  assert.equal(estimateFrequencyFromHistory([{ date: '2026-06-01', gallons: 50 }]), null);
});

test('estimation clamps extreme intervals into the 7-365 day picklist range', () => {
  const daily = estimateFrequencyFromHistory([
    { date: '2026-06-03', gallons: 5 }, { date: '2026-06-02', gallons: 5 }, { date: '2026-06-01', gallons: 5 },
  ]);
  assert.equal(daily.days, 7);
  const rare = estimateFrequencyFromHistory([
    { date: '2026-06-01', gallons: 50 }, { date: '2023-06-01', gallons: 50 },
  ]);
  assert.equal(rare.days, 365);
});

/* ── tank capacity + fill rate ────────────────────────────── */

test('Tank_Size__c parses to gallons; Jugs/empty fall back to other capacity fields', () => {
  assert.deepEqual(parseTankCapacity({ Tank_Size__c: '250 Gallon' }), { gallons: 250, source: 'tank_size' });
  assert.deepEqual(parseTankCapacity({ Tank_Size__c: '50 Gallon (P)' }), { gallons: 50, source: 'tank_size' });
  assert.deepEqual(
    parseTankCapacity({ Tank_Size__c: 'Jugs', ContainerCapacity__c: 100 }),
    { gallons: 100, source: 'container_capacity' },
  );
  assert.deepEqual(
    parseTankCapacity({ Container_Size_number__c: 70 }),
    { gallons: 70, source: 'container_size_number' },
  );
  assert.equal(parseTankCapacity({ Tank_Size__c: 'Jugs' }), null);
});

test('fill rate = avg gross gallons per service / median interval', () => {
  const hist = extractServiceHistory({
    Services__r: services(['2026-06-01', 60], ['2026-05-12', 40], ['2026-04-22', 50]),
  });
  // avg 50 gal per service / 20-day median interval = 2.5 gal/day
  assert.equal(estimateFillRate(hist), 2.5);
});

test('fill rate needs 2+ dates and at least one positive gallons reading', () => {
  assert.equal(estimateFillRate(extractServiceHistory({ Services__r: services(['2026-06-01', 50]) })), null);
  assert.equal(
    estimateFillRate(extractServiceHistory({ Services__r: services(['2026-06-01', 0], ['2026-05-01', null]) })),
    null,
  );
});

/* ── last service date resolution ─────────────────────────── */

test('uses newest UCO Collection Service__c only (ignores UCOLastServiceDate__c)', () => {
  assert.deepEqual(
    resolveLastServiceDate({ UCOLastServiceDate__c: '2026-06-15', Services__r: services(['2026-06-20', 50]) }),
    { date: '2026-06-20', source: 'service_history' },
  );
  // Field newer than history — still use history.
  assert.deepEqual(
    resolveLastServiceDate({ UCOLastServiceDate__c: '2026-06-25', Services__r: services(['2026-06-20', 50]) }),
    { date: '2026-06-20', source: 'service_history' },
  );
  assert.deepEqual(
    resolveLastServiceDate({ Services__r: services(['2026-06-20', 50], ['2026-05-20', 40]) }),
    { date: '2026-06-20', source: 'service_history' },
  );
  // Field-only → null (no history fallback).
  assert.equal(resolveLastServiceDate({ UCOLastServiceDate__c: '2026-06-20' }), null);
  assert.equal(resolveLastServiceDate({}), null);
});

test('stale UCOLastServiceDate__c does not invent multi-year overdue (Wings & More case)', () => {
  const res = evaluateAccount(
    {
      UCOLastServiceDate__c: '2020-09-18',
      Estimated_Pickup_Frequency__c: '3 Weeks',
      Services__r: services(['2024-07-16', 15], ['2024-07-01', 50]),
    },
    '2024-07-30',
  );
  assert.equal(res.lastServiceDate, '2024-07-16');
  assert.equal(res.lastDateSource, 'service_history');
  assert.equal(res.nextDueDate, '2024-08-06'); // 07-16 + 21d
  assert.equal(res.due, false);
});

/* ── evaluateAccount: due / not-due boundaries ────────────── */

test('due exactly when last service + frequency lands on the target date', () => {
  const acct = {
    Estimated_Pickup_Frequency__c: '3 Weeks',
    Services__r: services(['2026-06-19', 50]),
  };
  const onDue = evaluateAccount(acct, '2026-07-10'); // 06-19 + 21d = 07-10
  assert.equal(onDue.due, true);
  assert.equal(onDue.nextDueDate, '2026-07-10');
  const dayEarly = evaluateAccount(acct, '2026-07-09');
  assert.equal(dayEarly.due, false);
  assert.equal(dayEarly.reason, 'not_due_until_2026-07-10');
});

test('a "3 Weeks" account serviced a week ago is NOT due (old parser bug)', () => {
  const res = evaluateAccount(
    {
      Estimated_Pickup_Frequency__c: '3 Weeks',
      Services__r: services(['2026-07-03', 50]),
    },
    '2026-07-10',
  );
  assert.equal(res.due, false);
});

test('date-range window: due when nextDueDate falls within [dateFrom, dateTo]', () => {
  const acct = {
    Estimated_Pickup_Frequency__c: '2 Weeks',
    Services__r: services(['2026-06-25', 50]),
  }; // due 07-09
  assert.equal(evaluateAccount(acct, '2026-07-06', '2026-07-12').due, true);
  assert.equal(evaluateAccount(acct, '2026-07-06', '2026-07-08').due, false);
});

test('uses Service__c history for last service date', () => {
  const res = evaluateAccount(
    { Estimated_Pickup_Frequency__c: '2 Weeks', Services__r: services(['2026-06-20', 45], ['2026-06-01', 40]) },
    '2026-07-10',
  );
  assert.equal(res.lastServiceDate, '2026-06-20');
  assert.equal(res.lastDateSource, 'service_history');
  assert.equal(res.due, true); // 06-20 + 14d = 07-04 <= 07-10
});

test('field-only account with no history is not due', () => {
  const res = evaluateAccount(
    { UCOLastServiceDate__c: '2026-06-19', Estimated_Pickup_Frequency__c: '3 Weeks' },
    '2026-07-10',
  );
  assert.equal(res.due, false);
  assert.equal(res.reason, 'no_last_service_date');
  assert.equal(res.lastServiceDate, null);
});

test('estimates frequency from history when both frequency fields are empty', () => {
  const res = evaluateAccount(
    { UCOLastServiceDate__c: '2026-06-15', Services__r: services(['2026-06-15', 50], ['2026-05-25', 45], ['2026-05-04', 55]) },
    '2026-07-10',
  );
  assert.equal(res.frequencySource, 'estimated_from_history');
  assert.equal(res.frequencyDays, 21);
  assert.equal(res.frequencyLabel, '3 Weeks');
  assert.equal(res.due, true); // 06-15 + 21d = 07-06 <= 07-10
});

test('fill-rate can pull service earlier than the declared frequency', () => {
  // 100-gal tank filling ~5 gal/day => full in 20 days, despite "6 Weeks" picklist.
  const res = evaluateAccount(
    {
      UCOLastServiceDate__c: '2026-06-15',
      Estimated_Pickup_Frequency__c: '6 Weeks',
      Tank_Size__c: '100 Gallon',
      Services__r: services(['2026-06-15', 100], ['2026-05-26', 100], ['2026-05-06', 100]),
    },
    '2026-07-10',
  );
  assert.equal(res.frequencyDays, 42);
  assert.equal(res.daysToFull, 20);
  assert.equal(res.effectiveFrequencyDays, 20);
  assert.equal(res.due, true); // 06-15 + 20d = 07-05 <= 07-10
});

test('fill-rate never delays service beyond the declared frequency', () => {
  // Slow filler (0.5 gal/day into 700 gal => 1400 days) still due per "3 Weeks".
  const res = evaluateAccount(
    {
      UCOLastServiceDate__c: '2026-06-01',
      Estimated_Pickup_Frequency__c: '3 Weeks',
      Tank_Size__c: '700 Gallon',
      Services__r: services(['2026-06-01', 10], ['2026-05-12', 10]),
    },
    '2026-07-10',
  );
  assert.equal(res.effectiveFrequencyDays, 21);
  assert.equal(res.due, true);
});

/* ── evaluateAccount: exclusions ──────────────────────────── */

test('On-Call accounts are never auto-scheduled', () => {
  const res = evaluateAccount(
    { UCOLastServiceDate__c: '2020-01-01', Estimated_Pickup_Frequency__c: 'On-Call' },
    '2026-07-10',
  );
  assert.equal(res.due, false);
  assert.equal(res.reason, 'on_call_frequency');
});

test('no-data accounts are excluded with explicit reasons', () => {
  const noLast = evaluateAccount({ Estimated_Pickup_Frequency__c: '3 Weeks' }, '2026-07-10');
  assert.equal(noLast.due, false);
  assert.equal(noLast.reason, 'no_last_service_date');

  const noFreq = evaluateAccount(
    { UCOLastServiceDate__c: '2026-01-01', Services__r: services(['2026-01-01', 50]) },
    '2026-07-10',
  );
  assert.equal(noFreq.due, false);
  assert.equal(noFreq.reason, 'no_frequency');
});

/* ── gallons estimation ───────────────────────────────────── */

test('estimated gallons = fill rate x days since last service, capped at capacity', () => {
  const acct = {
    UCOLastServiceDate__c: '2026-06-20',
    Tank_Size__c: '100 Gallon',
    Services__r: services(['2026-06-20', 40], ['2026-05-31', 40]), // 2 gal/day
  };
  assert.equal(estimateGallonsAtDate(acct, '2026-07-10'), 40); // 20 days x 2
  assert.equal(estimateGallonsAtDate(acct, '2027-07-10'), 100); // capped at tank size
});

test('gallons estimation falls back to GPM accrual, last collection, then default', () => {
  const gpm = estimateGallonsAtDate(
    {
      Estimated_GPM__c: '30',
      Tank_Size__c: '100 Gallon',
      Services__r: services(['2026-06-10', null]),
    },
    '2026-07-10',
  );
  assert.equal(gpm, 30); // 1 month x 30 GPM
  const lastCollection = estimateGallonsAtDate(
    { Services__r: services(['2026-06-10', 55]) },
    '2026-07-10',
  );
  assert.equal(lastCollection, 55);
  assert.equal(estimateGallonsAtDate({}, '2026-07-10'), 40);
  assert.equal(estimateGallonsAtDate({}, '2026-07-10', { defaultGallons: 25 }), 25);
});

console.log('\nAll serviceDue tests passed.');
