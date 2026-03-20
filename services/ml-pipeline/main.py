"""
GRAP Platform — ML Pipeline
TweedieRegressor(power=1.67, alpha=0.01, link='log')
11 predictors with StandardScaler, Bühlmann credibility weights.
VIF check, drop >5. Serialize to model_W{N}.pkl.
Broadcasts β vector + intercept to Redis. Cron Monday 02:00 IST.
"""
import os
import json
import math
import logging
import pickle
from datetime import datetime, timezone

import numpy as np
import redis
from pymongo import MongoClient
from sklearn.linear_model import TweedieRegressor
from sklearn.preprocessing import StandardScaler
from statsmodels.stats.outliers_influence import variance_inflation_factor
from prometheus_client import start_http_server, Counter, Gauge
import joblib

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger("ml-pipeline")

# ── Config ────────────────────────────────────────────
MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongodb:27017/grap")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")
TWEEDIE_POWER = float(os.getenv("TWEEDIE_POWER", "1.67"))
TWEEDIE_ALPHA = float(os.getenv("TWEEDIE_ALPHA", "0.01"))
VIF_THRESHOLD = float(os.getenv("VIF_THRESHOLD", "5.0"))
METRICS_PORT = int(os.getenv("METRICS_PORT", "8004"))

# 11 predictors
FEATURE_NAMES = [
    "Rain_mm",
    "Elev_ward",
    "AQI_ward",
    "FloodFreq_3yr",
    "OrderDensity_zone",
    "RestaurantCluster_zone",
    "AvgDelivDist_i",
    "PeakHourShare_i",
    "WorkerProductivity_i",
    "HistDisruptDays_i_52wk",
    "TenureWeeks_i",
]

# Prometheus metrics
train_cycles_total = Counter("ml_train_cycles_total", "Total model training cycles")
model_r2_gauge = Gauge("ml_model_r2", "Model R² score")
vif_dropped_features = Gauge("ml_vif_dropped_features", "Number of features dropped by VIF check")

# ── Bühlmann credibility ──────────────────────────────
# Zᵢ = nᵢ / (nᵢ + k), where nᵢ = number of claims for worker i
K_BUHLMANN = 50  # structural parameter


def compute_credibility_weights(worker_claims_counts: np.ndarray) -> np.ndarray:
    """
    Compute Bühlmann credibility weights.
    Zᵢ = nᵢ / (nᵢ + k)
    """
    return worker_claims_counts / (worker_claims_counts + K_BUHLMANN)


def vif_check(X: np.ndarray, feature_names: list) -> tuple[np.ndarray, list]:
    """
    VIF check at every retrain. Drop features with VIF > threshold.
    """
    remaining = list(range(X.shape[1]))
    remaining_names = list(feature_names)
    dropped = []

    while True:
        if len(remaining) <= 1:
            break

        X_sub = X[:, remaining]
        vifs = []
        for i in range(X_sub.shape[1]):
            try:
                vif = variance_inflation_factor(X_sub, i)
                vifs.append(vif)
            except Exception:
                vifs.append(0)

        max_vif = max(vifs)
        if max_vif <= VIF_THRESHOLD:
            break

        idx = vifs.index(max_vif)
        dropped_name = remaining_names[idx]
        dropped.append(dropped_name)
        remaining.pop(idx)
        remaining_names.pop(idx)
        logger.info(f"  🗑️  Dropped {dropped_name} (VIF={max_vif:.2f})")

    vif_dropped_features.set(len(dropped))
    return X[:, remaining] if remaining else X, remaining_names


def generate_synthetic_training_data(n_workers: int = 500) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Generate synthetic training data for demo purposes.
    In production, this would pull from MongoDB historical claims data.
    """
    np.random.seed(42)
    X = np.column_stack([
        np.random.exponential(15, n_workers),         # Rain_mm
        np.random.uniform(0, 100, n_workers),          # Elev_ward (meters)
        np.random.uniform(30, 400, n_workers),         # AQI_ward
        np.random.poisson(2, n_workers),               # FloodFreq_3yr
        np.random.uniform(50, 500, n_workers),         # OrderDensity_zone
        np.random.uniform(10, 200, n_workers),         # RestaurantCluster_zone
        np.random.uniform(1, 10, n_workers),           # AvgDelivDist_i (km)
        np.random.uniform(0.1, 0.9, n_workers),       # PeakHourShare_i
        np.random.uniform(0.3, 1.0, n_workers),       # WorkerProductivity_i
        np.random.poisson(5, n_workers),               # HistDisruptDays_i_52wk
        np.random.randint(1, 104, n_workers),          # TenureWeeks_i
    ])

    # Simulate premium target (Tweedie-distributed)
    linear_pred = (
        0.1 * X[:, 0] / 50 +  0.05 * X[:, 1] / 100 +
        0.08 * X[:, 2] / 300 + 0.15 * X[:, 3] +
        -0.02 * X[:, 4] / 500 + -0.01 * X[:, 5] / 200 +
        0.03 * X[:, 6] / 10 + 0.1 * X[:, 7] +
        -0.05 * X[:, 8] + 0.04 * X[:, 9] / 10 +
        -0.02 * X[:, 10] / 104
    )
    # Tweedie premium: ₹12-55/week
    mu = np.exp(2.8 + linear_pred)
    y = np.clip(mu + np.random.normal(0, 5, n_workers), 12, 55)

    # Credibility weights
    n_claims = np.random.poisson(10, n_workers).astype(float)
    z = compute_credibility_weights(n_claims)

    return X, y, z


def train_model():
    """Train Tweedie GLM and broadcast coefficients to Redis."""
    logger.info("🔄 Starting model training cycle...")
    train_cycles_total.inc()

    # Generate or fetch training data
    X_raw, y, credibility_weights = generate_synthetic_training_data()

    # StandardScaler
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_raw)

    # VIF check
    X_checked, remaining_features = vif_check(X_scaled, FEATURE_NAMES.copy())
    logger.info(f"  📊 Features after VIF: {remaining_features}")

    # Tweedie GLM
    model = TweedieRegressor(
        power=TWEEDIE_POWER,
        alpha=TWEEDIE_ALPHA,
        link="log",
        max_iter=1000,
    )

    # Fit with Bühlmann credibility weights (sample_weight = Zᵢ)
    model.fit(X_checked, y, sample_weight=credibility_weights)

    # Model evaluation
    y_pred = model.predict(X_checked)
    ss_res = np.sum(credibility_weights * (y - y_pred) ** 2)
    ss_tot = np.sum(credibility_weights * (y - np.average(y, weights=credibility_weights)) ** 2)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0
    model_r2_gauge.set(r2)
    logger.info(f"  📈 Model R² = {r2:.4f}")

    # Save model to file
    week_number = datetime.now().isocalendar()[1]
    model_path = f"/app/models/model_W{week_number}.pkl"
    os.makedirs("/app/models", exist_ok=True)
    joblib.dump({"model": model, "scaler": scaler, "features": remaining_features}, model_path)
    logger.info(f"  💾 Model saved to {model_path}")

    # Broadcast coefficients to Redis
    r = redis.from_url(REDIS_URL, decode_responses=True)

    # Store β coefficients
    coeffs = {}
    for i, feature in enumerate(remaining_features):
        coeffs[feature] = str(model.coef_[i] if i < len(model.coef_) else 0)
    r.hset("model:current_coeffs", mapping=coeffs)

    # Store intercept
    r.set("model:intercept", str(model.intercept_))

    # Store metadata
    r.hset("model:metadata", mapping={
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "r2_score": str(r2),
        "n_features": str(len(remaining_features)),
        "n_samples": str(len(y)),
        "power": str(TWEEDIE_POWER),
        "alpha": str(TWEEDIE_ALPHA),
        "week_number": str(week_number),
    })

    logger.info(f"  📡 Coefficients broadcast to Redis ({len(remaining_features)} features)")
    logger.info(f"  Intercept: {model.intercept_:.4f}")
    for feature, coeff in coeffs.items():
        logger.info(f"    β_{feature} = {float(coeff):.4f}")

    r.close()
    return model, scaler, remaining_features


def main():
    logger.info("🚀 ML Pipeline starting...")
    start_http_server(METRICS_PORT)
    logger.info(f"📊 Prometheus metrics on :{METRICS_PORT}")

    # Run initial training
    train_model()
    logger.info("✅ Initial model training complete. Waiting for next scheduled run (Mon 02:00 IST)...")

    # In production, this would be triggered by cron (Monday 02:00 IST)
    # For now, keep the service alive and retrain on schedule
    import time
    while True:
        time.sleep(3600)  # Check every hour
        now = datetime.now()
        if now.weekday() == 0 and now.hour == 2 and now.minute < 5:
            logger.info("📅 Scheduled Monday 02:00 IST retrain triggered")
            train_model()


if __name__ == "__main__":
    main()
