#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# GRAP Platform — Kafka Topic Initialization
# Run inside the Kafka container after broker is ready.
# auto.create.topics.enable=false — all topics pre-created here.
# ═══════════════════════════════════════════════════════════

set -euo pipefail

BOOTSTRAP="kafka:9092"

echo "⏳ Waiting for Kafka broker to be ready..."
until kafka-topics --bootstrap-server ${BOOTSTRAP} --list > /dev/null 2>&1; do
  sleep 2
done
echo "✅ Kafka broker is ready."

declare -A TOPICS
TOPICS=(
  ["worker-telemetry"]="12"
  ["environmental-context"]="4"
  ["social-disruption"]="4"
  ["claim-events"]="8"
  ["fraud-signals"]="8"
  ["payout-commands"]="4"
)

RETENTION_MS=172800000  # 48 hours in milliseconds

for TOPIC in "${!TOPICS[@]}"; do
  PARTITIONS=${TOPICS[$TOPIC]}
  echo "📦 Creating topic: ${TOPIC} (partitions=${PARTITIONS}, retention=48h)"
  kafka-topics \
    --bootstrap-server ${BOOTSTRAP} \
    --create \
    --if-not-exists \
    --topic "${TOPIC}" \
    --partitions "${PARTITIONS}" \
    --replication-factor 1 \
    --config retention.ms=${RETENTION_MS}
done

echo ""
echo "✅ All topics created. Listing:"
kafka-topics --bootstrap-server ${BOOTSTRAP} --list
