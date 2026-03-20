/**
 * Prometheus metrics for GRAP API Gateway.
 * Exposes claims_initiated_total, claims_settled_total, claims_rejected_total, payout_inr_total.
 */
const client = require('prom-client');

let metricsRegistry;

function setupMetrics() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  // ── Custom counters ─────────────────────────────────
  const claimsInitiated = new client.Counter({
    name: 'claims_initiated_total',
    help: 'Total number of claims initiated',
    registers: [register],
  });

  const claimsSettled = new client.Counter({
    name: 'claims_settled_total',
    help: 'Total number of claims settled',
    registers: [register],
  });

  const claimsRejected = new client.Counter({
    name: 'claims_rejected_total',
    help: 'Total number of claims rejected',
    registers: [register],
  });

  const payoutTotal = new client.Counter({
    name: 'payout_inr_total',
    help: 'Total payout amount in INR',
    registers: [register],
  });

  const telemetryReceived = new client.Counter({
    name: 'telemetry_received_total',
    help: 'Total telemetry pings received',
    registers: [register],
  });

  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [register],
  });

  metricsRegistry = {
    register,
    claimsInitiated,
    claimsSettled,
    claimsRejected,
    payoutTotal,
    telemetryReceived,
    httpRequestDuration,
    contentType: register.contentType,
    getMetrics: () => register.metrics(),
  };

  return metricsRegistry;
}

function getMetrics() {
  return metricsRegistry;
}

module.exports = { setupMetrics, getMetrics };
