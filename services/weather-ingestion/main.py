"""
GRAP Platform — Weather Ingestion Service
Polls OpenWeather (rain mm/hr), Open-Meteo (flood: river_discharge>500 m³/s),
CPCB via API Setu (AQI) every 5 minutes.
Normalises and writes to Kafka + Redis.
"""
import os
import json
import time
import logging
import asyncio
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from aiokafka import AIOKafkaProducer
from prometheus_client import start_http_server, Counter, Gauge

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("weather-ingestion")

# ── Config ────────────────────────────────────────────
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")
OPENMETEO_BASE_URL = os.getenv("OPENMETEO_BASE_URL", "https://flood-api.open-meteo.com/v1/flood")
CPCB_API_KEY = os.getenv("CPCB_API_KEY", "")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL_SEC", "300"))
METRICS_PORT = int(os.getenv("METRICS_PORT", "8002"))
WARD_RISK_TTL = 600  # seconds

# ── Mumbai wards with coordinates ─────────────────────
MUMBAI_WARDS = {
    "MUM_KURLA_W12": {"lat": 19.0726, "lon": 72.8793, "name": "Kurla West"},
    "MUM_ANDHERI_W58": {"lat": 19.1197, "lon": 72.8464, "name": "Andheri West"},
    "MUM_BANDRA_W43": {"lat": 19.0544, "lon": 72.8402, "name": "Bandra West"},
    "MUM_DADAR_W25": {"lat": 19.0178, "lon": 72.8478, "name": "Dadar"},
    "MUM_POWAI_W91": {"lat": 19.1176, "lon": 72.9061, "name": "Powai"},
}

# ── Risk weights (default) ────────────────────────────
RISK_WEIGHTS = {
    "w_rain": 0.60,
    "w_aqi": 0.15,
    "w_flood": 0.10,
    "w_ops": 0.15,
}

# ── Prometheus metrics ────────────────────────────────
weather_polls_total = Counter("weather_polls_total", "Total weather poll cycles")
weather_errors_total = Counter("weather_errors_total", "Total weather poll errors", ["provider"])
rain_gauge = Gauge("rain_normalized", "Normalized rain value", ["ward_id"])
aqi_gauge = Gauge("aqi_normalized", "Normalized AQI value", ["ward_id"])

# ── Last-known values cache (for graceful API timeout) ──
last_known = {}


async def fetch_rain(client: httpx.AsyncClient, lat: float, lon: float) -> float:
    """Fetch rain mm/hr from OpenWeather. Returns raw mm/hr."""
    if not OPENWEATHER_API_KEY:
        return 0.0
    try:
        resp = await client.get(
            "https://api.openweathermap.org/data/2.5/weather",
            params={"lat": lat, "lon": lon, "appid": OPENWEATHER_API_KEY, "units": "metric"},
            timeout=10.0,
        )
        data = resp.json()
        return data.get("rain", {}).get("1h", 0.0)
    except Exception as e:
        logger.warning(f"OpenWeather fetch failed: {e}")
        weather_errors_total.labels(provider="openweather").inc()
        return None


async def fetch_flood(client: httpx.AsyncClient, lat: float, lon: float) -> float:
    """Fetch river discharge from Open-Meteo. Returns binary flood indicator."""
    try:
        resp = await client.get(
            OPENMETEO_BASE_URL,
            params={"latitude": lat, "longitude": lon, "daily": "river_discharge"},
            timeout=10.0,
        )
        data = resp.json()
        daily = data.get("daily", {}).get("river_discharge", [0])
        discharge = daily[0] if daily else 0
        return 1.0 if discharge > 500 else 0.0
    except Exception as e:
        logger.warning(f"Open-Meteo fetch failed: {e}")
        weather_errors_total.labels(provider="openmeteo").inc()
        return None


async def fetch_aqi(client: httpx.AsyncClient, lat: float, lon: float) -> float:
    """Fetch AQI from CPCB via API Setu. Returns raw AQI value."""
    if not CPCB_API_KEY:
        # Mock AQI for development
        import random
        return random.uniform(50, 250)
    try:
        resp = await client.get(
            "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69",
            params={"api-key": CPCB_API_KEY, "format": "json", "limit": 1},
            timeout=10.0,
        )
        data = resp.json()
        records = data.get("records", [])
        if records:
            return float(records[0].get("pollutant_avg", 100))
        return 100.0
    except Exception as e:
        logger.warning(f"CPCB fetch failed: {e}")
        weather_errors_total.labels(provider="cpcb").inc()
        return None


def normalize_rain(rain_mm: float) -> float:
    """Normalise: rain = min(R/50, 1)"""
    return min(rain_mm / 50.0, 1.0)


def normalize_aqi(aqi: float) -> float:
    """Normalise: AQI = min(A/300, 1)"""
    return min(aqi / 300.0, 1.0)


async def poll_and_update():
    """One poll cycle across all wards."""
    redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
    producer = AIOKafkaProducer(
        bootstrap_servers=KAFKA_BROKERS,
        value_serializer=lambda v: json.dumps(v).encode("utf-8"),
    )
    await producer.start()

    try:
        async with httpx.AsyncClient() as client:
            while True:
                logger.info("🌧️  Starting weather poll cycle...")
                weather_polls_total.inc()

                for ward_id, ward in MUMBAI_WARDS.items():
                    try:
                        # Fetch raw values
                        raw_rain = await fetch_rain(client, ward["lat"], ward["lon"])
                        raw_flood = await fetch_flood(client, ward["lat"], ward["lon"])
                        raw_aqi = await fetch_aqi(client, ward["lat"], ward["lon"])

                        # Use last-known values on timeout
                        if raw_rain is None:
                            raw_rain = last_known.get(f"{ward_id}_rain", 0.0)
                        else:
                            last_known[f"{ward_id}_rain"] = raw_rain

                        if raw_flood is None:
                            raw_flood = last_known.get(f"{ward_id}_flood", 0.0)
                        else:
                            last_known[f"{ward_id}_flood"] = raw_flood

                        if raw_aqi is None:
                            raw_aqi = last_known.get(f"{ward_id}_aqi", 100.0)
                        else:
                            last_known[f"{ward_id}_aqi"] = raw_aqi

                        # Normalize
                        rain_norm = normalize_rain(raw_rain)
                        aqi_norm = normalize_aqi(raw_aqi)
                        flood_norm = float(raw_flood)

                        # Update Prometheus gauges
                        rain_gauge.labels(ward_id=ward_id).set(rain_norm)
                        aqi_gauge.labels(ward_id=ward_id).set(aqi_norm)

                        # Write to Redis with 600s TTL
                        now_iso = datetime.now(timezone.utc).isoformat()
                        redis_hash = {
                            "rain_normalized": str(rain_norm),
                            "flood_normalized": str(flood_norm),
                            "aqi_normalized": str(aqi_norm),
                            "w_rain": str(RISK_WEIGHTS["w_rain"]),
                            "w_aqi": str(RISK_WEIGHTS["w_aqi"]),
                            "w_ops": str(RISK_WEIGHTS["w_ops"]),
                            "updated_at": now_iso,
                        }
                        await redis_client.hset(f"ward_risk:{ward_id}", mapping=redis_hash)
                        await redis_client.expire(f"ward_risk:{ward_id}", WARD_RISK_TTL)

                        # Publish to Kafka environmental-context
                        event = {
                            "ward_id": ward_id,
                            "rain_mm": raw_rain,
                            "rain_normalized": rain_norm,
                            "flood_normalized": flood_norm,
                            "aqi_raw": raw_aqi,
                            "aqi_normalized": aqi_norm,
                            "weights": RISK_WEIGHTS,
                            "timestamp": now_iso,
                        }
                        await producer.send_and_wait("environmental-context", value=event, key=ward_id.encode())

                        logger.info(
                            f"  ✅ {ward_id}: rain={rain_norm:.2f} flood={flood_norm:.1f} aqi={aqi_norm:.2f}"
                        )

                    except Exception as e:
                        logger.error(f"  ❌ Error processing ward {ward_id}: {e}")

                logger.info(f"💤 Sleeping {POLL_INTERVAL}s until next cycle...")
                await asyncio.sleep(POLL_INTERVAL)

    finally:
        await producer.stop()
        await redis_client.close()


def main():
    logger.info(f"🚀 Weather Ingestion Service starting (poll every {POLL_INTERVAL}s)")
    start_http_server(METRICS_PORT)
    logger.info(f"📊 Prometheus metrics on :{METRICS_PORT}")
    asyncio.run(poll_and_update())


if __name__ == "__main__":
    main()
