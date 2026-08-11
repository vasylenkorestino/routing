/**
 * Capacity-aware trimming for AI Enhance stop recommendations (pure).
 *
 * Once "due before the route returns" counts as due, a busy route can hold more
 * gallons than the truck. The cut is made by urgency rather than by the old
 * binary not-due test, and the stops that lose out are told the truth — they
 * were deferred for capacity, not because they were not due.
 *
 * Rank order (protected stops are never trimmed):
 *   0 must-remain / fixed / VIP / manager override
 *   1 overdue            — most overdue first
 *   2 due today          — biggest tank first
 *   3 due before the route's next visit — soonest due, then biggest tank
 *   4 anything else still marked keep
 *
 * Only tiers 3 and 4 are trimmable: an overdue stop cannot be deferred to a run
 * that happens after it is already late.
 */

const {
  CAPACITY_DEFERRED_WHY,
  formatManagerReason,
  lookupStopFacts,
} = require('./enhanceStopFacts');

/** Actions that put a stop on the truck and therefore consume capacity. */
const ON_ROUTE_ACTIONS = new Set(['keep', 'overflow']);

/** Lowest rank that may be dropped when the truck is full. */
const FIRST_TRIMMABLE_RANK = 3;

const RANK_BY_TIER = {
  overdue: 1,
  due_today: 2,
  due_before_next_visit: 3,
};

/** True when no capacity rule may drop this stop. */
function isProtected(facts) {
  return !!(facts
    && (facts.mustRemainOnRoute || facts.isFixed || facts.isVip || facts.managerKeepSignal));
}

/** Urgency rank — lower is kept first. */
function rankOf(facts) {
  if (isProtected(facts)) return 0;
  return RANK_BY_TIER[facts?.dueTier] ?? 4;
}

/** Projected gallons this stop will put on the truck. */
function gallonsOf(facts) {
  const projected = Number(facts?.estimatedGallonsAtDate);
  if (Number.isFinite(projected) && projected > 0) return projected;
  const last = Number(facts?.lastUcoGallons);
  return Number.isFinite(last) && last > 0 ? last : 0;
}

/** Sorts kept stops by urgency, then by the tie-breaker for their tier. */
function compareStops(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.rank === 1) {
    const overdue = (Number(b.facts?.daysOverdue) || 0) - (Number(a.facts?.daysOverdue) || 0);
    if (overdue) return overdue;
  }
  if (a.rank >= FIRST_TRIMMABLE_RANK) {
    const soonest = (Number(a.facts?.daysUntilDue) || 0) - (Number(b.facts?.daysUntilDue) || 0);
    if (soonest) return soonest;
  }
  return b.gallons - a.gallons;
}

/**
 * Flips a recommendation to REMOVE with a capacity reason.
 */
function deferStop(rec, facts) {
  return {
    ...rec,
    action: 'remove',
    confidence: Math.max(Number(rec.confidence) || 0, 85),
    reason: formatManagerReason(facts, 'remove', CAPACITY_DEFERRED_WHY),
    _capacityDeferred: true,
  };
}

/**
 * Trims kept stops down to the truck's capacity, weakest urgency first.
 *
 * @param {object[]} recs - stop recommendations (post AI + history overrides)
 * @param {object} factsByAccountId - index from indexStopFactsByAccountId
 * @param {{ capacityGal: number, maxStops?: number|null }} opts
 * @returns {{ stops: object[], stats: { keptGal: number, keptStops: number,
 *   deferred: number, overCapacity: boolean } }}
 */
function selectWithinCapacity(recs = [], factsByAccountId = {}, { capacityGal, maxStops = null } = {}) {
  const onRoute = [];
  for (const rec of recs) {
    if (!ON_ROUTE_ACTIONS.has(String(rec.action || '').toLowerCase())) continue;
    const facts = lookupStopFacts(factsByAccountId, rec.accountId)?.reasonFacts || null;
    onRoute.push({ rec, facts, rank: rankOf(facts), gallons: gallonsOf(facts) });
  }
  onRoute.sort(compareStops);

  const deferred = new Map();
  let keptGal = 0;
  let keptStops = 0;

  for (const entry of onRoute) {
    const overGallons = Number.isFinite(capacityGal) && keptGal + entry.gallons > capacityGal;
    const overStops = Number.isFinite(maxStops) && keptStops + 1 > maxStops;
    // Protected and overdue stops ride along even when that busts the limit —
    // the dispatcher needs to see them, not have them silently dropped.
    if (entry.rank >= FIRST_TRIMMABLE_RANK && (overGallons || overStops)) {
      deferred.set(entry.rec, entry.facts);
      continue;
    }
    keptGal += entry.gallons;
    keptStops += 1;
  }

  const stops = recs.map((rec) => (
    deferred.has(rec) ? deferStop(rec, deferred.get(rec)) : rec
  ));

  return {
    stops,
    stats: {
      keptGal: Math.round(keptGal),
      keptStops,
      deferred: deferred.size,
      overCapacity: Number.isFinite(capacityGal) && keptGal > capacityGal,
    },
  };
}

module.exports = {
  ON_ROUTE_ACTIONS,
  FIRST_TRIMMABLE_RANK,
  isProtected,
  rankOf,
  gallonsOf,
  selectWithinCapacity,
};
