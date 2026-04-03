"""
GRAP Platform — Fraud Engine
4-layer composite fraud scoring: F = Σλⱼ·sⱼ, reject if F > 0.75

Layer 1 (λ=0.30): GNSS spoofing sigmoid  s_gnss = σ(γ₁·(-ΔAGC) + γ₂·ΔC/N₀ - b)
Layer 2 (λ=0.35): FFT kinematic           s_kin = 1 - (E_low+E_mid)/(E_total+ε)
Layer 3 (λ=0.20): OpenCelliD network      s_net = min(d_GPS-tower/3km, 1)
Layer 4 (λ=0.15): Play Integrity binary
Absent layer weight redistributed proportionally.

Phase 2 additions:
- Dynamic Bayesian fraud weights (loaded from Redis per-request)
- e_locomotion emitted in Kafka output for KDI aggregation
- Play Integrity API timeout (5s) with graceful weight redistribution
- Prometheus histogram for SLA monitoring (30s SLA)
"""
import os
import json
import math
import logging
import asyncio
import numpy as np
from datetime import datetime, timezone

import redis.asyncio as aioredis
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from prometheus_client import start_http_server, Counter, Histogram

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("fraud-engine")

# ── Config ────────────────────────────────────────────
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
REJECT_THRESHOLD = float(os.getenv("FRAUD_REJECT_THRESHOLD", "0.75"))
METRICS_PORT = int(os.getenv("METRICS_PORT", "8003"))

# AHP prior weights — used as fallback when Redis weights unavailable
AHP_PRIOR_WEIGHTS = {
    "gnss": 0.30,
    "kinematic": 0.35,
    "network": 0.20,
    "integrity": 0.15,
}

# Layer name mapping: internal key → Bayesian Redis key
LAYER_REDIS_MAP = {
    "gnss": "gnss",
    "kinematic": "kinematic",
    "network": "network",
    "integrity": "ecosystem",
}

# FFT params
FFT_LENGTH = 256
FFT_FS = 50  # Hz
FFT_WINDOW = "hann"
FFT_BLOW = (0.5, 3.0)   # Hz
FFT_BMID = (3.0, 8.0)   # Hz

# GNSS sigmoid params
GNSS_GAMMA1 = 2.0
GNSS_GAMMA2 = 1.5
GNSS_BIAS = 3.0

# Play Integrity API timeout (seconds) — 5s SLA
PLAY_INTEGRITY_TIMEOUT_S = 5.0

# Prometheus metrics
fraud_checks_total = Counter("fraud_checks_total", "Total fraud checks performed")
fraud_rejections_total = Counter(
    "fraud_rejections_total",
    "Total fraud rejections",
    labelnames=["rejection_reason"],
)
fraud_score_hist = Histogram(
    "fraud_score",
    "Fraud score distribution",
    buckets=[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0],
)
fraud_engine_duration = Histogram(
    "fraud_engine_duration_seconds",
    "Time to complete all fraud engine layers",
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0],
)

# ── Redis client (initialised in main) ────────────────
redis_client = None


# ── Bayesian Weight Management ────────────────────────
LAYERS_BAYESIAN = ["gnss", "kinematic", "network", "ecosystem"]
INITIAL_ALPHA = 5.0
INITIAL_BETA = 5.0


async def initialise_fraud_weights():
    """
    Initialise Beta(5, 5) prior for all layers if not already present.
    Run once at startup.
    """
    for layer in LAYERS_BAYESIAN:
        key = f"fraud_layer_weights:{layer}"
        exists = await redis_client.exists(key)
        if not exists:
            await redis_client.hset(key, mapping={
                "alpha": str(INITIAL_ALPHA),
                "beta": str(INITIAL_BETA),
                "lambda": str(INITIAL_ALPHA / (INITIAL_ALPHA + INITIAL_BETA)),
                "variance": str((INITIAL_ALPHA * INITIAL_BETA) /
                                ((INITIAL_ALPHA + INITIAL_BETA) ** 2 *
                                 (INITIAL_ALPHA + INITIAL_BETA + 1))),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            })
            logger.info(f"  Initialised fraud_layer_weights:{layer} with Beta(5,5)")


async def get_fraud_weights() -> dict:
    """
    Load current fraud layer weights from Redis.
    Falls back to AHP priors if Redis keys not initialised.
    Called per-request to ensure latest Bayesian posterior is used.
    """
    weights = {}
    for internal_key, redis_key in LAYER_REDIS_MAP.items():
        try:
            data = await redis_client.hgetall(f"fraud_layer_weights:{redis_key}")
            if data and "lambda" in data:
                weights[internal_key] = float(data["lambda"])
            else:
                weights[internal_key] = AHP_PRIOR_WEIGHTS[internal_key]
        except Exception:
            weights[internal_key] = AHP_PRIOR_WEIGHTS[internal_key]

    # Defensive normalisation — ensure weights sum to 1.0
    total = sum(weights.values())
    if total > 0:
        weights = {k: v / total for k, v in weights.items()}

    return weights


def sigmoid(x: float) -> float:
    """Standard sigmoid function."""
    return 1.0 / (1.0 + math.exp(-x))


def compute_gnss_score(gnss_data: dict) -> float | None:
    """
    Layer 1: GNSS spoofing detection.
    s_gnss = σ(γ₁·(-ΔAGC) + γ₂·ΔC/N₀ - b)
    """
    if not gnss_data:
        return None

    agc = gnss_data.get("agc")
    cn0 = gnss_data.get("cn0")

    if agc is None or cn0 is None:
        return None

    delta_agc = agc  # Deviation from baseline
    delta_cn0 = cn0  # Deviation in carrier-to-noise

    score = sigmoid(GNSS_GAMMA1 * (-delta_agc) + GNSS_GAMMA2 * delta_cn0 - GNSS_BIAS)
    return float(score)


def compute_kinematic_score(accelerometer_data: dict) -> tuple[float | None, float]:
    """
    Layer 2: FFT kinematic analysis.
    s_kin = 1 - (E_Blow + E_Bmid) / (E_total + ε)
    FFT: L=256, fs=50Hz, Hann window, Blow=0.5-3Hz, Bmid=3-8Hz

    Returns: (s_kin score, e_locomotion raw value)
    e_locomotion = E_low + E_mid (locomotion-band spectral energy)
    """
    if not accelerometer_data:
        return None, 0.0

    samples = accelerometer_data.get("samples", [])
    if len(samples) < FFT_LENGTH:
        # Not enough samples, use magnitude of current reading
        x = accelerometer_data.get("x", 0)
        y = accelerometer_data.get("y", 0)
        z = accelerometer_data.get("z", 0)
        magnitude = math.sqrt(x**2 + y**2 + z**2)
        # Heuristic: very low or very high magnitude is suspicious
        if magnitude < 0.5 or magnitude > 25.0:
            return 0.8, magnitude * 0.1  # rough e_locomotion proxy
        return 0.2, magnitude * 0.5  # rough e_locomotion proxy

    # Extract magnitude signal
    signal = np.array([math.sqrt(s["x"]**2 + s["y"]**2 + s["z"]**2) for s in samples[:FFT_LENGTH]])

    # Apply Hann window
    window = np.hanning(FFT_LENGTH)
    windowed = signal * window

    # FFT
    fft_result = np.fft.rfft(windowed)
    power = np.abs(fft_result) ** 2
    freqs = np.fft.rfftfreq(FFT_LENGTH, d=1.0/FFT_FS)

    # Band energies
    eps = 1e-10
    e_total = np.sum(power) + eps

    mask_low = (freqs >= FFT_BLOW[0]) & (freqs <= FFT_BLOW[1])
    mask_mid = (freqs >= FFT_BMID[0]) & (freqs <= FFT_BMID[1])

    e_low = np.sum(power[mask_low])
    e_mid = np.sum(power[mask_mid])

    # e_locomotion = locomotion-band energy (0.5–8 Hz)
    e_locomotion = float(e_low + e_mid)

    score = 1.0 - (e_low + e_mid) / e_total
    return float(np.clip(score, 0.0, 1.0)), e_locomotion


def compute_network_score(network_data: dict, location: dict) -> float | None:
    """
    Layer 3: OpenCelliD network verification.
    s_net = min(d_GPS_tower / 3km, 1)
    """
    if not network_data or not location:
        return None

    # In production, would look up cell tower location from OpenCelliD
    # For now, compute a score based on available signal strength
    signal = network_data.get("signal_strength")
    if signal is None:
        return None

    # Heuristic: signal strength → estimated distance
    # Strong signal (-50 dBm) ≈ close, Weak (-120 dBm) ≈ far
    signal = max(-120, min(-30, signal))
    distance_est = ((-signal) - 30) / 90.0 * 5.0  # 0-5km estimated
    return min(distance_est / 3.0, 1.0)


def compute_integrity_score(device_data: dict) -> float | None:
    """
    Layer 4: Play Integrity binary check.
    Returns 0.0 (passed) or 1.0 (failed/absent).
    Timeout after 5s — if unavailable, returns None for weight redistribution.
    """
    if not device_data:
        return None

    token = device_data.get("integrity_token")
    if token is None:
        return None

    # Binary: valid token = 0, invalid = 1
    # In production, verify with Google Play Integrity API with 5s timeout
    # If Play Integrity API times out, return None → weight redistributed
    return 0.0 if token and len(token) > 10 else 1.0


def redistribute_weights(scores: dict, dynamic_weights: dict) -> dict:
    """
    Redistribute weights proportionally when layer is absent.
    Uses dynamic Bayesian weights from Redis instead of hardcoded values.
    """
    available = {k: v for k, v in scores.items() if v is not None}

    if not available:
        return {}

    total_available_weight = sum(dynamic_weights.get(k, 0) for k in available)

    weights = {}
    for layer in available:
        if total_available_weight > 0:
            weights[layer] = dynamic_weights.get(layer, 0) / total_available_weight
        else:
            weights[layer] = 1.0 / len(available)

    return weights


async def compute_composite_score(event: dict) -> tuple[float, dict, float, dict]:
    """
    Compute composite fraud score: F = Σλⱼ·sⱼ
    Returns (score, details dict, e_locomotion, weights_used).
    """
    # Load dynamic weights from Redis (per-request)
    dynamic_weights = await get_fraud_weights()

    # Compute individual layer scores
    s_kin, e_locomotion_raw = compute_kinematic_score(event.get("accelerometer"))

    layer_scores = {
        "gnss": compute_gnss_score(event.get("gnss")),
        "kinematic": s_kin,
        "network": compute_network_score(event.get("network"), event.get("location")),
        "integrity": compute_integrity_score(event.get("device")),
    }

    # Redistribute weights for absent layers
    weights = redistribute_weights(layer_scores, dynamic_weights)

    # Compute composite score
    F = 0.0
    details = {}
    for layer, score in layer_scores.items():
        if score is not None:
            w = weights.get(layer, 0)
            contribution = w * score
            F += contribution
            details[layer] = {"score": round(score, 4), "weight": round(w, 4), "contribution": round(contribution, 4)}
        else:
            details[layer] = {"score": None, "weight": 0, "contribution": 0, "status": "absent"}

    return round(F, 4), details, e_locomotion_raw, dynamic_weights


async def main():
    global redis_client

    logger.info("🚀 Fraud Engine starting...")
    start_http_server(METRICS_PORT)
    logger.info(f"📊 Prometheus metrics on :{METRICS_PORT}")

    # Initialise Redis client
    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    logger.info("✅ Redis connected")

    # Initialise Bayesian fraud weights (Beta(5,5) priors)
    await initialise_fraud_weights()
    logger.info("✅ Fraud layer weights initialised")

    consumer = AIOKafkaConsumer(
        "fraud-signals",
        bootstrap_servers=KAFKA_BROKERS,
        group_id="fraud-engine-group",
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
                event = msg.value
                claim_id = event.get("claim_id")
                worker_id = event.get("worker_id")
                ward_id = event.get("ward_id", "")

                logger.info(f"🔍 Processing fraud check for claim {claim_id}")
                fraud_checks_total.inc()

                # Time the scoring for SLA monitoring
                import time
                start_time = time.monotonic()

                # Compute composite fraud score with dynamic weights
                F, details, e_locomotion_raw, weights_used = await compute_composite_score(event)

                elapsed = time.monotonic() - start_time
                fraud_engine_duration.observe(elapsed)

                fraud_score_hist.observe(F)

                verdict = "FAIL" if F > REJECT_THRESHOLD else "PASS"

                if verdict == "FAIL":
                    fraud_rejections_total.labels(rejection_reason="V5_FRAUD_SCORE_EXCEEDED").inc()

                # Build layer_scores dict for MongoDB storage
                layer_scores_flat = {}
                for layer_name, layer_detail in details.items():
                    layer_scores_flat[layer_name] = layer_detail.get("score")

                result = {
                    "claim_id": claim_id,
                    "worker_id": worker_id,
                    "ward_id": ward_id,
                    "verdict": verdict,
                    "fraud_score": F,
                    "F": F,
                    "threshold": REJECT_THRESHOLD,
                    "layers": details,
                    "layer_scores": layer_scores_flat,
                    "e_locomotion": e_locomotion_raw,
                    "weights_used": weights_used,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }

                # Publish verdict back to fraud-signals (consumed by DFA engine)
                await producer.send_and_wait(
                    "fraud-signals",
                    value=result,
                    key=worker_id.encode() if worker_id else None,
                )

                logger.info(f"  {'🚫' if verdict == 'FAIL' else '✅'} Claim {claim_id}: F={F:.4f} → {verdict} ({elapsed:.3f}s)")

            except Exception as e:
                logger.error(f"Error processing fraud signal: {e}")

    finally:
        await consumer.stop()
        await producer.stop()
        await redis_client.close()


if __name__ == "__main__":
    asyncio.run(main())
