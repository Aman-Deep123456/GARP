/**
 * /v1/claims — Claims endpoints.
 */
const express = require('express');
const { Claim } = require('../models');

const router = express.Router();

// GET /v1/claims/:workerId — list claims for a worker
router.get('/:workerId', async (req, res) => {
  try {
    const claims = await Claim.find({ worker_id: req.params.workerId })
      .sort({ created_at: -1 })
      .limit(50);
    res.json({ claims, total: claims.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
});

// GET /v1/claims/:workerId/:claimId — get specific claim
router.get('/:workerId/:claimId', async (req, res) => {
  try {
    const claim = await Claim.findOne({
      worker_id: req.params.workerId,
      claim_id: req.params.claimId,
    });
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    res.json(claim);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch claim' });
  }
});

// GET /v1/claims — admin: all claims with filtering
router.get('/', async (req, res) => {
  try {
    const { state, ward_id, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (state) filter.state = state;
    if (ward_id) filter.ward_id = ward_id;
    const claims = await Claim.find(filter)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ created_at: -1 });
    const total = await Claim.countDocuments(filter);
    res.json({ claims, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
});

module.exports = router;
