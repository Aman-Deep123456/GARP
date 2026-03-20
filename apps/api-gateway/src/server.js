/**
 * GRAP Platform — API Gateway
 * Express server with JWT auth, Kafka producer, WebSocket, Prometheus metrics.
 */
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { setupMetrics } = require('./metrics');
const { createKafkaProducer } = require('./services/kafka-producer');
const { setupWebSocket } = require('./services/websocket');
const telemetryRouter = require('./routes/telemetry');
const workersRouter = require('./routes/workers');
const claimsRouter = require('./routes/claims');
const authRouter = require('./routes/auth');

const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/grap';

const app = express();
const server = http.createServer(app);

// ── Middleware ────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('short'));

// ── Prometheus Metrics ───────────────────────────────
const metrics = setupMetrics();
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', metrics.contentType);
  res.end(await metrics.getMetrics());
});

// ── Health Check ─────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'api-gateway', timestamp: new Date().toISOString() });
});

// ── Routes ───────────────────────────────────────────
app.use('/v1/auth', authRouter);
app.use('/v1/telemetry', telemetryRouter);
app.use('/v1/workers', workersRouter);
app.use('/v1/claims', claimsRouter);

// ── API docs (simple listing) ────────────────────────
app.get('/v1', (_req, res) => {
  res.json({
    service: 'GRAP API Gateway',
    version: '1.0.0',
    endpoints: [
      'POST /v1/auth/login',
      'POST /v1/auth/register',
      'POST /v1/telemetry',
      'GET  /v1/workers/:id',
      'GET  /v1/workers/:id/policy',
      'GET  /v1/claims/:workerId',
      'GET  /v1/claims/:workerId/:claimId',
      'GET  /metrics',
      'GET  /health',
    ],
  });
});

// ── Error handler ────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Bootstrap ────────────────────────────────────────
async function start() {
  try {
    // Connect MongoDB
    await mongoose.connect(MONGO_URI);
    console.log('✅ MongoDB connected');

    // Initialize Kafka producer
    await createKafkaProducer();
    console.log('✅ Kafka producer ready (idempotent)');

    // Setup WebSocket
    setupWebSocket(server);
    console.log('✅ WebSocket server ready');

    server.listen(PORT, () => {
      console.log(`🚀 API Gateway listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start API Gateway:', err);
    process.exit(1);
  }
}

start();
