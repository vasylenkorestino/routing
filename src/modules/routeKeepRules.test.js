/**
 * Unit tests for new-account / CDL remain-on-route rules.
 * Run: node agent/src/modules/routeKeepRules.test.js
 */
const assert = require('assert');
const {
  evaluateMustRemainOnRoute,
  applyMustRemainKeepOverride,
  remainReasonLabel,
  CDL_REMAIN_AFTER_DAYS,
} = require('./routeKeepRules');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

/** Builds Services__r with Code__c + optional RecordType.Name. */
function services(...rows) {
  return {
    records: rows.map(([date, gallons, recordType = 'UCO Collection']) => ({
      Service_Date__c: date,
      Qty_Gallons__c: gallons,
      Code__c: recordType === 'Deliver Container' ? 'CDL' : 'UCO',
      RecordType: { Name: recordType },
    })),
  };
}

test('CDL older than 14 days with no UCO → must remain', () => {
  const res = evaluateMustRemainOnRoute(
    { Services__r: services(['2026-07-01', null, 'Deliver Container']) },
    '2026-07-20',
  );
  assert.equal(res.mustRemainOnRoute, true);
  assert.equal(res.ucoServiceCount, 0);
  assert.equal(res.cdlDeliveryDate, '2026-07-01');
  assert.ok(res.cdlAgeDays > CDL_REMAIN_AFTER_DAYS);
  assert.match(res.remainReason, /cdl_delivery_older_than_/);
});

test('CDL younger than 14 days with no UCO → do not force remain', () => {
  const res = evaluateMustRemainOnRoute(
    { Services__r: services(['2026-07-15', null, 'Deliver Container']) },
    '2026-07-20',
  );
  assert.equal(res.mustRemainOnRoute, false);
  assert.equal(res.ucoServiceCount, 0);
});

test('1–2 UCO services → must remain (first three services)', () => {
  const one = evaluateMustRemainOnRoute(
    { Services__r: services(['2026-07-10', 40, 'UCO Collection']) },
    '2026-07-20',
  );
  assert.equal(one.mustRemainOnRoute, true);
  assert.equal(one.ucoServiceCount, 1);

  const two = evaluateMustRemainOnRoute(
    {
      Services__r: services(
        ['2026-07-10', 40, 'UCO Collection'],
        ['2026-06-20', 35, 'UCO Collection'],
        ['2026-05-01', null, 'Deliver Container'],
      ),
    },
    '2026-07-20',
  );
  assert.equal(two.mustRemainOnRoute, true);
  assert.equal(two.ucoServiceCount, 2);
  assert.match(two.remainReason, /new_account_fewer_than_/);
});

test('3+ UCO services with old CDL → normal due logic (not forced remain)', () => {
  const res = evaluateMustRemainOnRoute(
    {
      Services__r: services(
        ['2026-07-10', 40],
        ['2026-06-20', 35],
        ['2026-05-30', 50],
        ['2026-01-01', null, 'Deliver Container'],
      ),
    },
    '2026-07-20',
  );
  assert.equal(res.mustRemainOnRoute, false);
  assert.equal(res.ucoServiceCount, 3);
});

test('CDL is excluded from UCO service count', () => {
  const res = evaluateMustRemainOnRoute(
    {
      Services__r: services(
        ['2026-07-10', 40, 'UCO Collection'],
        ['2026-06-01', null, 'Deliver Container'],
      ),
    },
    '2026-07-20',
  );
  assert.equal(res.ucoServiceCount, 1);
  assert.equal(res.mustRemainOnRoute, true);
});

test('Code__c CDL alone (no RecordType) forces remain when older than 14 days', () => {
  const res = evaluateMustRemainOnRoute(
    {
      Services__r: {
        records: [{ Service_Date__c: '2026-07-01', Qty_Gallons__c: null, Code__c: 'CDL' }],
      },
    },
    '2026-07-20',
  );
  assert.equal(res.mustRemainOnRoute, true);
  assert.equal(res.ucoServiceCount, 0);
  assert.equal(res.cdlDeliveryDate, '2026-07-01');
});

test('applyMustRemainKeepOverride forces remove/flag → keep', () => {
  const remainByAccountId = {
    '001NEW': {
      mustRemainOnRoute: true,
      remainReason: 'new_account_fewer_than_3_uco_services',
    },
  };
  const out = applyMustRemainKeepOverride(
    [
      { accountId: '001NEW', action: 'remove', confidence: 40, reason: 'low fill' },
      { accountId: '001OLD', action: 'remove', confidence: 80, reason: 'skip' },
      { accountId: '001KEEP', action: 'keep', confidence: 90, reason: 'ok' },
    ],
    remainByAccountId,
  );
  assert.equal(out[0].action, 'keep');
  assert.equal(out[0]._remainOverride, true);
  assert.equal(out[0].reason, remainReasonLabel('new_account_fewer_than_3_uco_services'));
  assert.equal(out[1].action, 'remove');
  assert.equal(out[2].action, 'keep');
  assert.equal(out[2]._remainOverride, undefined);
});

console.log('\nAll routeKeepRules tests passed.');
