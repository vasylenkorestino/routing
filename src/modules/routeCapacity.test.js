/**
 * Unit tests for capacity-aware trimming of enhance stop recommendations.
 * Run: node agent/src/modules/routeCapacity.test.js
 */
const assert = require('assert');
const { selectWithinCapacity, rankOf, isProtected } = require('./routeCapacity');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

/** Builds a facts index entry for one account. */
function facts(accountId, overrides = {}) {
  return {
    [accountId]: {
      reasonFacts: {
        hasUcoHistory: true,
        lastUcoDate: '2026-08-03',
        lastUcoGallons: 60,
        nextDueDate: '2026-08-17',
        nextVisitDate: '2026-08-24',
        daysUntilDue: 6,
        daysOverdue: 0,
        due: false,
        dueTier: 'due_before_next_visit',
        dueBeforeNextVisit: true,
        estimatedGallonsAtDate: 100,
        ...overrides,
      },
    },
  };
}

/** Merges several single-account facts indexes. */
function factsIndex(...entries) {
  return Object.assign({}, ...entries);
}

/** A keep recommendation for an account. */
function keep(accountId) {
  return { accountId, action: 'keep', confidence: 80, reason: 'Keep — due.' };
}

test('rankOf orders protected, overdue, due today, due before next visit', () => {
  assert.equal(rankOf({ mustRemainOnRoute: true, dueTier: 'not_due' }), 0);
  assert.equal(rankOf({ dueTier: 'overdue' }), 1);
  assert.equal(rankOf({ dueTier: 'due_today' }), 2);
  assert.equal(rankOf({ dueTier: 'due_before_next_visit' }), 3);
  assert.equal(rankOf({ dueTier: 'not_due' }), 4);
  assert.equal(isProtected({ managerKeepSignal: true }), true);
  assert.equal(isProtected({ dueTier: 'overdue' }), false);
});

test('everything rides along when the load fits', () => {
  const index = factsIndex(facts('001A'), facts('001B'));
  const { stops, stats } = selectWithinCapacity(
    [keep('001A'), keep('001B')],
    index,
    { capacityGal: 1800 },
  );
  assert.deepEqual(stops.map((s) => s.action), ['keep', 'keep']);
  assert.equal(stats.deferred, 0);
  assert.equal(stats.keptGal, 200);
});

test('the least urgent due-soon stop is deferred when the truck is full', () => {
  const index = factsIndex(
    facts('001SOON', { daysUntilDue: 1, estimatedGallonsAtDate: 100 }),
    facts('001LATER', { daysUntilDue: 9, estimatedGallonsAtDate: 100 }),
  );
  const { stops, stats } = selectWithinCapacity(
    [keep('001SOON'), keep('001LATER')],
    index,
    { capacityGal: 150 },
  );
  assert.equal(stops[0].action, 'keep');
  assert.equal(stops[1].action, 'remove');
  assert.equal(stops[1]._capacityDeferred, true);
  assert.equal(stats.deferred, 1);
});

test('a deferred stop says capacity, never "not due yet"', () => {
  const index = facts('001DEF', { daysUntilDue: 6, estimatedGallonsAtDate: 500 });
  const { stops } = selectWithinCapacity([keep('001DEF')], index, { capacityGal: 100 });
  assert.equal(
    stops[0].reason,
    "Last UCO: Aug 3, 2026 (60 gal). Due Aug 17, 2026 — before this route's next run "
    + '(~Aug 24, 2026). Remove — deferred for truck capacity.',
  );
  assert.doesNotMatch(stops[0].reason, /not due yet/i);
  assert.ok(stops[0].confidence >= 85);
});

test('overdue and protected stops are never trimmed, even over capacity', () => {
  const index = factsIndex(
    facts('001OVERDUE', { dueTier: 'overdue', due: true, daysOverdue: 20, daysUntilDue: -20, estimatedGallonsAtDate: 900 }),
    facts('001VIP', { dueTier: 'not_due', dueBeforeNextVisit: false, isVip: true, estimatedGallonsAtDate: 900 }),
    facts('001NEW', { dueTier: 'not_due', dueBeforeNextVisit: false, mustRemainOnRoute: true, estimatedGallonsAtDate: 900 }),
    facts('001SOON', { estimatedGallonsAtDate: 900 }),
  );
  const { stops, stats } = selectWithinCapacity(
    [keep('001OVERDUE'), keep('001VIP'), keep('001NEW'), keep('001SOON')],
    index,
    { capacityGal: 1000 },
  );
  const byId = Object.fromEntries(stops.map((s) => [s.accountId, s.action]));
  assert.equal(byId['001OVERDUE'], 'keep');
  assert.equal(byId['001VIP'], 'keep');
  assert.equal(byId['001NEW'], 'keep');
  assert.equal(byId['001SOON'], 'remove');
  assert.equal(stats.deferred, 1);
  assert.equal(stats.overCapacity, true);
});

test('a manager keep signal protects a due-soon stop from the capacity cut', () => {
  const index = factsIndex(
    facts('001MGR', { managerKeepSignal: true, estimatedGallonsAtDate: 900 }),
    facts('001PLAIN', { estimatedGallonsAtDate: 900 }),
  );
  const { stops } = selectWithinCapacity(
    [keep('001MGR'), keep('001PLAIN')],
    index,
    { capacityGal: 1000 },
  );
  assert.equal(stops[0].action, 'keep');
  assert.equal(stops[1].action, 'remove');
});

test('already-removed stops free capacity and are left untouched', () => {
  const index = factsIndex(
    facts('001GONE', { dueTier: 'not_due', dueBeforeNextVisit: false, estimatedGallonsAtDate: 900 }),
    facts('001SOON', { estimatedGallonsAtDate: 900 }),
  );
  const { stops, stats } = selectWithinCapacity(
    [{ accountId: '001GONE', action: 'remove', reason: 'Remove — not due yet.' }, keep('001SOON')],
    index,
    { capacityGal: 1000 },
  );
  assert.equal(stops[0].reason, 'Remove — not due yet.');
  assert.equal(stops[0]._capacityDeferred, undefined);
  assert.equal(stops[1].action, 'keep');
  assert.equal(stats.keptGal, 900);
});

test('maxStops trims the same way as gallons', () => {
  const index = factsIndex(
    facts('001SOON', { daysUntilDue: 1, estimatedGallonsAtDate: 10 }),
    facts('001LATER', { daysUntilDue: 9, estimatedGallonsAtDate: 10 }),
  );
  const { stops } = selectWithinCapacity(
    [keep('001SOON'), keep('001LATER')],
    index,
    { capacityGal: 1800, maxStops: 1 },
  );
  assert.equal(stops[0].action, 'keep');
  assert.equal(stops[1].action, 'remove');
});

test('stops with no facts are treated as the lowest priority, not crashed on', () => {
  const { stops } = selectWithinCapacity([keep('001UNKNOWN')], {}, { capacityGal: 1800 });
  assert.equal(stops[0].action, 'keep');
});

console.log('\nAll routeCapacity tests passed.');
