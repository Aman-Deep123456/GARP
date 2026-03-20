/**
 * Exactly-once idempotent Kafka producer for GRAP Platform.
 */
const { Kafka } = require('kafkajs');

const BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || 'grap-api-gateway';

const kafka = new Kafka({
  clientId: CLIENT_ID,
  brokers: BROKERS,
  retry: { initialRetryTime: 300, retries: 10 },
});

let producer = null;

async function createKafkaProducer() {
  producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 5,
    transactionalId: undefined, // idempotent but not transactional
  });

  await producer.connect();
  return producer;
}

/**
 * Send a message to a Kafka topic.
 * @param {string} topic
 * @param {string} key - Partition key (e.g. workerId)
 * @param {object} value - Message value (will be JSON-stringified)
 */
async function sendMessage(topic, key, value) {
  if (!producer) throw new Error('Kafka producer not initialized');

  await producer.send({
    topic,
    messages: [
      {
        key,
        value: JSON.stringify(value),
        timestamp: Date.now().toString(),
      },
    ],
  });
}

async function disconnectProducer() {
  if (producer) await producer.disconnect();
}

module.exports = { createKafkaProducer, sendMessage, disconnectProducer };
