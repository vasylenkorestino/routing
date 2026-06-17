const router = require('express').Router();
const aiJobs = require('../services/aiJobs');

/** GET /api/ai-jobs/:id — full job snapshot (steps, findings, partial results). */
router.get('/:id', (req, res) => {
  const owner = aiJobs.resolveOwner(req);
  const job = aiJobs.getForOwner(req.params.id, owner);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(aiJobs.toView(job));
});

module.exports = router;
