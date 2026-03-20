"""
GRAP Platform — Flink Risk Scoring Job (Standalone Python version)
Consumes worker-telemetry from Kafka, computes EMA risk score per worker.
keyBy(workerId), NOT wardId — EMA state Rt is per-worker history.

Rt = α·Rt₋₁ + (1−α)·Σwᵢ·Tᵢ
α = 0.30

Emits RiskEvent to claim-events when Rt > 0.85.
"""
import os
import json
import math
import logging
import asyncio
from datetime import datetime, timezone

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("flink-risk-scorer")

# ── Config ────────────────────────────────────────────
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
EMA_ALPHA = float(os.getenv("EMA_ALPHA", "0.30"))
RISK_THRESHOLD = float(os.getenv("CLAIM_GATE_THRESHOLD", "0.85"))

# ── S2 Level 13 lookups per ward (simplified) ─────────
# In production, would use s2sphere library for exact S2 cell computation
# Binary search against sorted arrays in Redis ward:s2:{wardId}

# ── Per-worker EMA state ──────────────────────────────
# Map: worker_id → { Rt: float, last_updated: datetime }
worker_state = {}


def s2_cell_from_latlng(lat: float, lng: float) -> str:
    """
    Approximate S2 Level 13 cell ID from lat/lng.
    In production, use s2sphere.CellId.from_lat_lng() at level 13.
    Here we compute a hash-based approximation (~0.95 km² per cell).
    """
    # S2 Level 13: cell edge ≈ 0.97 km
    # Quantize lat/lng to ~0.01 degree grid (~1.1km at equator)
    grid_res = 0.0087  # ~0.97km at 19°N latitude
    lat_q = round(lat / grid_res) * grid_res
    lng_q = round(lng / grid_res) * grid_res
    cell_id = f"S2L13_{lat_q:.4f}_{lng_q:.4f}"
    return cell_id


async def lookup_ward_from_s2(redis_client, s2_cell: str) -> str | None:
    """
    Look up ward ID from S2 cell using Redis sorted arrays.
    ward:s2:{wardId} contains sorted S2CellID arrays.
    """
    # In production: binary search across ward:s2:* sorted sets
    # For demo: check each ward's S2 cell list
    wards = ["MUM_KURLA_W12", "MUM_ANDHERI_W58", "MUM_BANDRA_W43", "MUM_DADAR_W25", "MUM_POWAI_W91"]
    for ward_id in wards:
        try:
            s2_data = await redis_client.get(f"ward:s2:{ward_id}")
            if s2_data:
                cells = json.loads(s2_data)
                if s2_cell in cells:
                    return ward_id
        except Exception:
            pass

    # Fallback: assign based on latitude ranges
    try:
        lat = float(s2_cell.split("_")[1])
        if lat < 19.04:
            return "MUM_DADAR_W25"
        elif lat < 19.06:
            return "MUM_BANDRA_W43"
        elif lat < 19.08:
            return "MUM_KURLA_W12"
        elif lat < 19.12:
            return "MUM_ANDHERI_W58"
        else:
            return "MUM_POWAI_W91"
    except Exception:
        return "MUM_KURLA_W12"


async def get_ward_triggers(redis_client, ward_id: str) -> dict:
    """
    Fetch live triggers from Redis: hgetAll ward_risk:{wardId}
    """
    try:
        data = await redis_client.hgetall(f"ward_risk:{ward_id}")
        return {
            "rain": float(data.get("rain_normalized", 0)),
            "flood": float(data.get("flood_normalized", 0)),
            "aqi": float(data.get("aqi_normalized", 0)),
            "w_rain": float(data.get("w_rain", 0.60)),
            "w_aqi": float(data.get("w_aqi", 0.15)),
            "w_ops": float(data.get("w_ops", 0.15)),
        }
    except Exception as e:
        logger.warning(f"Failed to fetch ward triggers for {ward_id}: {e}")
        return {"rain": 0, "flood": 0, "aqi": 0, "w_rain": 0.60, "w_aqi": 0.15, "w_ops": 0.15}


def compute_weighted_triggers(triggers: dict) -> float:
    """
    Compute Σwᵢ·Tᵢ from ward triggers.
    """
    return (
        triggers["w_rain"] * triggers["rain"] +
        triggers["w_aqi"] * triggers["aqi"] +
        0.10 * triggers["flood"] +  # w_flood fixed at 0.10
        triggers["w_ops"] * triggers.get("ops", 0.5)  # operational disruption estimate
    )


def compute_ema(worker_id: str, weighted_trigger: float) -> float:
    """
    EMA: Rt = α·Rt₋₁ + (1−α)·Σwᵢ·Tᵢ
    """
    prev_rt = worker_state.get(worker_id, {}).get("Rt", 0.0)
    new_rt = EMA_ALPHA * prev_rt + (1 - EMA_ALPHA) * weighted_trigger

    worker_state[worker_id] = {
        "Rt": new_rt,
        "last_updated": datetime.now(timezone.utc).isoformat(),
    }

    return new_rt


async def main():
    logger.info("🚀 Flink Risk Scorer starting (standalone Python mode)...")
    logger.info(f"   EMA α = {EMA_ALPHA}, Threshold = {RISK_THRESHOLD}")

    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)

    consumer = AIOKafkaConsumer(
        "worker-telemetry",
        bootstrap_servers=KAFKA_BROKERS,
        group_id="flink-risk-scorer-group",
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
    )

    producer = AIOKafkaProducer(
        bootstrap_servers=KAFKA_BROKERS,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )

    await consumer.start()
    await producer.start()
    logger.info("✅ Kafka consumer/producer ready")

    try:
        async for msg in consumer:
            try:
                telemetry = msg.value
                worker_id = telemetry.get("worker_id")
                location = telemetry.get("location", {})
                lat = location.get("latitude", 0)
                lng = location.get("longitude", 0)

                # 1. S2 Level 13 cell lookup
                s2_cell = s2_cell_from_latlng(lat, lng)

                # 2. Ward lookup from S2 cell
                ward_id = await lookup_ward_from_s2(redis_client, s2_cell)

                # 3. Fetch live triggers from Redis
                triggers = await get_ward_triggers(redis_client, ward_id)

                # 4. Compute weighted trigger sum
                wt = compute_weighted_triggers(triggers)

                # 5. Compute EMA risk score
                rt = compute_ema(worker_id, wt)

                logger.debug(f"  {worker_id}: Rt={rt:.4f} (wt={wt:.4f}, ward={ward_id})")

                # 6. Emit RiskEvent if Rt > threshold
                if rt > RISK_THRESHOLD:
                    risk_event = {
                        "type": "RISK_EVENT",
                        "worker_id": worker_id,
                        "risk_score": round(rt, 4),
                        "ward_id": ward_id,
                        "s2_cell": s2_cell,
                        "triggers": triggers,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }

                    await producer.send_and_wait(
                        "claim-events",
                        value=risk_event,
                        key=worker_id.encode(),
                    )
                    logger.info(f"🚨 RiskEvent emitted: {worker_id} Rt={rt:.4f} > {RISK_THRESHOLD}")

                # Also emit RT_UPDATE for WebSocket broadcast
                rt_update = {
                    "type": "RT_UPDATE",
                    "worker_id": worker_id,
                    "score": round(rt, 4),
                    "zone": ward_id,
                    "s2_cell": s2_cell,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                await producer.send_and_wait(
                    "claim-events",
                    value=rt_update,
                    key=worker_id.encode(),
                )

            except Exception as e:
                logger.error(f"Error processing telemetry: {e}")

    finally:
        await consumer.stop()
        await producer.stop()
        await redis_client.close()


if __name__ == "__main__":
    asyncio.run(main())
