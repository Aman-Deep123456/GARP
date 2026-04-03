"""
GRAP Platform — Flink Risk Scoring Job (Standalone Python version)
Consumes worker-telemetry from Kafka, computes EMA risk score per worker.
keyBy(workerId), NOT wardId — EMA state Rt is per-worker history.

Rt = α·Rt₋₁ + (1−α)·Σwᵢ·Tᵢ
α = 0.30

Emits RiskEvent to claim-events when Rt > 0.85.

Phase 2 additions:
- KDI Aggregator: geofence-level Kinematic Divergence Index (keyed by ward_id)
- EKCT: Environmental-Kinematic Coherence Test for zone-wide suppression
- Physical Impossibility Detector: C_vel, C_spec, C_tele per worker
- SFR Accumulator: Stop Frequency Ratio per worker
- GRI Accumulator: Geofence Return Index per worker
- AE Accumulator: Acceleration Entropy per worker
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

# ── KDI Aggregator State (per ward) ──────────────────
# Map: ward_id → { locomotion_sum: float, worker_count: int, last_tick: float }
ward_kdi_state = {}

# ── Physical Impossibility Detector State (per worker) ─
# Map: worker_id → { ping_buffer, prev_s2_id, worker_baseline }
worker_impossibility_state = {}

# ── SFR Accumulator State (per worker) ───────────────
# Map: worker_id → { stop_count, distance_km, consecutive_low_speed, sfr_baseline }
worker_sfr_state = {}

# ── GRI Accumulator State (per worker) ───────────────
# Map: worker_id → { total_pings, home_pings }
worker_gri_state = {}

# ── AE Accumulator State (per worker) ────────────────
# Map: worker_id → { bin_counts, ae_baseline }
worker_ae_state = {}

# ── KDI Baseline State (per ward per hour) ───────────
# Map: (ward_id, hour) → baseline_value
ward_kdi_baselines = {}

# TTL for worker disruption state (2 hours)
WORKER_DISRUPTION_TTL = 7200


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


# ═══════════════════════════════════════════════════════
# Phase 2: KDI Aggregator (keyed by ward_id)
# ═══════════════════════════════════════════════════════

async def process_kdi_aggregation(redis_client, ward_id: str, e_locomotion: float, timestamp: str):
    """
    Aggregates per-worker E_locomotion values to geofence-level KDI.
    KDI_g(t) = E_locomotion_g(t) / E_baseline_g

    Uses in-memory state for accumulation between ticks,
    writes KDI to Redis ward_risk:{ward_id} hash.
    """
    now = datetime.now(timezone.utc)
    hour = now.hour

    # Initialise ward state if needed
    if ward_id not in ward_kdi_state:
        ward_kdi_state[ward_id] = {
            "locomotion_sum": 0.0,
            "worker_count": 0,
            "last_tick": now.timestamp(),
        }

    state = ward_kdi_state[ward_id]
    state["locomotion_sum"] += e_locomotion
    state["worker_count"] += 1

    # Compute KDI every 30 seconds (when enough time has elapsed)
    elapsed = now.timestamp() - state["last_tick"]
    if elapsed >= 30.0:
        count = state["worker_count"]
        if count == 0:
            return

        current_mean = state["locomotion_sum"] / count

        # Retrieve baseline for this hour from in-memory cache
        baseline_key = (ward_id, hour)
        baseline = ward_kdi_baselines.get(baseline_key, current_mean)

        # Exponential update of baseline (α=0.05 — slow-moving 14-day avg)
        new_baseline = 0.05 * current_mean + 0.95 * baseline
        ward_kdi_baselines[baseline_key] = new_baseline

        # Compute KDI
        kdi = current_mean / (new_baseline + 1e-9)

        # Write to Redis: ward_risk:{ward_id} HSET kdi {value}
        await redis_client.hset(f"ward_risk:{ward_id}", mapping={
            "kdi": str(round(kdi, 6)),
            "kdi_updated_at": str(int(now.timestamp())),
        })

        # Also store baseline in Redis for persistence across restarts
        await redis_client.set(
            f"ward_kinematic_baseline:{ward_id}:{hour}",
            str(round(new_baseline, 6))
        )

        logger.debug(f"  KDI[{ward_id}] = {kdi:.4f} (mean={current_mean:.4f}, baseline={new_baseline:.4f})")

        # Reset accumulators for next tick
        state["locomotion_sum"] = 0.0
        state["worker_count"] = 0
        state["last_tick"] = now.timestamp()


async def check_ekct(redis_client) -> tuple[bool, float, float]:
    """
    Environmental-Kinematic Coherence Test.
    Returns: (ekct_pass, r_city, kdi_city)

    EKCT_pass iff R_city > 0.40 AND KDI_city < 0.30

    This is called ONLY when zone-wide OVA collapse is detected
    (i.e., OVA < 0.30 in ALL geofences simultaneously).
    """
    all_ward_keys = await redis_client.smembers("active_disrupted_wards")

    r_values = []
    kdi_values = []

    for ward_key in all_ward_keys:
        ward_data = await redis_client.hgetall(f"ward_risk:{ward_key}")
        if ward_data:
            r_values.append(float(ward_data.get("rain_normalized", 0)))
            kdi_values.append(float(ward_data.get("kdi", 0)))

    if not r_values:
        return False, 0.0, 0.0

    r_city = max(r_values)
    kdi_city = sum(kdi_values) / len(kdi_values)

    ekct_pass = (r_city > 0.40) and (kdi_city < 0.30)
    return ekct_pass, r_city, kdi_city


# ═══════════════════════════════════════════════════════
# Phase 2: Physical Impossibility Detector (keyed by worker_id)
# ═══════════════════════════════════════════════════════

async def detect_physical_impossibility(redis_client, producer, event: dict):
    """
    Detects physically impossible sensor combinations that serve as
    deterministic fraud ground truth labels.

    Class 1 — GPS-Accelerometer Velocity Contradiction (C_vel):
      C_vel = 1 iff v_GPS > 25 km/h AND v_accel_proxy < 2 km/h

    Class 2 — Spectral Energy Contradiction (C_spec):
      C_spec = 1 iff v_GPS > 15 km/h AND E_locomotion < 0.05 * E_baseline_worker

    Class 3 — Geofence Teleportation (C_tele):
      C_tele = 1 iff haversine(S2Cell(t), S2Cell(t-30s)) > 2 km
    """
    worker_id = event.get("worker_id")
    sensors = event.get("sensors", {})
    location = event.get("location", {})

    v_gps = sensors.get("speed", 0.0)  # km/h
    accel = sensors.get("accel", [0, 0, 0])  # [x, y, z] m/s²
    e_locomotion = event.get("e_locomotion", 0.0)
    s2_id = location.get("s2_id", "")
    timestamp = event.get("timestamp", datetime.now(timezone.utc).isoformat())

    # Initialise state if needed
    if worker_id not in worker_impossibility_state:
        worker_impossibility_state[worker_id] = {
            "worker_baseline": e_locomotion if e_locomotion > 0 else 1.0,
            "prev_s2_id": None,
            "ping_buffer": {"c_vel": [], "c_spec": [], "c_tele": []},
        }

    state = worker_impossibility_state[worker_id]

    # Update worker baseline: slow EMA, α=0.02
    baseline = state["worker_baseline"]
    new_baseline = 0.02 * e_locomotion + 0.98 * baseline
    state["worker_baseline"] = new_baseline

    # ── Class 1: GPS-Accelerometer Velocity Contradiction ─────────
    if isinstance(accel, list) and len(accel) >= 3:
        accel_magnitude = (accel[0]**2 + accel[1]**2 + accel[2]**2) ** 0.5
    else:
        accel_magnitude = 9.81  # assume gravity only
    # Subtract gravity: v_accel_proxy = max(0, |accel| - 9.81) × dt × 0.036 → km/h
    v_accel_proxy = max(0.0, (accel_magnitude - 9.81)) * 30 * 0.036
    c_vel = 1 if (v_gps > 25.0 and v_accel_proxy < 2.0) else 0

    # ── Class 2: Spectral Energy Contradiction ────────────────────
    c_spec = 1 if (v_gps > 15.0 and
                   e_locomotion < 0.05 * new_baseline and
                   new_baseline > 1e-6) else 0

    # ── Class 3: Geofence Teleportation ───────────────────────────
    prev_s2 = state["prev_s2_id"]
    c_tele = 0
    if prev_s2 is not None and s2_id and prev_s2:
        # Parse S2 cell IDs and compute approximate distance
        try:
            prev_parts = prev_s2.split("_")
            curr_parts = s2_id.split("_") if isinstance(s2_id, str) else []
            if len(prev_parts) >= 3 and len(curr_parts) >= 3:
                prev_lat, prev_lng = float(prev_parts[1]), float(prev_parts[2])
                curr_lat, curr_lng = float(curr_parts[1]), float(curr_parts[2])
                # Haversine approximation for short distances
                dlat = math.radians(curr_lat - prev_lat)
                dlng = math.radians(curr_lng - prev_lng)
                a = (math.sin(dlat / 2) ** 2 +
                     math.cos(math.radians(prev_lat)) *
                     math.cos(math.radians(curr_lat)) *
                     math.sin(dlng / 2) ** 2)
                c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                distance_km = 6371.0 * c  # Earth radius in km
                c_tele = 1 if distance_km > 2.0 else 0
        except (ValueError, IndexError):
            c_tele = 0

    state["prev_s2_id"] = s2_id

    # ── Accumulate contradiction counts in state ──────────────────
    ping_buffer = state["ping_buffer"]
    for key, val in [("c_vel", c_vel), ("c_spec", c_spec), ("c_tele", c_tele)]:
        ping_buffer[key].append(val)
        if len(ping_buffer[key]) > 10:
            ping_buffer[key].pop(0)  # keep last 10 pings

    # ── Emit deterministic fraud label if threshold met ───────────
    is_fraud = (
        sum(ping_buffer["c_vel"][-3:]) >= 3 or
        sum(ping_buffer["c_spec"][-3:]) >= 3 or
        c_tele == 1
    )

    if is_fraud:
        fraud_class = (
            "C_VEL" if sum(ping_buffer["c_vel"][-3:]) >= 3 else
            "C_SPEC" if sum(ping_buffer["c_spec"][-3:]) >= 3 else
            "C_TELE"
        )

        fraud_event = {
            "type": "DETERMINISTIC_FRAUD",
            "worker_id": worker_id,
            "deterministic_fraud_label": 1,
            "fraud_class": fraud_class,
            "v_gps": v_gps,
            "v_accel_proxy": round(v_accel_proxy, 4),
            "e_locomotion": e_locomotion,
            "e_baseline": round(new_baseline, 4),
            "c_vel": c_vel,
            "c_spec": c_spec,
            "c_tele": c_tele,
            "timestamp": timestamp,
        }

        await producer.send_and_wait(
            "fraud-signals",
            value=fraud_event,
            key=worker_id.encode() if worker_id else None,
        )
        logger.warning(f"🚨 Physical impossibility detected for {worker_id}: {fraud_class}")

        # Also store in Redis for claim processing
        await redis_client.hset(
            f"worker_disruption_state:{worker_id}",
            mapping={
                "deterministic_fraud_label": "1",
                "fraud_class": fraud_class,
            }
        )
        await redis_client.expire(f"worker_disruption_state:{worker_id}", WORKER_DISRUPTION_TTL)


# ═══════════════════════════════════════════════════════
# Phase 2: SFR Accumulator (keyed by worker_id)
# ═══════════════════════════════════════════════════════

async def process_sfr(redis_client, worker_id: str, speed: float):
    """
    Computes Stop Frequency Ratio per worker during disruption window.
    SFR_i(t) = (number of full stops) / (distance_travelled_km)

    Full stop: speed < 2 km/h for ≥ 2 consecutive pings (60s ≥ 45s threshold).
    """
    if worker_id not in worker_sfr_state:
        worker_sfr_state[worker_id] = {
            "stop_count": 0,
            "distance_km": 0.0,
            "consecutive_low_speed": 0,
            "sfr_baseline": None,
        }

    state = worker_sfr_state[worker_id]

    # Approximate distance: speed (km/h) × 30s / 3600 = km per ping
    distance_delta = speed * 30.0 / 3600.0
    state["distance_km"] += distance_delta

    # Full stop detection: speed < 2 km/h for ≥ 2 consecutive pings
    if speed < 2.0:
        state["consecutive_low_speed"] += 1
        if state["consecutive_low_speed"] == 2:  # 2 pings × 30s = 60s
            state["stop_count"] += 1
    else:
        state["consecutive_low_speed"] = 0

    # Compute current SFR
    dist = state["distance_km"]
    stops = state["stop_count"]
    current_sfr = stops / max(dist, 0.1)  # avoid division by zero

    # Update baseline: slow EMA α=0.03
    baseline = state["sfr_baseline"]
    if baseline is None:
        baseline = current_sfr
    new_baseline = 0.03 * current_sfr + 0.97 * baseline
    state["sfr_baseline"] = new_baseline

    sfr_ratio = current_sfr / max(new_baseline, 0.01)

    # Write to Redis for DFA to consume
    await redis_client.hset(
        f"worker_disruption_state:{worker_id}",
        "sfr_ratio", str(round(sfr_ratio, 6))
    )
    await redis_client.expire(f"worker_disruption_state:{worker_id}", WORKER_DISRUPTION_TTL)


# ═══════════════════════════════════════════════════════
# Phase 2: GRI Accumulator (keyed by worker_id)
# ═══════════════════════════════════════════════════════

async def process_gri(redis_client, worker_id: str, s2_id: str):
    """
    Geofence Return Index — fraction of disruption window in home zone.
    GRI_i(t) = (minutes in home zone S2 cells) / (total active minutes)
    """
    if worker_id not in worker_gri_state:
        worker_gri_state[worker_id] = {
            "total_pings": 0,
            "home_pings": 0,
        }

    state = worker_gri_state[worker_id]

    # Check if current cell is in worker's home zone
    in_home_zone = await redis_client.sismember(
        f"worker_home_cells:{worker_id}", str(s2_id)
    )

    state["total_pings"] += 1
    if in_home_zone:
        state["home_pings"] += 1

    gri = state["home_pings"] / max(state["total_pings"], 1)

    await redis_client.hset(
        f"worker_disruption_state:{worker_id}",
        "gri", str(round(gri, 6))
    )
    await redis_client.expire(f"worker_disruption_state:{worker_id}", WORKER_DISRUPTION_TTL)


# ═══════════════════════════════════════════════════════
# Phase 2: AE Accumulator (keyed by worker_id)
# ═══════════════════════════════════════════════════════

AE_BINS = [0, 2, 10, 25, 50, float("inf")]


async def process_ae(redis_client, worker_id: str, speed: float):
    """
    Acceleration Entropy — Shannon entropy of velocity bin distribution.
    AE_i(t) = -Σ_k [ p_k × log(p_k) ]

    Velocity bins: [0,2), [2,10), [10,25), [25,50), [50,∞)
    """
    if worker_id not in worker_ae_state:
        worker_ae_state[worker_id] = {
            "bin_counts": [0, 0, 0, 0, 0],
            "ae_baseline": None,
        }

    state = worker_ae_state[worker_id]

    # Determine bin
    bin_idx = 0
    for i in range(len(AE_BINS) - 1):
        if speed >= AE_BINS[i] and speed < AE_BINS[i + 1]:
            bin_idx = i
            break

    state["bin_counts"][bin_idx] += 1
    total = sum(state["bin_counts"])

    # Compute Shannon entropy
    ae = 0.0
    for count in state["bin_counts"]:
        if count > 0:
            p = count / total
            ae -= p * math.log(p)

    # Update baseline: slow EMA α=0.03
    baseline = state["ae_baseline"]
    if baseline is None:
        baseline = ae
    new_baseline = 0.03 * ae + 0.97 * baseline
    state["ae_baseline"] = new_baseline

    ae_ratio = ae / max(new_baseline, 1e-9)

    await redis_client.hset(
        f"worker_disruption_state:{worker_id}",
        "ae_ratio", str(round(ae_ratio, 6))
    )
    await redis_client.expire(f"worker_disruption_state:{worker_id}", WORKER_DISRUPTION_TTL)


# ═══════════════════════════════════════════════════════
# Main loop
# ═══════════════════════════════════════════════════════

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
                sensors = telemetry.get("sensors", {})
                lat = location.get("latitude", 0)
                lng = location.get("longitude", 0)
                speed = sensors.get("speed", 0.0)

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

                # ─── Phase 2: Run new aggregators in parallel ────────
                # Extract e_locomotion from telemetry (emitted by fraud engine)
                e_locomotion = telemetry.get("e_locomotion", speed * 0.1)

                # Enrich the telemetry event for physical impossibility detector
                enriched_event = {
                    **telemetry,
                    "e_locomotion": e_locomotion,
                    "location": {**location, "s2_id": s2_cell},
                    "sensors": sensors,
                }

                # Run all Phase 2 processors (non-blocking)
                await asyncio.gather(
                    process_kdi_aggregation(redis_client, ward_id, e_locomotion, telemetry.get("timestamp", "")),
                    detect_physical_impossibility(redis_client, producer, enriched_event),
                    process_sfr(redis_client, worker_id, speed),
                    process_gri(redis_client, worker_id, s2_cell),
                    process_ae(redis_client, worker_id, speed),
                    return_exceptions=True,
                )

            except Exception as e:
                logger.error(f"Error processing telemetry: {e}")

    finally:
        await consumer.stop()
        await producer.stop()
        await redis_client.close()


if __name__ == "__main__":
    asyncio.run(main())
