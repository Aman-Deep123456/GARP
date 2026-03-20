/**
 * /v1/auth — Authentication endpoints.
 */
const express = require('express');
const { Worker } = require('../models');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

// POST /v1/auth/register — register a new worker
router.post('/register', async (req, res) => {
  try {
    const { worker_id, name, phone, email, platform, ward_id, vehicle_type } = req.body;

    if (!worker_id || !name || !phone || !ward_id) {
      return res.status(400).json({ error: 'worker_id, name, phone, and ward_id are required' });
    }

    const existing = await Worker.findOne({ worker_id });
    if (existing) {
      return res.status(409).json({ error: 'Worker already registered' });
    }

    const worker = new Worker({
      worker_id,
      name,
      phone,
      email,
      platform: platform || 'zomato',
      ward_id,
      vehicle_type: vehicle_type || 'motorcycle',
      policy: {
        active: true,
        weekly_premium: 28,
        sum_insured: 2500,
        start_date: new Date(),
        end_date: new Date(Date.now() + 52 * 7 * 24 * 3600 * 1000), // 1 year
      },
    });

    await worker.save();

    const token = generateToken({
      workerId: worker_id,
      role: 'worker',
      wardId: ward_id,
    });

    res.status(201).json({ worker, token });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /v1/auth/login
router.post('/login', async (req, res) => {
  try {
    const { worker_id, phone } = req.body;

    if (!worker_id || !phone) {
      return res.status(400).json({ error: 'worker_id and phone are required' });
    }

    const worker = await Worker.findOne({ worker_id, phone });
    if (!worker) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken({
      workerId: worker.worker_id,
      role: 'worker',
      wardId: worker.ward_id,
    });

    res.json({ worker, token });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /v1/auth/admin/login (simple admin login for demo)
router.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'grap2026') {
    const token = generateToken({ role: 'admin', username });
    return res.json({ token, role: 'admin' });
  }
  res.status(401).json({ error: 'Invalid admin credentials' });
});

// GET /v1/auth/me — get current user info
router.get('/me', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ role: 'admin', username: req.user.username });
    }
    const worker = await Worker.findOne({ worker_id: req.user.workerId });
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    res.json(worker);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user info' });
  }
});

module.exports = router;
