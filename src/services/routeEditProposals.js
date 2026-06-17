/**
 * In-memory store for pending AI route edit proposals awaiting manager approval.
 */
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

const TTL_MS = 24 * 60 * 60 * 1000;
const proposals = new Map();

/** Creates a pending edit proposal and returns its public view. */
function create({ googleRouteId, routeName, summary, reason, changes, raw, owner }) {
  const id = randomUUID();
  const now = Date.now();
  const proposal = {
    id,
    status: 'pending',
    googleRouteId,
    routeName,
    summary: summary || 'Proposed route changes',
    reason: reason || '',
    changes,
    raw,
    owner: owner || 'api',
    createdAt: now,
    updatedAt: now,
  };
  proposals.set(id, proposal);
  return toView(proposal);
}

function get(id) {
  return proposals.get(id) || null;
}

function getForOwner(id, owner) {
  const p = proposals.get(id);
  if (!p) return null;
  if (owner && p.owner !== owner && p.owner !== 'api' && owner !== 'api') return null;
  return p;
}

function markApproved(id, approvedBy) {
  const p = proposals.get(id);
  if (!p) return null;
  p.status = 'approved';
  p.approvedBy = approvedBy;
  p.updatedAt = Date.now();
  return p;
}

function markDeclined(id, declinedBy) {
  const p = proposals.get(id);
  if (!p) return null;
  p.status = 'declined';
  p.declinedBy = declinedBy;
  p.updatedAt = Date.now();
  return p;
}

function toView(proposal) {
  if (!proposal) return null;
  return {
    id: proposal.id,
    status: proposal.status,
    googleRouteId: proposal.googleRouteId,
    routeName: proposal.routeName,
    summary: proposal.summary,
    reason: proposal.reason,
    changes: proposal.changes,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  let removed = 0;
  for (const [id, p] of proposals) {
    if (p.status !== 'pending' && p.updatedAt < cutoff) {
      proposals.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) logger.info('[routeEditProposals] cleaned up expired proposals', { removed });
}, 60 * 60 * 1000).unref?.();

module.exports = {
  create,
  get,
  getForOwner,
  markApproved,
  markDeclined,
  toView,
};
