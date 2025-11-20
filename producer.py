import requests
import time
import json
import random
from kafka import KafkaProducer
from datetime import datetime, timedelta

KAFKA_SERVER = "localhost:9092"
TOPIC = "nyc_trips"

producer = KafkaProducer(
    bootstrap_servers=KAFKA_SERVER,
    value_serializer=lambda v: json.dumps(v).encode("utf-8")
)

# NYC Taxi Yellow Trip Data API
API_URL = "https://data.cityofnewyork.us/resource/gkne-dk5s.json?$limit=50&$offset=1500000"

# NYC geographic bounds
NYC_LAT_MIN, NYC_LAT_MAX = 40.55, 40.92
NYC_LNG_MIN, NYC_LNG_MAX = -74.15, -73.70

print("🚕 Simulating live NYC taxi stream to Kafka...")

while True:
    try:
        res = requests.get(API_URL)
        res.raise_for_status()
        trips = res.json()

        sent_count = 0

        for trip in random.sample(trips, k=min(100, len(trips))):
            try:
                pickup_lat = float(trip.get("pickup_latitude"))
                pickup_lng = float(trip.get("pickup_longitude"))
                dropoff_lat = trip.get("dropoff_latitude")
                dropoff_lng = trip.get("dropoff_longitude")

                if not pickup_lat or not pickup_lng:
                    continue

                pickup_lat = min(
                    max(pickup_lat + random.uniform(-0.002, 0.002), NYC_LAT_MIN), NYC_LAT_MAX)
                pickup_lng = min(
                    max(pickup_lng + random.uniform(-0.002, 0.002), NYC_LNG_MIN), NYC_LNG_MAX)

                if dropoff_lat and dropoff_lng:
                    dropoff_lat = min(
                        max(float(dropoff_lat) + random.uniform(-0.002, 0.002), NYC_LAT_MIN), NYC_LAT_MAX)
                    dropoff_lng = min(
                        max(float(dropoff_lng) + random.uniform(-0.002, 0.002), NYC_LNG_MIN), NYC_LNG_MAX)
                else:
                    dropoff_lat = dropoff_lng = None

                timestamp = (
                    datetime.now() - timedelta(seconds=random.randint(0, 5))).isoformat()

                msg = {
                    "pickup_lat": pickup_lat,
                    "pickup_lng": pickup_lng,
                    "dropoff_lat": dropoff_lat,
                    "dropoff_lng": dropoff_lng,
                    "timestamp": timestamp
                }

                producer.send(TOPIC, msg)
                sent_count += 1

            except ValueError:
                continue

        print(f"✅ Sent {sent_count} simulated trips")
        time.sleep(15)

    except Exception as e:
        print("⚠️ Error fetching or sending data:", e)
        time.sleep(10)
