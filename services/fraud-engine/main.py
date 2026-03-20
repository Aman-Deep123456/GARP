"""
GRAP Platform — Fraud Engine
4-layer composite fraud scoring: F = Σλⱼ·sⱼ, reject if F > 0.75

Layer 1 (λ=0.30): GNSS spoofing sigmoid  s_gnss = σ(γ₁·(-ΔAGC) + γ₂·ΔC/N₀ - b)
Layer 2 (λ=0.35): FFT kinematic           s_kin = 1 - (E_low+E_mid)/(E_total+ε)
Layer 3 (λ=0.20): OpenCelliD network      s_net = min(d_GPS-tower/3km, 1)
Layer 4 (λ=0.15): Play Integrity binary
Absent layer weight redistributed proportionally.
"""
import os
import json
import math
import logging
import asyncio
import numpy as np
from datetime import datetime, timezone

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from prometheus_client import start_http_server, Counter, Histogram

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("fraud-engine")

# ── Config ────────────────────────────────────────────
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
REJECT_THRESHOLD = float(os.getenv("FRAUD_REJECT_THRESHOLD", "0.75"))
METRICS_PORT = int(os.getenv("METRICS_PORT", "8003"))

# Default layer weights
DEFAULT_WEIGHTS = {
    "gnss": 0.30,
    "kinematic": 0.35,
    "network": 0.20,
    "integrity": 0.15,
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

# Prometheus metrics
fraud_checks_total = Counter("fraud_checks_total", "Total fraud checks performed")
fraud_rejections_total = Counter("fraud_rejections_total", "Total fraud rejections")
fraud_score_hist = Histogram("fraud_score", "Fraud score distribution", buckets=[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1.0])


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


def compute_kinematic_score(accelerometer_data: dict) -> float | None:
    """
    Layer 2: FFT kinematic analysis.
    s_kin = 1 - (E_Blow + E_Bmid) / (E_total + ε)
    FFT: L=256, fs=50Hz, Hann window, Blow=0.5-3Hz, Bmid=3-8Hz
    """
    if not accelerometer_data:
        return None

    samples = accelerometer_data.get("samples", [])
    if len(samples) < FFT_LENGTH:
        # Not enough samples, use magnitude of current reading
        x = accelerometer_data.get("x", 0)
        y = accelerometer_data.get("y", 0)
        z = accelerometer_data.get("z", 0)
        magnitude = math.sqrt(x**2 + y**2 + z**2)
        # Heuristic: very low or very high magnitude is suspicious
        if magnitude < 0.5 or magnitude > 25.0:
            return 0.8
        return 0.2

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

    score = 1.0 - (e_low + e_mid) / e_total
    return float(np.clip(score, 0.0, 1.0))


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
    """
    if not device_data:
        return None

    token = device_data.get("integrity_token")
    if token is None:
        return None

    # Binary: valid token = 0, invalid = 1
    # In production, verify with Google Play Integrity API
    return 0.0 if token and len(token) > 10 else 1.0


def redistribute_weights(scores: dict) -> dict:
    """
    Redistribute weights proportionally when layer is absent.
    """
    available = {k: v for k, v in scores.items() if v is not None}

    if not available:
        return {}

    total_available_weight = sum(DEFAULT_WEIGHTS[k] for k in available)

    weights = {}
    for layer in available:
        weights[layer] = DEFAULT_WEIGHTS[layer] / total_available_weight

    return weights


def compute_composite_score(event: dict) -> tuple[float, dict]:
    """
    Compute composite fraud score: F = Σλⱼ·sⱼ
    Returns (score, details dict).
    """
    # Compute individual layer scores
    layer_scores = {
        "gnss": compute_gnss_score(event.get("gnss")),
        "kinematic": compute_kinematic_score(event.get("accelerometer")),
        "network": compute_network_score(event.get("network"), event.get("location")),
        "integrity": compute_integrity_score(event.get("device")),
    }

    # Redistribute weights for absent layers
    weights = redistribute_weights(layer_scores)

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

    return round(F, 4), details


async def main():
    logger.info("🚀 Fraud Engine starting...")
    start_http_server(METRICS_PORT)
    logger.info(f"📊 Prometheus metrics on :{METRICS_PORT}")

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

                logger.info(f"🔍 Processing fraud check for claim {claim_id}")
                fraud_checks_total.inc()

                # Compute composite fraud score
                F, details = compute_composite_score(event)
                fraud_score_hist.observe(F)

                verdict = "FAIL" if F > REJECT_THRESHOLD else "PASS"

                if verdict == "FAIL":
                    fraud_rejections_total.inc()

                result = {
                    "claim_id": claim_id,
                    "worker_id": worker_id,
                    "verdict": verdict,
                    "fraud_score": F,
                    "threshold": REJECT_THRESHOLD,
                    "layers": details,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }

                # Publish verdict back to fraud-signals (consumed by DFA engine)
                await producer.send_and_wait(
                    "fraud-signals",
                    value=result,
                    key=worker_id.encode() if worker_id else None,
                )

                logger.info(f"  {'🚫' if verdict == 'FAIL' else '✅'} Claim {claim_id}: F={F:.4f} → {verdict}")

            except Exception as e:
                logger.error(f"Error processing fraud signal: {e}")

    finally:
        await consumer.stop()
        await producer.stop()


if __name__ == "__main__":
    asyncio.run(main())
