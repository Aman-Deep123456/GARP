/**
 * GRAP Platform — Payment Service
 * Razorpay UPI sandbox with SHA256 idempotency and exponential backoff.
 */
const { Kafka } = require('kafkajs');
const mongoose = require('mongoose');
const crypto = require('crypto');

// ── Config ───────────────────────────────────────────
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongodb:27017/grap';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_xxxxxxxxxxxx';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');

// ── Razorpay client (mock for sandbox) ───────────────
let Razorpay;
let razorpay;
try {
  Razorpay = require('razorpay');
  razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET,
  });
} catch (e) {
  console.warn('Razorpay SDK not available, using mock mode');
}

// ── Processed payments (idempotency cache) ───────────
const processedPayments = new Map();

// ── MongoDB Payment Log ──────────────────────────────
const paymentSchema = new mongoose.Schema({
  claim_id: { type: String, required: true },
  worker_id: { type: String, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  idempotency_key: { type: String, unique: true },
  status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
  razorpay_payment_id: { type: String },
  retry_count: { type: Number, default: 0 },
  error: { type: String },
  created_at: { type: Date, default: Date.now },
  processed_at: { type: Date },
});

const Payment = mongoose.model('Payment', paymentSchema);

// ── Kafka ────────────────────────────────────────────
const kafka = new Kafka({ clientId: 'grap-payment-service', brokers: KAFKA_BROKERS });
const consumer = kafka.consumer({ groupId: 'payment-service-group' });
const producer = kafka.producer({ idempotent: true });

/**
 * Process a payout command via Razorpay UPI sandbox.
 * SHA256(claim_id‖worker_id‖week_number) for idempotency.
 */
async function processPayment(event) {
  const { claim_id, worker_id, amount, currency, idempotency_key, retry } = event;

  console.log(`💳 Processing payment: ₹${amount} for ${worker_id} (claim: ${claim_id})`);

  // Check idempotency
  if (processedPayments.has(idempotency_key)) {
    const cached = processedPayments.get(idempotency_key);
    console.log(`♻️  Idempotent duplicate: ${claim_id} already processed → ${cached.status}`);

    await producer.send({
      topic: 'payout-commands',
      messages: [{
        key: worker_id,
        value: JSON.stringify({
          claim_id,
          worker_id,
          status: cached.status,
          payment_id: cached.payment_id,
          timestamp: new Date().toISOString(),
        }),
      }],
    });
    return;
  }

  try {
    let paymentResult;

    if (razorpay && RAZORPAY_KEY_SECRET) {
      // Real Razorpay sandbox call
      paymentResult = await razorpay.payments.create({
        amount: Math.round(amount * 100), // Razorpay amount in paise
        currency: currency || 'INR',
        method: 'upi',
        description: `GRAP claim payout: ${claim_id}`,
        notes: {
          claim_id,
          worker_id,
          idempotency_key,
        },
      });
    } else {
      // Mock payment for demo
      await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

      // Simulate 90% success rate
      if (Math.random() > 0.1 || retry > 0) {
        paymentResult = {
          id: `pay_mock_${crypto.randomBytes(8).toString('hex')}`,
          status: 'captured',
          amount: Math.round(amount * 100),
          currency: 'INR',
        };
      } else {
        throw new Error('Payment gateway timeout (simulated)');
      }
    }

    // Payment success
    const result = {
      claim_id,
      worker_id,
      status: 'SUCCESS',
      payment_id: paymentResult.id,
      amount,
      timestamp: new Date().toISOString(),
    };

    processedPayments.set(idempotency_key, {
      status: 'SUCCESS',
      payment_id: paymentResult.id,
    });

    // Save to MongoDB
    await Payment.findOneAndUpdate(
      { idempotency_key },
      {
        claim_id,
        worker_id,
        amount,
        idempotency_key,
        status: 'SUCCESS',
        razorpay_payment_id: paymentResult.id,
        processed_at: new Date(),
      },
      { upsert: true, new: true }
    );

    // Publish success
    await producer.send({
      topic: 'payout-commands',
      messages: [{ key: worker_id, value: JSON.stringify(result) }],
    });

    console.log(`✅ Payment SUCCESS: ₹${amount} → ${paymentResult.id}`);

  } catch (err) {
    console.error(`❌ Payment FAILED: ${err.message}`);

    // Publish failure for DFA to handle retry
    await producer.send({
      topic: 'payout-commands',
      messages: [{
        key: worker_id,
        value: JSON.stringify({
          claim_id,
          worker_id,
          status: 'FAILED',
          error: err.message,
          timestamp: new Date().toISOString(),
        }),
      }],
    });
  }
}

// ── Main ─────────────────────────────────────────────
async function main() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ MongoDB connected');

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: 'payout-commands', fromBeginning: false });
  console.log('✅ Kafka consumer/producer ready');

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const event = JSON.parse(message.value.toString());

        // Only process commands (not results)
        if (event.amount && !event.status) {
          await processPayment(event);
        }
      } catch (err) {
        console.error('Error processing payout command:', err);
      }
    },
  });

  console.log('🚀 Payment Service running');
}

main().catch((err) => {
  console.error('❌ Payment Service failed:', err);
  process.exit(1);
});
