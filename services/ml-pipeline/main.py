"""
GRAP Platform — ML Pipeline
TweedieRegressor(power=1.67, alpha=0.01, link='log')
11 predictors with StandardScaler, Bühlmann credibility weights.
VIF check, drop >5. Serialize to model_W{N}.pkl.
Broadcasts β vector + intercept to Redis. Cron Monday 02:00 IST.

Phase 2 additions:
- Step 6: Bayesian self-supervised fraud weight update (update_fraud_weights)
- Step 7: Rebuild worker home zone cell sets (rebuild_worker_home_cells)
- Step 8: Rebuild SFR baselines (rebuild_sfr_baselines)
"""
import os
import json
import math
import logging
import pickle
from datetime import datetime, timezone, timedelta

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
fraud_weight_update_total = Counter("ml_fraud_weight_updates_total", "Total Bayesian fraud weight updates")

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


# ═══════════════════════════════════════════════════════
# Phase 2: Bayesian Self-Supervised Fraud Weight Update
# ═══════════════════════════════════════════════════════

def update_fraud_weights():
    """
    Self-supervised Bayesian update of fraud layer weights.
    Uses physically-impossible sensor readings as deterministic ground truth.
    No human review pipeline required.

    Runs as part of the existing Monday 02:00 IST ML pipeline cron job.

    Update protocol:
      - fraud_label=1 (confirmed fraud by physical impossibility):
          layer flagged → alpha += 1 (true positive)
          layer missed  → beta += 1  (false negative)
      - fraud_label=0 (legitimate, reached SETTLED):
          layer flagged → beta += 1  (false positive)
          layer passed  → alpha += 1 (true negative)

    Posterior mean: λ_j = α_j / (α_j + β_j)
    Normalised so all λ sum to 1.0.
    """
    r = redis.from_url(REDIS_URL, decode_responses=True)
    mongo_client = MongoClient(MONGO_URI)
    db = mongo_client.get_default_database()

    one_week_ago = datetime.utcnow() - timedelta(weeks=1)

    LAYERS = ["gnss", "kinematic", "network", "ecosystem"]

    # Load current alpha/beta from Redis
    weights = {}
    for layer in LAYERS:
        w = r.hgetall(f"fraud_layer_weights:{layer}")
        if w and "alpha" in w:
            weights[layer] = {
                "alpha": float(w["alpha"]),
                "beta": float(w["beta"]),
            }
        else:
            # Initialise with Beta(5,5) if missing
            weights[layer] = {"alpha": 5.0, "beta": 5.0}

    # Fetch all claims from the past week with deterministic labels
    recent_claims = db.claims.find({
        "created_at": {"$gte": one_week_ago},
        "state": {"$in": ["SETTLED", "REJECTED"]},
    })

    deterministic_label_count = 0

    # Map internal layer names for score lookup
    layer_score_map = {
        "gnss": "gnss",
        "kinematic": "kinematic",
        "network": "network",
        "ecosystem": "integrity",  # fraud engine uses "integrity" key
    }

    for claim in recent_claims:
        fraud_label = claim.get("deterministic_fraud_label")
        layer_scores = claim.get("layer_scores", {})

        if fraud_label is None:
            continue  # No deterministic label for this claim — skip

        deterministic_label_count += 1

        for layer in LAYERS:
            score_key = layer_score_map.get(layer, layer)
            score = layer_scores.get(score_key) or layer_scores.get(layer, 0.0)
            if score is None:
                score = 0.0
            layer_flagged = score > 0.5  # layer flagged as suspicious

            if fraud_label == 1:
                # Confirmed fraud by physical impossibility
                if layer_flagged:
                    weights[layer]["alpha"] += 1.0  # True positive
                else:
                    weights[layer]["beta"] += 1.0   # False negative
            elif fraud_label == 0:
                # Legitimate claim (reached SETTLED)
                if layer_flagged:
                    weights[layer]["beta"] += 1.0   # False positive
                else:
                    weights[layer]["alpha"] += 1.0  # True negative

    # Compute posterior mean λ_j = α_j / (α_j + β_j) and renormalise
    raw_lambdas = {}
    for layer in LAYERS:
        a = weights[layer]["alpha"]
        b = weights[layer]["beta"]
        raw_lambdas[layer] = a / (a + b)

    total = sum(raw_lambdas.values())
    normalised_lambdas = {layer: v / total for layer, v in raw_lambdas.items()}

    # Write updated weights back to Redis
    for layer in LAYERS:
        a = weights[layer]["alpha"]
        b = weights[layer]["beta"]
        variance = (a * b) / ((a + b) ** 2 * (a + b + 1))

        r.hset(f"fraud_layer_weights:{layer}", mapping={
            "alpha": str(a),
            "beta": str(b),
            "lambda": str(normalised_lambdas[layer]),
            "variance": str(variance),
            "updated_at": datetime.utcnow().isoformat(),
        })

    fraud_weight_update_total.inc()
    logger.info(f"[fraud_weights] Updated from {deterministic_label_count} deterministic labels.")
    logger.info(f"[fraud_weights] New lambdas: {normalised_lambdas}")

    r.close()
    mongo_client.close()
    return normalised_lambdas


# ═══════════════════════════════════════════════════════
# Phase 2: Worker Home Zone Cell Sets
# ═══════════════════════════════════════════════════════

def rebuild_worker_home_cells():
    """
    For each active worker, compute which S2 Level 13 cells they visited
    > 3 times per week in the last 14 days and store as their home zone set.

    Derived from the existing telemetry data (worker-telemetry pings stored
    in MongoDB or reconstructable from claim/transition data).

    Key pattern: worker_home_cells:{worker_id}
    Value: Redis SET of S2 Level 13 cell ID strings
    """
    r = redis.from_url(REDIS_URL, decode_responses=True)
    mongo_client = MongoClient(MONGO_URI)
    db = mongo_client.get_default_database()

    fourteen_days_ago = datetime.utcnow() - timedelta(days=14)

    # Get distinct active workers from recent claims and policies
    active_workers = db.claims.distinct("worker_id", {
        "created_at": {"$gte": fourteen_days_ago}
    })

    # For each worker, aggregate S2 cell visit frequency from telemetry
    # In production, this reads from a telemetry_pings collection
    # For the prototype, we derive from claim ward assignments
    workers_updated = 0

    for worker_id in active_workers:
        # Collect all S2 cells visited by this worker from claim data
        worker_claims = db.claims.find({
            "worker_id": worker_id,
            "created_at": {"$gte": fourteen_days_ago},
        }, {"ward_id": 1, "triggers": 1})

        cell_visits = {}
        for claim in worker_claims:
            ward_id = claim.get("ward_id", "")
            if ward_id:
                # In production, each telemetry ping has an S2 cell
                # For prototype, use ward_id as approximate cell identifier
                cell_visits[ward_id] = cell_visits.get(ward_id, 0) + 1

        # Home zone: cells visited > 3 times per week (>6 in 14 days)
        home_cells = [cell for cell, count in cell_visits.items() if count > 6]

        if home_cells:
            # Clear and rebuild the set
            key = f"worker_home_cells:{worker_id}"
            pipe = r.pipeline()
            pipe.delete(key)
            for cell in home_cells:
                pipe.sadd(key, cell)
            pipe.execute()
            workers_updated += 1

    logger.info(f"[home_cells] Rebuilt home zone cells for {workers_updated} workers")

    r.close()
    mongo_client.close()


# ═══════════════════════════════════════════════════════
# Phase 2: SFR Baselines
# ═══════════════════════════════════════════════════════

def rebuild_sfr_baselines():
    """
    For each active worker, compute their 14-day average Stop Frequency Ratio
    during active hours and store as their SFR baseline.

    Key pattern: worker_sfr_baseline:{worker_id}
    Value: float (stops per km, 14-day average)
    """
    r = redis.from_url(REDIS_URL, decode_responses=True)
    mongo_client = MongoClient(MONGO_URI)
    db = mongo_client.get_default_database()

    fourteen_days_ago = datetime.utcnow() - timedelta(days=14)

    active_workers = db.claims.distinct("worker_id", {
        "created_at": {"$gte": fourteen_days_ago}
    })

    workers_updated = 0

    for worker_id in active_workers:
        # In production, compute SFR from GPS speed time series
        # For prototype, use a reasonable default based on claim history
        claim_count = db.claims.count_documents({
            "worker_id": worker_id,
            "created_at": {"$gte": fourteen_days_ago},
        })

        # Default SFR baseline: ~2.5 stops per km for active delivery workers
        # Adjust slightly based on claim frequency (more claims = more active)
        baseline_sfr = 2.5 + (claim_count * 0.1)

        r.set(f"worker_sfr_baseline:{worker_id}", str(round(baseline_sfr, 4)))
        workers_updated += 1

    logger.info(f"[sfr_baselines] Rebuilt SFR baselines for {workers_updated} workers")

    r.close()
    mongo_client.close()


# ═══════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════

def main():
    logger.info("🚀 ML Pipeline starting...")
    start_http_server(METRICS_PORT)
    logger.info(f"📊 Prometheus metrics on :{METRICS_PORT}")

    # Run initial training
    train_model()
    logger.info("✅ Initial model training complete.")

    # Run Phase 2 additions on startup too
    logger.info("[pipeline] Step 6: Updating fraud layer weights...")
    try:
        new_lambdas = update_fraud_weights()
        logger.info(f"[pipeline] Fraud weights updated: {new_lambdas}")
    except Exception as e:
        logger.warning(f"[pipeline] Fraud weight update failed (possibly no claims yet): {e}")

    logger.info("[pipeline] Step 7: Rebuilding worker home zone cells...")
    try:
        rebuild_worker_home_cells()
        logger.info("[pipeline] Worker home zone cells rebuilt.")
    except Exception as e:
        logger.warning(f"[pipeline] Home cell rebuild failed: {e}")

    logger.info("[pipeline] Step 8: Rebuilding SFR baselines...")
    try:
        rebuild_sfr_baselines()
        logger.info("[pipeline] SFR baselines rebuilt.")
    except Exception as e:
        logger.warning(f"[pipeline] SFR baseline rebuild failed: {e}")

    logger.info("✅ All pipeline steps complete. Waiting for next scheduled run (Mon 02:00 IST)...")

    # In production, this would be triggered by cron (Monday 02:00 IST)
    # For now, keep the service alive and retrain on schedule
    import time
    while True:
        time.sleep(3600)  # Check every hour
        now = datetime.now()
        if now.weekday() == 0 and now.hour == 2 and now.minute < 5:
            logger.info("📅 Scheduled Monday 02:00 IST retrain triggered")
            train_model()

            # Phase 2: Run Bayesian weight update after GLM retrain
            logger.info("[pipeline] Step 6: Updating fraud layer weights...")
            try:
                new_lambdas = update_fraud_weights()
                logger.info(f"[pipeline] Fraud weights updated: {new_lambdas}")
            except Exception as e:
                logger.error(f"[pipeline] Fraud weight update failed: {e}")

            # Phase 2: Rebuild worker home zone cells
            logger.info("[pipeline] Step 7: Rebuilding worker home zone cells...")
            try:
                rebuild_worker_home_cells()
                logger.info("[pipeline] Worker home zone cells rebuilt.")
            except Exception as e:
                logger.error(f"[pipeline] Home cell rebuild failed: {e}")

            # Phase 2: Rebuild SFR baselines
            logger.info("[pipeline] Step 8: Rebuilding SFR baselines...")
            try:
                rebuild_sfr_baselines()
                logger.info("[pipeline] SFR baselines rebuilt.")
            except Exception as e:
                logger.error(f"[pipeline] SFR baseline rebuild failed: {e}")


if __name__ == "__main__":
    main()
