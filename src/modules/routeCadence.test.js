/**
 * Unit tests for route cadence / next visit opportunity.
 * Run: node agent/src/modules/routeCadence.test.js
 */
const assert = require('assert');
const {
  DEFAULT_CADENCE_DAYS,
  runDate,
  parseIntervalDays,
  toRunHistory,
  resolveRouteCadenceDays,
  resolveAccountCadenceDays,
  resolveNextVisit,
} = require('./routeCadence');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

/** Completed runs of Coral Gables-Miami Airport Route, newest first. */
const CORAL_GABLES_RUNS = [
  '2026-08-03', '2026-07-16', '2026-07-02', '2026-06-19', '2026-06-10',
  '2026-05-27', '2026-05-14', '2026-04-29', '2026-04-16', '2026-04-03',
  '2026-03-17', '2026-03-04', '2026-02-17', '2026-02-04', '2026-01-22',
];

/** Builds run history rows; every run includes `accountIds` unless overridden. */
function runs(dates, accountIds = []) {
  return dates.map((d) => ({ runDate: d, accountIds }));
}

test('runDate prefers the serviced date over the planned date', () => {
  assert.equal(
    runDate({ Last_Route_Serviced_Date__c: '2026-08-03', Service_Date__c: '2026-08-01' }),
    '2026-08-03',
  );
  assert.equal(runDate({ Service_Date__c: '2026-08-01' }), '2026-08-01');
  assert.equal(runDate({ Last_Route_Serviced_Date__c: '2026-08-03T00:00:00Z' }), '2026-08-03');
  assert.equal(runDate({}), null);
});

test('toRunHistory drops undated runs and sorts newest first', () => {
  const history = toRunHistory(
    [
      { Service_Date__c: '2026-07-02', stops: ['001A'] },
      { Last_Route_Serviced_Date__c: '2026-08-03', stops: ['001A', '001B'] },
      { Name: 'never ran', stops: [] },
    ],
    (r) => r.stops || [],
  );
  assert.deepEqual(history.map((r) => r.runDate), ['2026-08-03', '2026-07-02']);
  assert.deepEqual(history[0].accountIds, ['001A', '001B']);
});

test('the real Coral Gables run series is biweekly, not weekly', () => {
  const cadence = resolveRouteCadenceDays(runs(CORAL_GABLES_RUNS));
  assert.equal(cadence.days, 13);
  assert.equal(cadence.sampleSize, CORAL_GABLES_RUNS.length - 1);
});

test('a weekly run series yields 7 days', () => {
  const weekly = ['2026-08-07', '2026-07-31', '2026-07-24', '2026-07-17', '2026-07-10'];
  assert.equal(resolveRouteCadenceDays(runs(weekly)).days, 7);
});

test('cadence is clamped so a long pause cannot stretch the horizon past 8 weeks', () => {
  const sparse = ['2026-08-01', '2026-02-01', '2025-08-01'];
  assert.equal(resolveRouteCadenceDays(runs(sparse)).days, 56);
});

test('a single completed run gives no cadence', () => {
  assert.equal(resolveRouteCadenceDays(runs(['2026-08-03'])), null);
  assert.equal(resolveRouteCadenceDays([]), null);
});

test('an account served on alternate runs gets double the route horizon', () => {
  const account = '001ALT0000000000';
  const history = CORAL_GABLES_RUNS.map((d, i) => ({
    runDate: d,
    accountIds: i % 2 === 0 ? [account] : ['001OTHER'],
  }));
  assert.equal(resolveRouteCadenceDays(history).days, 13);
  assert.equal(resolveAccountCadenceDays(account, history).days, 28);
});

test('account cadence matches 15- and 18-char Ids', () => {
  const full = '001ABCDEFGHIJKLMNO';
  const history = runs(CORAL_GABLES_RUNS, [full]);
  assert.equal(resolveAccountCadenceDays(full.slice(0, 15), history).days, 13);
});

test('an account on fewer than three runs falls back to route cadence', () => {
  const account = '001NEW0000000000';
  const history = CORAL_GABLES_RUNS.map((d, i) => ({
    runDate: d,
    accountIds: i < 2 ? [account] : [],
  }));
  assert.equal(resolveAccountCadenceDays(account, history), null);
  const visit = resolveNextVisit({ serviceDate: '2026-08-11', accountId: account, runs: history });
  assert.equal(visit.cadenceSource, 'route_history');
  assert.equal(visit.nextVisitDate, '2026-08-24');
});

test('Brightside on the Aug 11 route: next realistic visit is Aug 24', () => {
  const visit = resolveNextVisit({
    serviceDate: '2026-08-11',
    runs: runs(CORAL_GABLES_RUNS),
  });
  assert.equal(visit.cadenceDays, 13);
  assert.equal(visit.cadenceSource, 'route_history');
  // Every disputed stop (due Aug 13, 14 and 17) lands before this date.
  assert.equal(visit.nextVisitDate, '2026-08-24');
});

test('parseIntervalDays reads the Shape__c.Interval__c picklist', () => {
  assert.equal(parseIntervalDays('Weekly'), 7);
  assert.equal(parseIntervalDays('2 Weeks'), 14);
  assert.equal(parseIntervalDays('16 Weeks'), 112);
  assert.equal(parseIntervalDays('On-Call'), null);
  assert.equal(parseIntervalDays(null), null);
});

test('a route with no completed runs falls back to the shape interval', () => {
  const visit = resolveNextVisit({
    serviceDate: '2026-08-11',
    runs: [],
    shapeInterval: '3 Weeks',
  });
  assert.equal(visit.cadenceDays, 21);
  assert.equal(visit.cadenceSource, 'shape_interval');
  assert.equal(visit.nextVisitDate, '2026-09-01');
  assert.equal(visit.sampleSize, null);
});

test('with neither history nor a shape interval the horizon defaults to 14 days', () => {
  const visit = resolveNextVisit({ serviceDate: '2026-08-11' });
  assert.equal(visit.cadenceDays, DEFAULT_CADENCE_DAYS);
  assert.equal(visit.cadenceSource, 'default');
  assert.equal(visit.nextVisitDate, '2026-08-25');
});

test('run history wins over a shape interval that disagrees', () => {
  const visit = resolveNextVisit({
    serviceDate: '2026-08-11',
    runs: runs(CORAL_GABLES_RUNS),
    shapeInterval: 'Weekly',
  });
  assert.equal(visit.cadenceSource, 'route_history');
  assert.equal(visit.cadenceDays, 13);
});

console.log('\nAll routeCadence tests passed.');
