/**
 * /v1/workers — Worker CRUD endpoints.
 */
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { Worker } = require('../models');

const router = express.Router();

// GET /v1/workers/:id
router.get('/:id', async (req, res) => {
  try {
    const worker = await Worker.findOne({ worker_id: req.params.id });
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    res.json(worker);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch worker' });
  }
});

// GET /v1/workers/:id/policy
router.get('/:id/policy', async (req, res) => {
  try {
    const worker = await Worker.findOne({ worker_id: req.params.id }, 'worker_id name policy ward_id');
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    res.json({
      worker_id: worker.worker_id,
      name: worker.name,
      ward_id: worker.ward_id,
      ...worker.policy.toObject(),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch policy' });
  }
});

// GET /v1/workers — list all workers (admin)
router.get('/', async (req, res) => {
  try {
    const { ward_id, page = 1, limit = 50 } = req.query;
    const filter = ward_id ? { ward_id } : {};
    const workers = await Worker.find(filter)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .sort({ created_at: -1 });
    const total = await Worker.countDocuments(filter);
    res.json({ workers, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch workers' });
  }
});

// PUT /v1/workers/:id/settings — update worker settings
router.put('/:id/settings', async (req, res) => {
  try {
    const { telemetry_paused, erasure_requested } = req.body;
    const update = { updated_at: new Date() };
    if (telemetry_paused !== undefined) update.telemetry_paused = telemetry_paused;
    if (erasure_requested) {
      update.erasure_requested = true;
      update.erasure_requested_at = new Date();
    }
    const worker = await Worker.findOneAndUpdate(
      { worker_id: req.params.id },
      update,
      { new: true }
    );
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    res.json(worker);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
