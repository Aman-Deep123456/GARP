/**
 * Mongoose models for GRAP Platform.
 */
const mongoose = require('mongoose');

// ── Worker Model ─────────────────────────────────────
const workerSchema = new mongoose.Schema({
  worker_id: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String },
  platform: { type: String, enum: ['zomato', 'swiggy', 'both'], default: 'zomato' },
  ward_id: { type: String, required: true, index: true },
  city: { type: String, default: 'Mumbai' },
  vehicle_type: { type: String, enum: ['bicycle', 'motorcycle', 'scooter'], default: 'motorcycle' },
  tenure_weeks: { type: Number, default: 0 },
  avg_deliv_dist_km: { type: Number, default: 3.5 },
  peak_hour_share: { type: Number, default: 0.4 },
  productivity_score: { type: Number, default: 0.7 },
  hist_disrupt_days_52wk: { type: Number, default: 0 },
  policy: {
    active: { type: Boolean, default: false },
    weekly_premium: { type: Number, default: 28 },
    sum_insured: { type: Number, default: 2500 },
    start_date: { type: Date },
    end_date: { type: Date },
  },
  telemetry_paused: { type: Boolean, default: false },
  erasure_requested: { type: Boolean, default: false },
  erasure_requested_at: { type: Date },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// ── Claim Model ──────────────────────────────────────
const claimSchema = new mongoose.Schema({
  claim_id: { type: String, required: true, unique: true, index: true },
  worker_id: { type: String, required: true, index: true },
  ward_id: { type: String, required: true },
  state: {
    type: String,
    enum: ['ACTIVE', 'INITIATED', 'VALIDATING', 'READY_PAY', 'PROCESSING', 'RETRY', 'SETTLED', 'REJECTED', 'FAILED'],
    default: 'ACTIVE',
    index: true,
  },
  risk_score: { type: Number },
  initiated_at: { type: Date },
  gate_start: { type: Date },
  fraud_verdict: { type: String, enum: ['PASS', 'FAIL', null], default: null },
  fraud_score: { type: Number },
  payout_amount: { type: Number },
  payout_currency: { type: String, default: 'INR' },
  hours_disrupted: { type: Number },
  weekly_si: { type: Number },
  dst: { type: Number }, // P90 14-day active hours
  retry_count: { type: Number, default: 0 },
  max_retries: { type: Number, default: 3 },
  idempotency_key: { type: String },
  razorpay_payment_id: { type: String },
  settled_at: { type: Date },
  rejected_at: { type: Date },
  failed_at: { type: Date },
  transitions: [{
    from: String,
    to: String,
    timestamp: { type: Date, default: Date.now },
    reason: String,
  }],
  triggers: {
    rain_normalized: Number,
    flood_normalized: Number,
    aqi_normalized: Number,
    traffic_normalized: Number,
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// ── Telemetry Model (short-lived, DPDPA: GPS deleted after claim+7 days) ──
const telemetrySchema = new mongoose.Schema({
  worker_id: { type: String, required: true, index: true },
  timestamp: { type: Date, required: true },
  s2_cell_id: { type: String },
  ward_id: { type: String },
  location: {
    latitude: Number,
    longitude: Number,
    accuracy: Number,
    speed: Number,
  },
  activity: {
    type_label: String,
    confidence: Number,
  },
  risk_score: { type: Number },
  expires_at: { type: Date, index: { expireAfterSeconds: 0 } }, // TTL index
  created_at: { type: Date, default: Date.now },
});

const Worker = mongoose.model('Worker', workerSchema);
const Claim = mongoose.model('Claim', claimSchema);
const Telemetry = mongoose.model('Telemetry', telemetrySchema);

module.exports = { Worker, Claim, Telemetry };
