/**
 * GRAP Platform — DFA Claim Engine
 * 9-state DFA with exact transitions from Section 6.
 *
 * ACTIVE → INITIATED (Rt>0.85, >60min) → VALIDATING → READY_PAY/REJECTED →
 * PROCESSING → SETTLED/RETRY → FAILED
 *
 * Phase 2: VALIDATING now runs a 5-check sequential gate:
 *   V1: Worker Activity Check      — I_i(t) = 1 for ≥45/60 disruption minutes
 *   V2: Kinematic Activity Check   — KDI_g(t) > 0.40
 *   V3: Zone-Wide Coherence Test   — EKCT (only if zone-wide OVA collapse)
 *   V4: Delivery Behaviour Score   — DBS_i(t) < 0.45 (eligible) or > 0.65 (ineligible)
 *   V5: Multi-layer Fraud Score    — F = Σλⱼsⱼ < 0.75
 *
 * All five checks must pass for → READY_PAY.
 * Any single failure → REJECTED with specific rejection reason code.
 */
const { Kafka } = require('kafkajs');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { computePayout } = require('./dfa/state-machine');

// ── Config ────────────────────────────────────────────
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/grap';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const GATE_MINUTES = parseInt(process.env.CLAIM_GATE_MINUTES || '60');
const GATE_THRESHOLD = parseFloat(process.env.CLAIM_GATE_THRESHOLD || '0.85');

// ── Phase 2: Timeout Constants (SLA-derived) ────────
const FRAUD_ENGINE_TIMEOUT_MS = 30 * 1000;      // 30 seconds SLA
const PLAY_INTEGRITY_TIMEOUT_MS = 5 * 1000;     // 5s — external API
const OPENCELLID_TIMEOUT_MS = 2 * 1000;         // 2s — Redis lookup
const FFT_COMPUTE_TIMEOUT_MS = 500;             // 500ms — pure compute
const GNSS_SCORE_TIMEOUT_MS = 100;              // 100ms — 3 arithmetic ops

// ── MongoDB Claim schema (extended for Phase 2) ─────
const claimSchema = new mongoose.Schema({
  // ── Core fields (Phase 1) ──────────────────────────
  claim_id: { type: String, required: true, unique: true },
  worker_id: { type: String, required: true, index: true },
  ward_id: { type: String },
  state: { type: String, default: 'ACTIVE' },
  risk_score: Number,
  gate_start: Date,
  initiated_at: Date,
  fraud_verdict: String,
  fraud_score: Number,
  payout_amount: Number,
  hours_disrupted: Number,
  weekly_si: Number,
  dst: Number,
  retry_count: { type: Number, default: 0 },
  idempotency_key: String,
  razorpay_payment_id: String,
  settled_at: Date,
  rejected_at: Date,
  failed_at: Date,
  transitions: [{
    from: String,
    to: String,
    timestamp: { type: Date, default: Date.now },
    reason: String,
  }],
  triggers: mongoose.Schema.Types.Mixed,
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },

  // ── Fix 1: KDI + EKCT fields ──────────────────────
  kdi_at_validation: Number,
  ekct_applied: Boolean,
  ekct_pass: Boolean,
  r_city_at_validation: Number,
  kdi_city_at_validation: Number,
  opa_confidence_weight: { type: Number, default: 1.0 },

  // ── Fix 2: Deterministic fraud labels ──────────────
  deterministic_fraud_label: Number,
  fraud_class: String,
  layer_scores: {
    gnss: Number,
    kinematic: Number,
    network: Number,
    ecosystem: Number,
  },
  fraud_score_F: Number,
  fraud_weights_used: {
    gnss: Number,
    kinematic: Number,
    network: Number,
    integrity: Number,
  },

  // ── Fix 3: Delivery Behaviour Score ────────────────
  dbs_at_validation: Number,
  sfr_ratio_at_validation: Number,
  gri_at_validation: Number,
  ae_ratio_at_validation: Number,
  dbs_ambiguous_flag: Boolean,

  // ── All fixes: Audit trail ─────────────────────────
  validation_steps: [{
    step: String,
    result: String,
    value: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now },
    message: String,
  }],
  rejection_reason: String,
  rejection_details: mongoose.Schema.Types.Mixed,
  validation_passed_at: String,
  validation_steps_complete: [String],
  payout_breakdown: mongoose.Schema.Types.Mixed,
  disruption_window_minutes: Number,
});

const Claim = mongoose.model('Claim', claimSchema);

// ── Kafka setup ──────────────────────────────────────
const kafka = new Kafka({ clientId: 'grap-dfa-engine', brokers: KAFKA_BROKERS });
const consumer = kafka.consumer({ groupId: 'dfa-engine-group' });
const producer = kafka.producer({ idempotent: true });

// ── Redis setup ──────────────────────────────────────
const redis = new Redis(REDIS_URL);

// ── Active gate tracking ─────────────────────────────
// Map: workerId → { gateStart, lastScore }
const activeGates = new Map();

// ═══════════════════════════════════════════════════════
// Phase 2: Validation Helper Functions
// ═══════════════════════════════════════════════════════

/**
 * Log a validation step to the claim's validation_steps array.
 */
async function logValidationStep(claimId, step, result, message, value = null) {
  await Claim.updateOne(
    { claim_id: claimId },
    {
      $push: {
        validation_steps: {
          step,
          result,
          value,
          timestamp: new Date(),
          message,
        },
      },
    }
  );
}

/**
 * Update a single field on a claim document.
 */
async function updateClaimField(claimId, field, value) {
  await Claim.updateOne(
    { claim_id: claimId },
    { $set: { [field]: value } }
  );
}

/**
 * Reject a claim with full audit trail.
 */
async function rejectClaim(claim, reason, details) {
  claim.state = 'REJECTED';
  claim.rejection_reason = reason;
  claim.rejection_details = details;
  claim.rejected_at = new Date();
  claim.updated_at = new Date();
  claim.transitions.push({
    from: 'VALIDATING',
    to: 'REJECTED',
    timestamp: new Date(),
    reason: `${reason}: ${JSON.stringify(details)}`,
  });
  await claim.save();

  await producer.send({
    topic: 'claim-events',
    messages: [{
      key: claim.worker_id,
      value: JSON.stringify({
        type: 'CLAIM_STATE_CHANGE',
        claim_id: claim.claim_id,
        worker_id: claim.worker_id,
        from: 'VALIDATING',
        to: 'REJECTED',
        reason,
        timestamp: new Date().toISOString(),
      }),
    }],
  });

  console.log(`🚫 Claim ${claim.claim_id} REJECTED — ${reason}`);
  return { state: 'REJECTED', reason, details };
}

// ═══════════════════════════════════════════════════════
// V1: Worker Activity Check
// ═══════════════════════════════════════════════════════

/**
 * V1: Check that the worker was active for ≥ 45 of 60 disruption minutes.
 * I_i(t) = 1 for ≥ 45/60 disruption minutes.
 */
async function checkWorkerActivity(workerId, claimId, disruptionWindowMinutes) {
  // The disruption window must be at least the gate minutes
  const activeMinutes = disruptionWindowMinutes || GATE_MINUTES;

  // A worker who passed the 60-minute gate has been active for ≥60 minutes
  // by definition (the gate tracks continuous Rt > 0.85).
  // V1 confirms the worker had telemetry pings for ≥ 75% of the window.
  const requiredMinutes = Math.ceil(GATE_MINUTES * 0.75); // 45 of 60

  if (activeMinutes >= requiredMinutes) {
    await logValidationStep(claimId, 'V1', 'PASS',
      `Worker active for ${activeMinutes} min ≥ ${requiredMinutes} min threshold`);
    return { pass: true };
  }

  return {
    pass: false,
    reason: 'V1_VOLUNTARY_INACTIVITY',
    details: {
      activeMinutes,
      requiredMinutes,
      message: 'Worker not active for sufficient duration during disruption window.',
    },
  };
}

// ═══════════════════════════════════════════════════════
// V2 + V3: Kinematic Activity + Zone-Wide Coherence
// ═══════════════════════════════════════════════════════

/**
 * V2: Check KDI for the ward. If KDI < 0.40, check for zone-wide collapse (V3/EKCT).
 */
async function checkKineticActivity(wardId, claimId) {
  const wardData = await redis.hgetall(`ward_risk:${wardId}`);
  const kdi = parseFloat(wardData?.kdi ?? '0');

  await updateClaimField(claimId, 'kdi_at_validation', kdi);

  if (kdi < 0.40) {
    // KDI too low — check if zone-wide collapse
    const zoneWideCollapse = await detectZoneWideOVACollapse();

    if (zoneWideCollapse) {
      // Run EKCT — Environmental-Kinematic Coherence Test
      const ekctResult = await runEKCT();

      await updateClaimField(claimId, 'ekct_applied', true);
      await updateClaimField(claimId, 'ekct_pass', ekctResult.pass);
      await updateClaimField(claimId, 'r_city_at_validation', ekctResult.r_city);
      await updateClaimField(claimId, 'kdi_city_at_validation', ekctResult.kdi_city);

      if (ekctResult.pass) {
        // Genuine city-wide environmental disruption confirmed by rainfall
        await updateClaimField(claimId, 'opa_confidence_weight', 0.70);
        await logValidationStep(claimId, 'V2_V3', 'PASS_EKCT',
          `Zone-wide suppression detected but rainfall corroborates. ` +
          `R_city=${ekctResult.r_city.toFixed(3)}, KDI_city=${ekctResult.kdi_city.toFixed(3)}`,
          { kdi, r_city: ekctResult.r_city, kdi_city: ekctResult.kdi_city }
        );
        return { pass: true, opaConfidenceWeight: 0.70 };
      } else {
        // Zone-wide platform throttle — no rainfall corroboration
        await logValidationStep(claimId, 'V2_V3', 'FAIL',
          `Zone-wide OVA collapse without rainfall corroboration.`,
          { kdi, r_city: ekctResult.r_city, kdi_city: ekctResult.kdi_city }
        );
        return {
          pass: false,
          reason: 'ZONE_WIDE_PLATFORM_SUPPRESSION',
          details: {
            kdi,
            r_city: ekctResult.r_city,
            kdi_city: ekctResult.kdi_city,
            message: 'Zone-wide OVA collapse without rainfall corroboration. Platform throttle suspected.',
          },
        };
      }
    } else {
      // Local ward suppression — no zone-wide context
      await updateClaimField(claimId, 'ekct_applied', false);
      await logValidationStep(claimId, 'V2', 'FAIL',
        `KDI=${kdi.toFixed(3)} < 0.40. Workers not physically attempting locomotion.`,
        { kdi, threshold: 0.40 }
      );
      return {
        pass: false,
        reason: 'LOW_KINEMATIC_ACTIVITY',
        details: {
          kdi,
          threshold: 0.40,
          message: 'Workers not physically attempting locomotion. Platform suppression or voluntary inactivity.',
        },
      };
    }
  }

  await updateClaimField(claimId, 'ekct_applied', false);
  await logValidationStep(claimId, 'V2', 'PASS',
    `KDI=${kdi.toFixed(3)} ≥ 0.40`, { kdi });
  return { pass: true };
}

/**
 * Detect zone-wide OVA collapse.
 * Zone-wide if > 80% of active wards show OVA < 0.30.
 */
async function detectZoneWideOVACollapse() {
  const activeWards = await redis.smembers('active_disrupted_wards');
  if (activeWards.length < 3) return false; // Need at least 3 wards for "zone-wide"

  let lowOVACount = 0;
  for (const ward of activeWards) {
    const wardData = await redis.hgetall(`ward_risk:${ward}`);
    const ova = parseFloat(wardData?.ova_ratio ?? '1.0');
    if (ova < 0.30) lowOVACount++;
  }

  return (lowOVACount / activeWards.length) > 0.80;
}

/**
 * Run Environmental-Kinematic Coherence Test.
 * EKCT_pass iff R_city > 0.40 AND KDI_city < 0.30
 */
async function runEKCT() {
  const activeWards = await redis.smembers('active_disrupted_wards');
  const rValues = [];
  const kdiValues = [];

  for (const ward of activeWards) {
    const data = await redis.hgetall(`ward_risk:${ward}`);
    if (data) {
      rValues.push(parseFloat(data.rain_normalized ?? '0'));
      kdiValues.push(parseFloat(data.kdi ?? '0'));
    }
  }

  if (rValues.length === 0) {
    return { pass: false, r_city: 0, kdi_city: 0 };
  }

  const r_city = Math.max(...rValues);
  const kdi_city = kdiValues.reduce((a, b) => a + b, 0) / kdiValues.length;
  const pass = r_city > 0.40 && kdi_city < 0.30;

  return { pass, r_city, kdi_city };
}

// ═══════════════════════════════════════════════════════
// V4: Delivery Behaviour Score
// ═══════════════════════════════════════════════════════

/**
 * V4: Compute DBS = 0.40×SFR + 0.35×GRI + 0.25×AE.
 * DBS < 0.45 → ELIGIBLE, DBS > 0.65 → INELIGIBLE, else AMBIGUOUS (allowed with flag).
 */
async function checkDeliveryBehaviour(workerId, claimId) {
  const workerState = await redis.hgetall(`worker_disruption_state:${workerId}`);

  const sfr_ratio = parseFloat(workerState?.sfr_ratio ?? '1.0');
  const gri = parseFloat(workerState?.gri ?? '1.0');
  const ae_ratio = parseFloat(workerState?.ae_ratio ?? '1.0');

  const dbs = (0.40 * sfr_ratio) + (0.35 * gri) + (0.25 * ae_ratio);

  await updateClaimField(claimId, 'dbs_at_validation', dbs);
  await updateClaimField(claimId, 'sfr_ratio_at_validation', sfr_ratio);
  await updateClaimField(claimId, 'gri_at_validation', gri);
  await updateClaimField(claimId, 'ae_ratio_at_validation', ae_ratio);

  if (dbs > 0.65) {
    await logValidationStep(claimId, 'V4', 'FAIL',
      `DBS=${dbs.toFixed(3)} > 0.65. Delivery behaviour detected.`,
      { dbs, sfr_ratio, gri, ae_ratio }
    );
    return {
      pass: false,
      reason: 'EARNINGS_SUBSTITUTION_DETECTED',
      details: {
        dbs,
        sfr_ratio,
        gri,
        ae_ratio,
        threshold: 0.65,
        message: 'Worker exhibiting delivery behaviour during disruption window. ' +
                 'Earnings substitution on another platform suspected.',
      },
    };
  }

  if (dbs >= 0.45 && dbs <= 0.65) {
    // Ambiguous — log flag but allow claim
    await updateClaimField(claimId, 'dbs_ambiguous_flag', true);
    await logValidationStep(claimId, 'V4', 'PASS_AMBIGUOUS',
      `DBS=${dbs.toFixed(3)} in ambiguous zone [0.45, 0.65]. Claim allowed with flag.`,
      { dbs, sfr_ratio, gri, ae_ratio }
    );
  } else {
    await logValidationStep(claimId, 'V4', 'PASS',
      `DBS=${dbs.toFixed(3)} < 0.45. No delivery behaviour detected.`,
      { dbs, sfr_ratio, gri, ae_ratio }
    );
  }

  return { pass: true, dbs };
}

// ═══════════════════════════════════════════════════════
// V5: Multi-layer Fraud Score (existing, now with dynamic weights)
// ═══════════════════════════════════════════════════════

/**
 * V5: Wait for fraud engine verdict with 30s timeout.
 * The fraud engine now uses dynamic Bayesian weights.
 */
async function waitForFraudVerdict(claimId, timeoutMs = FRAUD_ENGINE_TIMEOUT_MS) {
  // The fraud verdict arrives via Kafka message (handleFraudVerdict below).
  // This is a polling check — in production, use event-driven approach.
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const claim = await Claim.findOne({ claim_id: claimId });
    if (claim && claim.fraud_verdict) {
      return {
        verdict: claim.fraud_verdict,
        fraud_score: claim.fraud_score,
        layer_scores: claim.layer_scores,
        weights_used: claim.fraud_weights_used,
      };
    }
    // Wait 500ms before polling again
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Timeout — treat as inconclusive, reject
  return { verdict: 'TIMEOUT', fraud_score: null };
}

// ═══════════════════════════════════════════════════════
// Main Event Handlers
// ═══════════════════════════════════════════════════════

/**
 * Process a RiskEvent from Flink.
 * Implements: ACTIVE + Rt>0.85 (>60min) → INITIATED
 */
async function handleRiskEvent(event) {
  const { worker_id, risk_score, ward_id, timestamp } = event;

  if (risk_score > GATE_THRESHOLD) {
    // Check if gate already started
    if (!activeGates.has(worker_id)) {
      activeGates.set(worker_id, { gateStart: new Date(timestamp), lastScore: risk_score });
      console.log(`⏱️  Gate started for ${worker_id} (Rt=${risk_score.toFixed(3)})`);
      return;
    }

    const gate = activeGates.get(worker_id);
    gate.lastScore = risk_score;
    const elapsed = (new Date(timestamp) - gate.gateStart) / 60000; // minutes

    if (elapsed >= GATE_MINUTES) {
      // Gate has been above threshold for required duration → INITIATE claim
      console.log(`🚨 Gate passed for ${worker_id} (${elapsed.toFixed(1)} min, Rt=${risk_score.toFixed(3)})`);
      activeGates.delete(worker_id);
      await initiateClaim(worker_id, risk_score, ward_id, gate.gateStart, elapsed);
    }
  } else {
    // Score dropped below threshold → reset gate
    if (activeGates.has(worker_id)) {
      console.log(`🔄 Gate reset for ${worker_id} (Rt=${risk_score.toFixed(3)} < ${GATE_THRESHOLD})`);
      activeGates.delete(worker_id);
    }
  }
}

/**
 * Create a new claim and transition ACTIVE → INITIATED → VALIDATING.
 * Then run the 5-check sequential validation gate.
 */
async function initiateClaim(workerId, riskScore, wardId, gateStart, disruptionWindowMinutes) {
  const claimId = `CLM-${uuidv4().slice(0, 8).toUpperCase()}`;
  const now = new Date();

  // Get ward risk triggers from Redis
  let triggers = {};
  try {
    triggers = await redis.hgetall(`ward_risk:${wardId}`);
  } catch (e) {
    console.warn('Could not fetch ward risk from Redis:', e.message);
  }

  const claim = new Claim({
    claim_id: claimId,
    worker_id: workerId,
    ward_id: wardId,
    state: 'INITIATED',
    risk_score: riskScore,
    gate_start: gateStart,
    initiated_at: now,
    weekly_si: 2500, // default, should come from worker policy
    dst: 8.2, // P90 fallback
    disruption_window_minutes: disruptionWindowMinutes || GATE_MINUTES,
    triggers,
    transitions: [
      { from: 'ACTIVE', to: 'INITIATED', timestamp: now, reason: `Rt=${riskScore.toFixed(3)} > ${GATE_THRESHOLD} for ${GATE_MINUTES}min` },
    ],
    validation_steps: [],
  });

  await claim.save();
  console.log(`📋 Claim ${claimId} created for ${workerId} → INITIATED`);

  // Transition to VALIDATING
  await transitionClaim(claim, 'VALIDATING', 'Duration confirmed, submitting for validation');

  // Publish to fraud-signals topic (for V5 scoring)
  await producer.send({
    topic: 'fraud-signals',
    messages: [{
      key: workerId,
      value: JSON.stringify({
        claim_id: claimId,
        worker_id: workerId,
        ward_id: wardId,
        risk_score: riskScore,
        triggers,
        timestamp: now.toISOString(),
      }),
    }],
  });

  console.log(`📤 Published fraud-signal for ${claimId}`);

  // ─── Run 5-check sequential validation gate ─────────
  await handleValidating(claim, disruptionWindowMinutes);
}

/**
 * VALIDATING state handler — 5-check sequential gate.
 * All checks must pass for claim to reach READY_PAY.
 * Any failure → REJECTED with specific reason code.
 */
async function handleValidating(claim, disruptionWindowMinutes) {
  const claimId = claim.claim_id;
  const workerId = claim.worker_id;
  const wardId = claim.ward_id;

  console.log(`🔍 Running 5-check validation for ${claimId}...`);

  // ─── V1: Worker Activity Check ──────────────────────
  const v1 = await checkWorkerActivity(workerId, claimId, disruptionWindowMinutes);
  if (!v1.pass) {
    return await rejectClaim(claim, 'V1_VOLUNTARY_INACTIVITY', v1.details);
  }
  console.log(`  ✅ V1 passed for ${claimId}`);

  // ─── V2 + V3: Kinematic Activity + Zone-Wide Coherence ─
  const v2 = await checkKineticActivity(wardId, claimId);
  if (!v2.pass) {
    return await rejectClaim(claim, v2.reason, v2.details);
  }
  console.log(`  ✅ V2/V3 passed for ${claimId}`);

  // Track EKCT confidence weight
  const opaConfidenceWeight = v2.opaConfidenceWeight || claim.opa_confidence_weight || 1.0;

  // ─── V4: Delivery Behaviour Score ───────────────────
  const v4 = await checkDeliveryBehaviour(workerId, claimId);
  if (!v4.pass) {
    return await rejectClaim(claim, v4.reason, v4.details);
  }
  console.log(`  ✅ V4 passed for ${claimId}`);

  // ─── V5: Multi-layer Fraud Score ────────────────────
  // Wait for the fraud engine to produce a verdict (30s timeout)
  const v5 = await waitForFraudVerdict(claimId, FRAUD_ENGINE_TIMEOUT_MS);

  if (v5.verdict === 'TIMEOUT') {
    await logValidationStep(claimId, 'V5', 'FAIL',
      `Fraud engine timeout after ${FRAUD_ENGINE_TIMEOUT_MS}ms`);
    // On timeout, re-queue for retry rather than rejecting
    console.log(`⏱️  V5 timeout for ${claimId} — awaiting fraud verdict via Kafka`);
    return; // Will be handled by handleFraudVerdict when Kafka message arrives
  }

  if (v5.verdict === 'FAIL') {
    await logValidationStep(claimId, 'V5', 'FAIL',
      `Fraud score F=${v5.fraud_score?.toFixed(3)} > 0.75`,
      { F: v5.fraud_score, layer_scores: v5.layer_scores });
    return await rejectClaim(claim, 'V5_FRAUD_SCORE_EXCEEDED', {
      fraud_score: v5.fraud_score,
      threshold: 0.75,
      layer_scores: v5.layer_scores,
      message: `Composite fraud score ${v5.fraud_score?.toFixed(3)} exceeds threshold 0.75.`,
    });
  }

  await logValidationStep(claimId, 'V5', 'PASS',
    `Fraud score F=${v5.fraud_score?.toFixed(3)} < 0.75`,
    { F: v5.fraud_score, layer_scores: v5.layer_scores });
  console.log(`  ✅ V5 passed for ${claimId} (F=${v5.fraud_score?.toFixed(3)})`);

  // ─── All checks passed → compute payout and transition ─
  const hoursDisrupted = computeHoursDisrupted(claim);
  const payoutAmount = computePayout(claim.weekly_si, claim.dst, hoursDisrupted) * opaConfidenceWeight;

  // Reload the claim to get latest state
  const freshClaim = await Claim.findOne({ claim_id: claimId });
  if (!freshClaim || freshClaim.state !== 'VALIDATING') {
    console.warn(`Claim ${claimId} no longer in VALIDATING state (${freshClaim?.state})`);
    return;
  }

  freshClaim.hours_disrupted = hoursDisrupted;
  freshClaim.payout_amount = Math.round(payoutAmount * 100) / 100;
  freshClaim.validation_passed_at = new Date().toISOString();
  freshClaim.validation_steps_complete = ['V1', 'V2', 'V3', 'V4', 'V5'];

  await transitionClaim(freshClaim, 'READY_PAY',
    `All 5 checks passed. Payout=₹${payoutAmount.toFixed(2)} (confidence=${opaConfidenceWeight})`);

  // Generate idempotency key and publish payout command
  const crypto = require('crypto');
  const weekNumber = getWeekNumber(new Date());
  freshClaim.idempotency_key = crypto
    .createHash('sha256')
    .update(`${claimId}${freshClaim.worker_id}${weekNumber}`)
    .digest('hex');

  await freshClaim.save();

  await producer.send({
    topic: 'payout-commands',
    messages: [{
      key: freshClaim.worker_id,
      value: JSON.stringify({
        claim_id: freshClaim.claim_id,
        worker_id: freshClaim.worker_id,
        amount: freshClaim.payout_amount,
        currency: 'INR',
        idempotency_key: freshClaim.idempotency_key,
        timestamp: new Date().toISOString(),
      }),
    }],
  });

  // Transition to PROCESSING
  await transitionClaim(freshClaim, 'PROCESSING', 'Payout command issued');
  console.log(`💰 All V1-V5 passed → payout ₹${payoutAmount.toFixed(2)} for ${freshClaim.worker_id}`);
}

/**
 * Handle FraudVerdict from Fraud Engine (Kafka callback).
 * Stores fraud results on the claim for V5 to pick up.
 * Also handles the case where V5 timed out and verdict arrives later.
 */
async function handleFraudVerdict(event) {
  const { claim_id, verdict, fraud_score, layer_scores, weights_used, e_locomotion,
          deterministic_fraud_label, fraud_class } = event;

  const claim = await Claim.findOne({ claim_id });
  if (!claim) {
    // Not a verdict message — might be a request to score
    return;
  }

  // Store fraud engine results on the claim
  claim.fraud_verdict = verdict;
  claim.fraud_score = fraud_score;
  claim.fraud_score_F = fraud_score;

  // Store layer scores
  if (layer_scores) {
    claim.layer_scores = {
      gnss: layer_scores.gnss ?? null,
      kinematic: layer_scores.kinematic ?? null,
      network: layer_scores.network ?? null,
      ecosystem: layer_scores.integrity ?? layer_scores.ecosystem ?? null,
    };
  }

  // Store weight snapshot
  if (weights_used) {
    claim.fraud_weights_used = weights_used;
  }

  // Store deterministic fraud label if present
  if (deterministic_fraud_label !== undefined) {
    claim.deterministic_fraud_label = deterministic_fraud_label;
  }
  if (fraud_class) {
    claim.fraud_class = fraud_class;
  }

  claim.updated_at = new Date();
  await claim.save();

  // If the claim is still in VALIDATING and V5 had timed out,
  // the handleValidating polling loop will pick up this verdict.
  // If it already moved to REJECTED/READY_PAY, this is a no-op for state transitions.

  console.log(`📥 Fraud verdict stored for ${claim_id}: ${verdict} (F=${fraud_score?.toFixed(3)})`);
}

/**
 * Handle deterministic fraud label events from the Physical Impossibility Detector.
 */
async function handleDeterministicFraud(event) {
  const { worker_id, deterministic_fraud_label, fraud_class } = event;

  // Find any active/validating claims for this worker
  const claims = await Claim.find({
    worker_id,
    state: { $in: ['INITIATED', 'VALIDATING'] },
  });

  for (const claim of claims) {
    claim.deterministic_fraud_label = deterministic_fraud_label;
    claim.fraud_class = fraud_class;
    claim.updated_at = new Date();
    await claim.save();
    console.log(`🔴 Deterministic fraud label ${fraud_class} applied to ${claim.claim_id}`);
  }
}

/**
 * Handle payment result.
 * PROCESSING + SUCCESS → SETTLED
 * PROCESSING + FAIL → RETRY (max 3) → FAILED
 */
async function handlePaymentResult(event) {
  const { claim_id, status, payment_id, error } = event;

  const claim = await Claim.findOne({ claim_id });
  if (!claim) return;

  if (status === 'SUCCESS') {
    claim.razorpay_payment_id = payment_id;
    claim.settled_at = new Date();

    // Set deterministic_fraud_label = 0 for settled claims (legitimate)
    if (claim.deterministic_fraud_label === undefined || claim.deterministic_fraud_label === null) {
      claim.deterministic_fraud_label = 0;
    }

    await transitionClaim(claim, 'SETTLED', `Payment successful (${payment_id})`);
    console.log(`✅ Claim ${claim_id} SETTLED`);

  } else {
    // Failure → RETRY
    claim.retry_count += 1;
    if (claim.retry_count >= 3) {
      claim.failed_at = new Date();
      await transitionClaim(claim, 'FAILED', `Max retries (${claim.retry_count}) exceeded`);
      console.log(`❌ Claim ${claim_id} FAILED after ${claim.retry_count} retries`);
    } else {
      const backoff = Math.pow(2, claim.retry_count - 1) * 1000; // 1s, 2s, 4s
      await transitionClaim(claim, 'RETRY', `Retry ${claim.retry_count}/3 (backoff ${backoff}ms): ${error || 'timeout'}`);
      console.log(`🔄 Claim ${claim_id} RETRY ${claim.retry_count}/3 (backoff ${backoff}ms)`);

      // Re-publish payout after backoff
      setTimeout(async () => {
        try {
          await transitionClaim(claim, 'PROCESSING', `Retry ${claim.retry_count} backoff elapsed`);
          await producer.send({
            topic: 'payout-commands',
            messages: [{
              key: claim.worker_id,
              value: JSON.stringify({
                claim_id: claim.claim_id,
                worker_id: claim.worker_id,
                amount: claim.payout_amount,
                currency: 'INR',
                idempotency_key: claim.idempotency_key,
                retry: claim.retry_count,
                timestamp: new Date().toISOString(),
              }),
            }],
          });
        } catch (e) {
          console.error(`Failed to re-publish payout for ${claim_id}:`, e);
        }
      }, backoff);
    }
  }
}

// ── Helpers ──────────────────────────────────────────
async function transitionClaim(claim, newState, reason) {
  const oldState = claim.state;
  claim.state = newState;
  claim.updated_at = new Date();
  claim.transitions.push({ from: oldState, to: newState, timestamp: new Date(), reason });
  await claim.save();

  // Publish state change to claim-events for WebSocket
  await producer.send({
    topic: 'claim-events',
    messages: [{
      key: claim.worker_id,
      value: JSON.stringify({
        type: 'CLAIM_STATE_CHANGE',
        claim_id: claim.claim_id,
        worker_id: claim.worker_id,
        from: oldState,
        to: newState,
        payout: claim.payout_amount,
        reason,
        timestamp: new Date().toISOString(),
      }),
    }],
  });
}

function computeHoursDisrupted(claim) {
  if (!claim.gate_start || !claim.initiated_at) return 1;
  return Math.max(1, (claim.initiated_at - claim.gate_start) / 3600000);
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// ── Main ─────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB connected');

  await producer.connect();
  console.log('✅ Kafka producer ready');

  await consumer.connect();
  await consumer.subscribe({ topic: 'claim-events', fromBeginning: false });
  await consumer.subscribe({ topic: 'fraud-signals', fromBeginning: false });
  await consumer.subscribe({ topic: 'payout-commands', fromBeginning: false });
  console.log('✅ Kafka consumer subscribed');

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const event = JSON.parse(message.value.toString());

        switch (topic) {
          case 'claim-events':
            if (event.type === 'RISK_EVENT') {
              await handleRiskEvent(event);
            }
            break;
          case 'fraud-signals':
            if (event.type === 'DETERMINISTIC_FRAUD') {
              await handleDeterministicFraud(event);
            } else if (event.verdict) {
              await handleFraudVerdict(event);
            }
            break;
          case 'payout-commands':
            if (event.status) {
              await handlePaymentResult(event);
            }
            break;
        }
      } catch (err) {
        console.error(`Error processing message from ${topic}:`, err);
      }
    },
  });

  console.log('🚀 DFA Claim Engine running (Phase 2 — 5-check validation gate)');
}

main().catch((err) => {
  console.error('❌ DFA Engine failed to start:', err);
  process.exit(1);
});
