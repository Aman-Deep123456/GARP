"""
GRAP Platform — Data Seeder
Inserts 500 workers across 5 Mumbai wards into MongoDB.
Seeds Redis with ward:s2:{wardId} S2 cell mappings.
"""
import os
import json
import random
import string
import logging
from datetime import datetime, timedelta

from pymongo import MongoClient
import redis

logging.basicConfig(level="INFO")
logger = logging.getLogger("seed")

MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongodb:27017/grap")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")

# 5 Mumbai wards
WARDS = {
    "MUM_KURLA_W12": {
        "name": "Kurla West",
        "center": {"lat": 19.0726, "lon": 72.8793},
        "elevation": 12,
        "flood_freq_3yr": 4,
        "order_density": 380,
        "restaurant_cluster": 145,
    },
    "MUM_ANDHERI_W58": {
        "name": "Andheri West",
        "center": {"lat": 19.1197, "lon": 72.8464},
        "elevation": 8,
        "flood_freq_3yr": 2,
        "order_density": 420,
        "restaurant_cluster": 190,
    },
    "MUM_BANDRA_W43": {
        "name": "Bandra West",
        "center": {"lat": 19.0544, "lon": 72.8402},
        "elevation": 15,
        "flood_freq_3yr": 1,
        "order_density": 350,
        "restaurant_cluster": 160,
    },
    "MUM_DADAR_W25": {
        "name": "Dadar",
        "center": {"lat": 19.0178, "lon": 72.8478},
        "elevation": 10,
        "flood_freq_3yr": 3,
        "order_density": 300,
        "restaurant_cluster": 120,
    },
    "MUM_POWAI_W91": {
        "name": "Powai",
        "center": {"lat": 19.1176, "lon": 72.9061},
        "elevation": 45,
        "flood_freq_3yr": 1,
        "order_density": 220,
        "restaurant_cluster": 85,
    },
}

FIRST_NAMES = [
    "Rajesh", "Amit", "Sanjay", "Pradeep", "Suresh", "Vikram", "Anil", "Ravi",
    "Deepak", "Manoj", "Ramesh", "Sunil", "Vijay", "Ashok", "Dinesh", "Mahesh",
    "Ganesh", "Rakesh", "Yogesh", "Naresh", "Mukesh", "Umesh", "Hitesh", "Jitesh",
    "Nilesh", "Alpesh", "Bhavesh", "Darshan", "Kiran", "Mohan", "Sachin", "Tushar",
    "Vishal", "Ajay", "Nitin", "Pankaj", "Rahul", "Rohit", "Sandeep", "Vivek",
]

LAST_NAMES = [
    "Sharma", "Patel", "Singh", "Kumar", "Verma", "Gupta", "Yadav", "Joshi",
    "Mishra", "Pandey", "Tiwari", "Dubey", "Srivastava", "Chauhan", "Thakur",
    "Rawat", "Nair", "Menon", "Pillai", "Reddy", "Naidu", "Rajan", "Das",
    "Ghosh", "Bose", "Dey", "Sen", "Roy", "Mukherjee", "Banerjee",
]


def generate_s2_cells(lat: float, lon: float, n: int = 50) -> list:
    """Generate a grid of S2 Level 13 cell IDs around a center point."""
    grid_res = 0.0087  # ~0.97km
    cells = []
    offset_range = int(n**0.5 / 2) + 1
    for di in range(-offset_range, offset_range + 1):
        for dj in range(-offset_range, offset_range + 1):
            clat = round((lat + di * grid_res) / grid_res) * grid_res
            clon = round((lon + dj * grid_res) / grid_res) * grid_res
            cell_id = f"S2L13_{clat:.4f}_{clon:.4f}"
            cells.append(cell_id)
            if len(cells) >= n:
                return sorted(cells)
    return sorted(cells)


def seed_workers(db):
    """Seed 500 workers across 5 Mumbai wards."""
    workers = []
    ward_ids = list(WARDS.keys())

    for i in range(500):
        ward_id = ward_ids[i % len(ward_ids)]
        ward = WARDS[ward_id]
        worker_id = f"GIG_{str(i + 1).zfill(4)}"

        worker = {
            "worker_id": worker_id,
            "name": f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}",
            "phone": f"+91{random.randint(7000000000, 9999999999)}",
            "email": f"{worker_id.lower()}@grap.demo",
            "platform": random.choice(["zomato", "swiggy", "both"]),
            "ward_id": ward_id,
            "city": "Mumbai",
            "vehicle_type": random.choice(["bicycle", "motorcycle", "scooter"]),
            "tenure_weeks": random.randint(1, 104),
            "avg_deliv_dist_km": round(random.uniform(1.5, 8.0), 2),
            "peak_hour_share": round(random.uniform(0.15, 0.85), 2),
            "productivity_score": round(random.uniform(0.3, 0.95), 2),
            "hist_disrupt_days_52wk": random.randint(0, 20),
            "policy": {
                "active": True,
                "weekly_premium": round(random.uniform(12, 55), 2),
                "sum_insured": random.choice([2000, 2500, 3000, 3500]),
                "start_date": datetime.now() - timedelta(weeks=random.randint(0, 52)),
                "end_date": datetime.now() + timedelta(weeks=random.randint(12, 52)),
            },
            "telemetry_paused": False,
            "erasure_requested": False,
            "created_at": datetime.now() - timedelta(weeks=random.randint(0, 52)),
            "updated_at": datetime.now(),
        }
        workers.append(worker)

    # Ensure GIG_0001 is in Kurla with specific policy for demo
    workers[0]["ward_id"] = "MUM_KURLA_W12"
    workers[0]["policy"]["sum_insured"] = 2500
    workers[0]["policy"]["weekly_premium"] = 28

    # Clear existing workers
    db.workers.delete_many({})
    result = db.workers.insert_many(workers)
    logger.info(f"✅ Inserted {len(result.inserted_ids)} workers into MongoDB")


def seed_redis(r):
    """Seed Redis with S2 cell mappings and initial ward risk data."""
    for ward_id, ward in WARDS.items():
        # Generate and store S2 cells for each ward
        cells = generate_s2_cells(ward["center"]["lat"], ward["center"]["lon"], 50)
        r.set(f"ward:s2:{ward_id}", json.dumps(cells))
        logger.info(f"  📍 {ward_id}: {len(cells)} S2 Level 13 cells seeded")

        # Set initial ward risk data
        r.hset(f"ward_risk:{ward_id}", mapping={
            "rain_normalized": "0.10",
            "flood_normalized": "0.0",
            "aqi_normalized": "0.15",
            "w_rain": "0.60",
            "w_aqi": "0.15",
            "w_ops": "0.15",
            "updated_at": datetime.now().isoformat(),
        })
        r.expire(f"ward_risk:{ward_id}", 600)

    # Initialize model coefficients (placeholder)
    r.hset("model:current_coeffs", mapping={
        "Rain_mm": "0.0823",
        "Elev_ward": "0.0412",
        "AQI_ward": "0.0651",
        "FloodFreq_3yr": "0.1234",
        "OrderDensity_zone": "-0.0189",
        "RestaurantCluster_zone": "-0.0098",
        "AvgDelivDist_i": "0.0345",
        "PeakHourShare_i": "0.0892",
        "WorkerProductivity_i": "-0.0456",
        "HistDisruptDays_i_52wk": "0.0567",
        "TenureWeeks_i": "-0.0234",
    })
    r.set("model:intercept", "2.8541")
    logger.info("  📊 Model coefficients seeded in Redis")


def main():
    logger.info("🌱 GRAP Data Seeder starting...")

    # MongoDB
    client = MongoClient(MONGO_URI)
    db = client.get_database()
    seed_workers(db)

    # Redis
    r = redis.from_url(REDIS_URL, decode_responses=True)
    seed_redis(r)

    logger.info("✅ Seeding complete!")
    client.close()
    r.close()


if __name__ == "__main__":
    main()
