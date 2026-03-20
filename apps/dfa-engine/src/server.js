/**
 * GRAP Platform — DFA Claim Engine
 * 9-state DFA with exact transitions from Section 6.
 *
 * ACTIVE → INITIATED (Rt>0.85, >60min) → VALIDATING → READY_PAY/REJECTED →
 * PROCESSING → SETTLED/RETRY → FAILED
 */
const { Kafka } = require('kafkajs');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { DFAStateMachine, computePayout } = require('./dfa/state-machine');

// ── Config ────────────────────────────────────────────
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/grap';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const GATE_MINUTES = parseInt(process.env.CLAIM_GATE_MINUTES || '60');
const GATE_THRESHOLD = parseFloat(process.env.CLAIM_GATE_THRESHOLD || '0.85');

// ── MongoDB Claim schema ─────────────────────────────
const claimSchema = new mongoose.Schema({
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
      await initiateClaim(worker_id, risk_score, ward_id, gate.gateStart);
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
 * Create a new claim and transition ACTIVE → INITIATED.
 */
async function initiateClaim(workerId, riskScore, wardId, gateStart) {
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
    triggers,
    transitions: [
      { from: 'ACTIVE', to: 'INITIATED', timestamp: now, reason: `Rt=${riskScore.toFixed(3)} > ${GATE_THRESHOLD} for ${GATE_MINUTES}min` },
    ],
  });

  await claim.save();
  console.log(`📋 Claim ${claimId} created for ${workerId} → INITIATED`);

  // Transition to VALIDATING → publish to fraud-signals
  await transitionClaim(claim, 'VALIDATING', 'Duration confirmed, submitting for fraud check');

  // Publish to fraud-signals topic
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
}

/**
 * Handle FraudVerdict from Fraud Engine.
 * VALIDATING + PASS → READY_PAY (compute Y)
 * VALIDATING + FAIL → REJECTED
 */
async function handleFraudVerdict(event) {
  const { claim_id, verdict, fraud_score } = event;

  const claim = await Claim.findOne({ claim_id });
  if (!claim || claim.state !== 'VALIDATING') {
    console.warn(`Ignoring fraud verdict for claim ${claim_id} (state=${claim?.state})`);
    return;
  }

  claim.fraud_verdict = verdict;
  claim.fraud_score = fraud_score;

  if (verdict === 'PASS') {
    // Compute payout: Y = (WeeklySI/7) / DST × HoursDisrupted
    const hoursDisrupted = computeHoursDisrupted(claim);
    const payout = computePayout(claim.weekly_si, claim.dst, hoursDisrupted);

    claim.hours_disrupted = hoursDisrupted;
    claim.payout_amount = payout;

    await transitionClaim(claim, 'READY_PAY', `Fraud PASS (F=${fraud_score?.toFixed(3)}), payout=₹${payout.toFixed(2)}`);

    // Generate idempotency key and publish payout command
    const crypto = require('crypto');
    const weekNumber = getWeekNumber(new Date());
    claim.idempotency_key = crypto
      .createHash('sha256')
      .update(`${claim_id}${claim.worker_id}${weekNumber}`)
      .digest('hex');

    await claim.save();

    await producer.send({
      topic: 'payout-commands',
      messages: [{
        key: claim.worker_id,
        value: JSON.stringify({
          claim_id: claim.claim_id,
          worker_id: claim.worker_id,
          amount: payout,
          currency: 'INR',
          idempotency_key: claim.idempotency_key,
          timestamp: new Date().toISOString(),
        }),
      }],
    });

    // Transition to PROCESSING
    await transitionClaim(claim, 'PROCESSING', 'Payout command issued');
    console.log(`💰 Payout command published: ₹${payout.toFixed(2)} for ${claim.worker_id}`);

  } else {
    // FAIL → REJECTED
    claim.rejected_at = new Date();
    await transitionClaim(claim, 'REJECTED', `Fraud FAIL (F=${fraud_score?.toFixed(3)})`);
    console.log(`🚫 Claim ${claim_id} REJECTED (fraud score: ${fraud_score?.toFixed(3)})`);
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
            if (event.verdict) {
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

  console.log('🚀 DFA Claim Engine running');
}

main().catch((err) => {
  console.error('❌ DFA Engine failed to start:', err);
  process.exit(1);
});
