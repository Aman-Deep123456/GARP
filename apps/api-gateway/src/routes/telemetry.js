/**
 * POST /v1/telemetry — accepts telemetry pings from workers.
 * Validates payload, publishes to Kafka worker-telemetry topic.
 */
const express = require('express');
const { telemetrySchema, validate } = require('../middleware/validation');
const { optionalAuth } = require('../middleware/auth');
const { sendMessage } = require('../services/kafka-producer');
const { getMetrics } = require('../metrics');

const router = express.Router();

router.post('/', optionalAuth, validate(telemetrySchema), async (req, res) => {
  try {
    const telemetry = req.body;
    const workerId = telemetry.worker_id;

    // Publish to Kafka (exactly-once via idempotent producer)
    await sendMessage('worker-telemetry', workerId, {
      ...telemetry,
      received_at: new Date().toISOString(),
      source: 'api-gateway',
    });

    // Increment telemetry counter
    const metrics = getMetrics();
    if (metrics) metrics.telemetryReceived.inc();

    res.status(200).json({
      status: 'accepted',
      worker_id: workerId,
      timestamp: telemetry.timestamp,
    });
  } catch (err) {
    console.error('Telemetry ingestion error:', err);
    res.status(500).json({ error: 'Failed to process telemetry' });
  }
});

module.exports = router;
