const router = require('express').Router();
const proposals = require('../services/routeEditProposals');
const { applyProposal } = require('../services/routeEditApplier');
const aiJobs = require('../services/aiJobs');
const { logAction } = require('../services/actionLogger');
const logger = require('../utils/logger');

/** GET /api/route-edit/proposals/:id — fetch a pending proposal for the approval UI. */
router.get('/proposals/:id', (req, res) => {
  const owner = aiJobs.resolveOwner(req);
  const proposal = proposals.getForOwner(req.params.id, owner) || proposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  res.json(proposals.toView(proposal));
});

/** POST /api/route-edit/proposals/:id/approve — apply a manager-approved edit proposal. */
router.post('/proposals/:id/approve', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const owner = aiJobs.resolveOwner(req);
    const proposal = proposals.getForOwner(req.params.id, owner) || proposals.get(req.params.id);
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `Proposal already ${proposal.status}` });
    }

    const approvedBy = req.driver?.name || req.driver?.email || 'Manager';
    const result = await applyProposal(proposal, { approvedBy });
    proposals.markApproved(proposal.id, approvedBy);

    logAction({
      action: 'Approve Route Edit Proposal',
      status: 'Success',
      requestBody: { proposalId: proposal.id },
      responseBody: result,
      durationMs: Date.now() - t0,
      userInfo: approvedBy,
      googleRouteId: proposal.googleRouteId,
      source: 'POST /route-edit/proposals/approve',
    });

    res.json({ success: true, proposalId: proposal.id, ...result });
  } catch (err) {
    logger.error('[route-edit] approve failed', { error: err.message });
    next(err);
  }
});

/** POST /api/route-edit/proposals/:id/decline — reject a pending edit proposal. */
router.post('/proposals/:id/decline', (req, res) => {
  const owner = aiJobs.resolveOwner(req);
  const proposal = proposals.getForOwner(req.params.id, owner) || proposals.get(req.params.id);
  if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
  if (proposal.status !== 'pending') {
    return res.status(409).json({ error: `Proposal already ${proposal.status}` });
  }

  const declinedBy = req.driver?.name || req.driver?.email || 'Manager';
  proposals.markDeclined(proposal.id, declinedBy);
  res.json({ success: true, proposalId: proposal.id, status: 'declined' });
});

module.exports = router;
