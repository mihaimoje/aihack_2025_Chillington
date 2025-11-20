import threading
import time
import json
from flask import Flask, jsonify, request
from flask_cors import CORS
import geopandas as gpd
from shapely.geometry import Point, LineString
from kafka import KafkaConsumer
import os
from groq import Groq
from dotenv import load_dotenv
import networkx as nx
import numpy as np
from shapely.ops import nearest_points
import math
from collections import deque
from openai import OpenAI


load_dotenv("./nyc-traffic/.env")
trip_window = deque()
app = Flask(__name__)
CORS(app)

client = Groq(api_key=os.getenv('GROQ_API_KEY'))

streets_file = "nyc_streets_simplified.geojson"
print(f"Loading streets from {streets_file}...")
streets_gdf = gpd.read_file(streets_file)

print("Reprojecting streets to UTM zone 18N for distance calculations...")
streets_gdf = streets_gdf.to_crs(epsg=32618)

lock = threading.Lock()

streets_gdf["pickups"] = 0
streets_gdf["dropoffs"] = 0

NYC_LOCATIONS = [
    {"name": "Times Square", "address": "Times Square, Manhattan, NY", "lat": 40.7580, "lng": -73.9855},
    {"name": "Central Park", "address": "Central Park, Manhattan, NY", "lat": 40.7829, "lng": -73.9654},
    {"name": "Brooklyn Bridge", "address": "Brooklyn Bridge, NY", "lat": 40.7061, "lng": -73.9969},
    {"name": "JFK Airport", "address": "JFK Airport, Queens, NY", "lat": 40.6413, "lng": -73.7781},
    {"name": "LaGuardia Airport", "address": "LaGuardia Airport, Queens, NY", "lat": 40.7769, "lng": -73.8740},
    {"name": "Penn Station", "address": "Pennsylvania Station, Manhattan, NY", "lat": 40.7505, "lng": -73.9934},
    {"name": "Grand Central", "address": "Grand Central Terminal, Manhattan, NY", "lat": 40.7527, "lng": -73.9772},
    {"name": "Wall Street", "address": "Wall Street, Manhattan, NY", "lat": 40.7074, "lng": -74.0113},
    {"name": "Empire State Building", "address": "350 5th Ave, Manhattan, NY", "lat": 40.7484, "lng": -73.9857},
    {"name": "Statue of Liberty", "address": "Liberty Island, NY", "lat": 40.6892, "lng": -74.0445},
    {"name": "Madison Square Garden", "address": "4 Pennsylvania Plaza, Manhattan, NY", "lat": 40.7505, "lng": -73.9934},
    {"name": "Brooklyn Heights", "address": "Brooklyn Heights, Brooklyn, NY", "lat": 40.6958, "lng": -73.9958},
    {"name": "Chelsea Market", "address": "Chelsea Market, Manhattan, NY", "lat": 40.7420, "lng": -74.0048},
    {"name": "Greenwich Village", "address": "Greenwich Village, Manhattan, NY", "lat": 40.7336, "lng": -74.0027},
    {"name": "SoHo", "address": "SoHo, Manhattan, NY", "lat": 40.7233, "lng": -74.0030},
    {"name": "Upper East Side", "address": "Upper East Side, Manhattan, NY", "lat": 40.7736, "lng": -73.9566},
    {"name": "Harlem", "address": "Harlem, Manhattan, NY", "lat": 40.8116, "lng": -73.9465},
    {"name": "Financial District", "address": "Financial District, Manhattan, NY", "lat": 40.7074, "lng": -74.0113},
    {"name": "Williamsburg", "address": "Williamsburg, Brooklyn, NY", "lat": 40.7081, "lng": -73.9571},
    {"name": "Queens Center", "address": "Queens Center, Queens, NY", "lat": 40.7348, "lng": -73.8698},
    {"name": "Bryant Park", "address": "Bryant Park, NY", "lat": 40.7536, "lng": -73.9832},
    {"name": "Union Square", "address": "Union Square, NY", "lat": 40.7359, "lng": -73.9911}
]

PARTNER_API_KEYS = {
    "city_transit_auth": "sk_live_51984",
    "uber_partner": "sk_live_99210",
    "test_developer": "dev_test_123"
}

street_graph = None

 #-------
def decrement_street(idx, type_str):
    """Remove a trip count from a street (used for sliding window)."""
    with lock:
        if idx is None or streets_gdf.empty:
            return
            
        if type_str == 'pickup':
            # Ensure we don't go below zero
            current = streets_gdf.at[idx, "pickups"]
            streets_gdf.at[idx, "pickups"] = max(0, current - 1)
        else:
            current = streets_gdf.at[idx, "dropoffs"]
            streets_gdf.at[idx, "dropoffs"] = max(0, current - 1)

def build_street_graph():
    """Build a NetworkX graph from street geometries."""
    global street_graph
    print("Building street network graph...")
    
    G = nx.Graph()
    
    with lock:
        for idx, row in streets_gdf.iterrows():
            geom = row.geometry
            
            if geom.geom_type == 'LineString':
                coords = list(geom.coords)
                
                for i in range(len(coords) - 1):
                    start = coords[i]
                    end = coords[i + 1]
                    
                    distance = Point(start).distance(Point(end))
                    traffic_activity = row["pickups"] + row["dropoffs"]
                    
                    # Standard penalty (Balanced)
                    traffic_penalty = traffic_activity * 0.1
                    weight_balanced = distance * (1 + traffic_penalty)
                    
                    # Quiet penalty (Avoid traffic at all costs)
                    # We multiply traffic impact by 50 to make busy streets "expensive"
                    weight_quiet = distance * (1 + (traffic_activity * 5.0))
                    
                    G.add_edge(start, end, 
                              weight=weight_balanced,
                              weight_quiet=weight_quiet,
                              distance=distance, 
                              traffic=traffic_activity,
                              street_name=row.get('name', 'Unknown'),
                              street_id=idx)
    
    street_graph = G
    print(f"Graph built with {G.number_of_nodes()} nodes")
    return G

def find_nearest_node(point, graph):
    """Find the nearest node in the graph to a given point."""
    min_dist = float('inf')
    nearest = None
    
    point_obj = Point(point)
    
    # Sample nodes if graph is very large
    nodes = list(graph.nodes())
    if len(nodes) > 5000:
        # Sample every 10th node for performance
        nodes = nodes[::10]
    
    for node in nodes:
        node_point = Point(node)
        dist = point_obj.distance(node_point)
        if dist < min_dist:
            min_dist = dist
            nearest = node
    
    return nearest


def increment_nearest_street(lat, lng, pickup=True):
    pt = Point(lng, lat)
    pt = gpd.GeoSeries([pt], crs="EPSG:4326").to_crs(streets_gdf.crs)[0]

    with lock:
        if streets_gdf.empty:
            return None
        distances = streets_gdf.geometry.distance(pt)
        nearest_idx = distances.idxmin()
        if pickup:
            streets_gdf.at[nearest_idx, "pickups"] += 1
        else:
            streets_gdf.at[nearest_idx, "dropoffs"] += 1
        return nearest_idx

# --- Kafka consumer thread ---
KAFKA_SERVER = "localhost:9092"
KAFKA_TOPIC = "nyc_trips"


def run_kafka_consumer():
    print("Starting Kafka consumer thread...")
    while True:
        try:
            consumer = KafkaConsumer(
                KAFKA_TOPIC,
                bootstrap_servers=KAFKA_SERVER,
                auto_offset_reset='latest',
                enable_auto_commit=True,
                value_deserializer=lambda m: json.loads(
                    m.decode('utf-8')) if m else None,
                consumer_timeout_ms=1000
            )

            msg_count = 0
            rebuild_counter = 0
            for msg in consumer:
                if not msg.value:
                    continue

                data = msg.value
                try:
                    p_lat = data.get('pickup_lat')
                    p_lng = data.get('pickup_lng')
                    if p_lat and p_lng:
                        idx = increment_nearest_street(float(p_lat), float(p_lng), pickup=True)
                        if idx is not None:
                            trip_window.append((idx, 'pickup'))

                    d_lat = data.get('dropoff_lat')
                    d_lng = data.get('dropoff_lng')
                    if d_lat and d_lng:
                        idx = increment_nearest_street(float(d_lat), float(d_lng), pickup=False)
                        if idx is not None:
                            trip_window.append((idx, 'dropoff'))

                    while len(trip_window) > 3242:
                        old_idx, old_type = trip_window.popleft() 
                        decrement_street(old_idx, old_type)

                    msg_count += 1
                    rebuild_counter += 1
                    
                    if msg_count % 20 == 0:
                        print(f"✅ Processed {msg_count} trips from Kafka")
                    
                    # Rebuild graph periodically to update weights
                    if rebuild_counter >= 825:
                        print("🔄 Rebuilding graph with updated traffic data...")
                        build_street_graph()
                        rebuild_counter = 0

                except Exception as e:
                    print(f"⚠️  Error processing message: {e}")
                    continue

            consumer.close()

        except Exception as e:
            print(f"⚠️  Kafka connection error: {e}. Retrying in 5 seconds...")
            time.sleep(5)


kafka_thread = threading.Thread(target=run_kafka_consumer, daemon=True)
kafka_thread.start()

# Build initial graph
build_street_graph()


@app.route("/api/streets")
def api_streets():
    with lock:
        active_streets = streets_gdf[streets_gdf["pickups"] +
                                     streets_gdf["dropoffs"] > 0].copy()
        active_streets["count"] = active_streets["pickups"] + \
            active_streets["dropoffs"]
        active_streets = active_streets.to_crs(epsg=4326)
        return active_streets.to_json()


@app.route("/api/congestion")
def api_congestion():
    with lock:
        features = []
        active_streets = streets_gdf[streets_gdf["pickups"] +
                                     streets_gdf["dropoffs"] > 0]
        for _, row in active_streets.iterrows():
            geom = row.geometry
            # Get representative point (centroid for the street)
            pt = geom.representative_point()
            pt = gpd.GeoSeries([pt], crs=streets_gdf.crs).to_crs(epsg=4326)[0]
            features.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [pt.x, pt.y]},
                "properties": {"intensity": row["pickups"] + row["dropoffs"]}
            })
        return jsonify({"type": "FeatureCollection", "features": features})


@app.route("/api/stats")
def api_stats():
    with lock:
        total_pickups = streets_gdf["pickups"].sum()
        total_dropoffs = streets_gdf["dropoffs"].sum()
        active_streets = len(
            streets_gdf[streets_gdf["pickups"] + streets_gdf["dropoffs"] > 0])
        return jsonify({
            "total_pickups": int(total_pickups),
            "total_dropoffs": int(total_dropoffs),
            "active_areas": active_streets,
            "active_streets": active_streets
        })


@app.route("/api/chat", methods=["POST"])
def api_chat():
    """Groq endpoint for traffic insights."""
    try:
        data = request.get_json()
        user_message = data.get('message', '')

        with lock:
            # Gather traffic context
            total_pickups = int(streets_gdf["pickups"].sum())
            total_dropoffs = int(streets_gdf["dropoffs"].sum())
            active_streets_count = len(
                streets_gdf[streets_gdf["pickups"] + streets_gdf["dropoffs"] > 0])

            # Get top 10 busiest streets
            busiest = streets_gdf[streets_gdf["pickups"] +
                                  streets_gdf["dropoffs"] > 0].copy()
            busiest["total_activity"] = busiest["pickups"] + \
                busiest["dropoffs"]
            busiest = busiest.nlargest(10, "total_activity")

            top_streets = []
            for idx, row in busiest.iterrows():
                # Get street name if available, otherwise use index
                street_name = row.get('name', f"Street #{idx}")
                top_streets.append({
                    "street": street_name,
                    "pickups": int(row["pickups"]),
                    "dropoffs": int(row["dropoffs"]),
                    "total": int(row["total_activity"])
                })

        context = f"""You are a NYC traffic insights assistant analyzing real-time taxi data.

Current Traffic Statistics:
- Total Pickups: {total_pickups}
- Total Dropoffs: {total_dropoffs}
- Active Streets: {active_streets_count}

Top 10 Busiest Streets (by pickup + dropoff count):
"""
        for i, street in enumerate(top_streets, 1):
            context += f"{i}. {street['street']}: {street['total']} trips ({street['pickups']} pickups, {street['dropoffs']} dropoffs)\n"

        context += "\nProvide helpful, concise insights about the traffic patterns. Explain trends, identify hotspots, and suggest reasons for congestion when relevant. Provide short answers."

        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": context},
                {"role": "user", "content": user_message}
            ],
            temperature=0.7,
            max_tokens=300
        )

        ai_response = response.choices[0].message.content
        return jsonify({"response": ai_response})

    except Exception as e:
        print(f"⚠️  Chat error: {e}")
        return jsonify({"response": f"I apologize, but I encountered an error: {str(e)}"}), 500


@app.route("/api/query-map", methods=["POST"])
def api_query_map():
    """Parse natural language query and return map filter parameters."""
    try:
        data = request.get_json()
        user_query = data.get('query', '')

        with lock:
            # Gather traffic context
            total_pickups = int(streets_gdf["pickups"].sum())
            total_dropoffs = int(streets_gdf["dropoffs"].sum())
            active_streets_count = len(
                streets_gdf[streets_gdf["pickups"] + streets_gdf["dropoffs"] > 0])

            # Get activity statistics
            active_gdf = streets_gdf[streets_gdf["pickups"] +
                                     streets_gdf["dropoffs"] > 0].copy()
            if not active_gdf.empty:
                active_gdf["total_activity"] = active_gdf["pickups"] + \
                    active_gdf["dropoffs"]
                max_activity = int(active_gdf["total_activity"].max())
                avg_activity = int(active_gdf["total_activity"].mean())
            else:
                max_activity = avg_activity = 0

        system_prompt = f"""You are a map query parser for a NYC taxi traffic visualization system.

Current Traffic Data:
- Total Pickups: {total_pickups}
- Total Dropoffs: {total_dropoffs}
- Active Streets: {active_streets_count}
- Max Activity on a Street: {max_activity} trips
- Average Activity: {avg_activity} trips

Your task: Parse the user's natural language query into a JSON filter configuration.

Return ONLY valid JSON with this structure:
{{
  "filterType": "threshold" | "percentage" | "comparison" | "highlight",
  "minCount": <number or null>,
  "maxCount": <number or null>,
  "description": "<human-readable description of what's being shown>",
  "highlightColor": "<hex color or null>"
}}

Examples:
- "show streets with more than 200 trips" → {{"filterType": "threshold", "minCount": 200, "maxCount": null, "description": "Streets with 200+ trips", "highlightColor": null}}
- "highlight top 10% busiest streets" → {{"filterType": "percentage", "minCount": {int(max_activity * 0.9)}, "maxCount": null, "description": "Top 10% busiest streets", "highlightColor": "#ff0000"}}
- "show low congestion streets" → {{"filterType": "threshold", "minCount": 1, "maxCount": {int(avg_activity * 0.5)}, "description": "Low congestion streets", "highlightColor": "#00ff00"}}
- "filter to only pickup hotspots" → {{"filterType": "comparison", "minCount": {int(avg_activity * 1.5)}, "maxCount": null, "description": "High-activity pickup zones", "highlightColor": "#ffaa00"}}

Return ONLY the JSON object, no other text."""

        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_query}
            ],
            temperature=0.3,
            max_tokens=200
        )

        ai_response = response.choices[0].message.content.strip()

        if ai_response.startswith("```"):
            ai_response = ai_response.split("```")[1]
            if ai_response.startswith("json"):
                ai_response = ai_response[4:]
            ai_response = ai_response.strip()

        filter_config = json.loads(ai_response)

        filter_config["currentStats"] = {
            "totalPickups": total_pickups,
            "totalDropoffs": total_dropoffs,
            "activeStreets": active_streets_count,
            "maxActivity": max_activity,
            "avgActivity": avg_activity
        }

        return jsonify(filter_config)

    except json.JSONDecodeError as e:
        print(f"⚠️  JSON parse error: {e}, response was: {ai_response}")
        return jsonify({
            "filterType": "threshold",
            "minCount": 0,
            "maxCount": None,
            "description": "All streets (query parsing failed)",
            "highlightColor": None,
            "error": "Failed to parse query"
        }), 200
    except Exception as e:
        print(f"⚠️  Query map error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/geocode", methods=["POST"])
def api_geocode():
    """Simple geocoding with popular NYC locations."""
    try:
        data = request.get_json()
        query = data.get('query', '').lower()
        
        if not query.strip():
            return jsonify({"suggestions": []})
            
        suggestions = []
        for loc in NYC_LOCATIONS:
            if query in loc["name"].lower() or query in loc["address"].lower():
                suggestions.append(loc)
        
        return jsonify({"suggestions": suggestions[:10]})
        
    except Exception as e:
        print(f"⚠️  Geocode error: {e}")
        return jsonify({"suggestions": []}), 500


@app.route("/api/optimize-route", methods=["POST"])
def api_optimize_route():
    """Find optimal route avoiding high traffic areas using NetworkX."""
    try:
        data = request.get_json()
        start_lat = float(data.get('start_lat'))
        start_lng = float(data.get('start_lng'))
        end_lat = float(data.get('end_lat'))
        end_lng = float(data.get('end_lng'))
        
        print(f"🔍 Finding route from ({start_lat}, {start_lng}) to ({end_lat}, {end_lng})")
        
        if not all([start_lat, start_lng, end_lat, end_lng]):
            return jsonify({"error": "Missing coordinates"}), 400
        
        # Convert lat/lng to projected coordinates (UTM)
        start_point = gpd.GeoSeries([Point(start_lng, start_lat)], crs="EPSG:4326").to_crs(epsg=32618)[0]
        end_point = gpd.GeoSeries([Point(end_lng, end_lat)], crs="EPSG:4326").to_crs(epsg=32618)[0]
        
        start_coords = (start_point.x, start_point.y)
        end_coords = (end_point.x, end_point.y)
        
        # Rebuild graph with current traffic data
        print("🔄 Building graph with current traffic...")
        G = build_street_graph()
        
        if G is None or G.number_of_nodes() == 0:
            return jsonify({"error": "Street network not available"}), 500
        
        # Find nearest nodes in graph
        print("📍 Finding nearest network nodes...")
        start_node = find_nearest_node(start_coords, G)
        end_node = find_nearest_node(end_coords, G)
        
        if start_node is None or end_node is None:
            return jsonify({"error": "Could not find path in street network"}), 404
        
        print(f"✅ Start node: {start_node}, End node: {end_node}")
        
        # Find shortest path using Dijkstra (considering traffic weights)
        try:
            print("🔍 Computing optimal path...")
            path = nx.shortest_path(G, start_node, end_node, weight='weight')
            print(f"✅ Path found with {len(path)} nodes")
            
            # Calculate path statistics
            total_distance = 0
            total_traffic = 0
            path_edges = []
            
            for i in range(len(path) - 1):
                edge_data = G[path[i]][path[i + 1]]
                total_distance += edge_data['distance']
                total_traffic += edge_data['traffic']
                path_edges.append((path[i], path[i + 1]))
            
            # Convert path back to lat/lng coordinates
            path_coords_utm = [(node[0], node[1]) for node in path]
            
            # Create GeoDataFrame for coordinate conversion
            path_points = [Point(x, y) for x, y in path_coords_utm]
            path_gdf = gpd.GeoSeries(path_points, crs="EPSG:32618").to_crs(epsg=4326)
            
            # Extract lat/lng coordinates
            path_coords_latng = [[point.x, point.y] for point in path_gdf]
            
            # Create GeoJSON
            route_geojson = {
                "type": "LineString",
                "coordinates": path_coords_latng
            }
            
            # Estimate duration (simple: distance / average speed)
            avg_speed_m_per_sec = 6.33  # ~30 km/h in urban traffic
            duration = total_distance / avg_speed_m_per_sec  # seconds
            
            print(f"📊 Route stats - Distance: {total_distance:.0f}m, Traffic: {total_traffic}, Duration: {duration:.0f}s")
            
            return jsonify({
                "route": {
                    "geometry": route_geojson,
                    "duration": duration,
                    "distance": total_distance,
                    "traffic_score": total_traffic / max(1, len(path)),
                    "nodes": len(path)
                }
            })
            
        except nx.NetworkXNoPath:
            print("❌ No path found between nodes")
            return jsonify({"error": "No path found between locations"}), 404
        except Exception as path_error:
            print(f"❌ Path finding error: {path_error}")
            return jsonify({"error": f"Path finding failed: {str(path_error)}"}), 500
        
    except Exception as e:
        print(f"⚠️  Route optimization error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
# Add this helper function for A* heuristic
def euclidean_distance_heuristic(node1, node2):
    """Calculate Euclidean distance between two nodes (for A* heuristic)."""
    return math.sqrt((node1[0] - node2[0])**2 + (node1[1] - node2[1])**2)


@app.route("/api/driver-insights", methods=["GET"])
def api_driver_insights():
    """Return high-demand pickup locations for drivers."""
    with lock:
        # Filter for streets with significant pickup activity
        hotspots = streets_gdf[streets_gdf["pickups"] > 0].copy()
        
        if hotspots.empty:
            return jsonify({"hotspots": [], "message": "No current demand data."})
            
        # Sort by pickup count
        hotspots = hotspots.nlargest(8, "pickups")
        
        results = []
        for _, row in hotspots.iterrows():
            geom = row.geometry
            pt = geom.representative_point()
            pt = gpd.GeoSeries([pt], crs=streets_gdf.crs).to_crs(epsg=4326)[0]
            
            results.append({
                "coordinates": [pt.x, pt.y],
                "pickups": int(row["pickups"]),
                "street": row.get('name', 'Unnamed Street'),
                "intensity": "High" if row["pickups"] > 10 else "Moderate"
            })
            
        return jsonify({
            "hotspots": results,
            "timestamp": time.time()
        })

@app.route("/api/optimize-route-manual", methods=["POST"])
def api_optimize_route_manual():
    try:
        data = request.get_json()
        start_lat = float(data.get('start_lat'))
        start_lng = float(data.get('start_lng'))
        end_lat = float(data.get('end_lat'))
        end_lng = float(data.get('end_lng'))
        # New parameter: 'fastest' (default) or 'quiet'
        route_mode = data.get('mode', 'fastest') 
        
        print(f"🔍 Routing ({route_mode}): ({start_lat}, {start_lng}) -> ({end_lat}, {end_lng})")
        
        start_point = gpd.GeoSeries([Point(start_lng, start_lat)], crs="EPSG:4326").to_crs(epsg=32618)[0]
        end_point = gpd.GeoSeries([Point(end_lng, end_lat)], crs="EPSG:4326").to_crs(epsg=32618)[0]
        
        start_coords = (start_point.x, start_point.y)
        end_coords = (end_point.x, end_point.y)

        # Ensure graph exists
        if street_graph is None: 
             build_street_graph()
        G = street_graph

        start_node = find_nearest_node(start_coords, G)
        end_node = find_nearest_node(end_coords, G)

        if not start_node or not end_node:
             return jsonify({"error": "Nodes not found"}), 404

        weight_attr = 'weight_quiet' if route_mode == 'quiet' else 'weight'

        try:
            path = nx.astar_path(
                G, 
                start_node, 
                end_node,
                heuristic=euclidean_distance_heuristic,
                weight=weight_attr  # Use dynamic weight
            )

            total_distance = 0
            total_traffic = 0
            high_congestion_segments = 0
            
            with lock:
                active_streets = streets_gdf[streets_gdf["pickups"] + streets_gdf["dropoffs"] > 0]
                avg_traffic = active_streets["pickups"].sum() / max(1, len(active_streets)) if not active_streets.empty else 0
                max_traffic = active_streets["pickups"].max() if not active_streets.empty else 0

            for i in range(len(path) - 1):
                edge_data = G[path[i]][path[i + 1]]
                total_distance += edge_data['distance']
                total_traffic += edge_data['traffic']
                if edge_data['traffic'] > avg_traffic * 1.5:
                    high_congestion_segments += 1
            
            path_coords_utm = [(node[0], node[1]) for node in path]
            path_points = [Point(x, y) for x, y in path_coords_utm]
            path_gdf = gpd.GeoSeries(path_points, crs="EPSG:32618").to_crs(epsg=4326)
            path_coords_latng = [[point.x, point.y] for point in path_gdf]

            route_geojson = {
                "type": "LineString",
                "coordinates": path_coords_latng
            }

            avg_traffic_density = total_traffic / max(1, total_distance)
            congestion_percentage = (high_congestion_segments / max(1, len(path) - 1)) * 100

            # AI Analysis tailored to mode
            mode_desc = "Quiet/Scenic" if route_mode == 'quiet' else "Fastest/Standard"
            ai_prompt_extra = f"The user requested a {mode_desc} route."

            route_analysis = analyze_route_with_ai(
                total_distance, total_traffic, avg_traffic_density, 
                congestion_percentage, len(path), avg_traffic, max_traffic
            )

            return jsonify({
                "route": {
                    "geometry": route_geojson,
                    "duration": total_distance / 5.33, # Rough estimate
                    "distance": total_distance,
                    "traffic_score": total_traffic,
                    "mode": route_mode,
                    "nodes": len(path),
                    "congestion_percentage": round(congestion_percentage, 1),
                    "ai_analysis": f"[{mode_desc}] {route_analysis}"
                }
            })

        except Exception as e:
            print(f"Pathfinding error: {e}")
            return jsonify({"error": str(e)}), 500
            
    except Exception as e:
        return jsonify({"error": str(e)}), 500 


def analyze_route_with_ai(distance, total_traffic, traffic_density, congestion_pct, nodes, avg_network_traffic, max_network_traffic):
    """Use AI to analyze route quality and provide insights."""
    try:
        prompt = f"""Analyze this NYC taxi route and provide a brief assessment:

Route Metrics:
- Distance: {distance:.0f} meters ({distance/1000:.1f} km)
- Total Traffic Count: {total_traffic} trips
- Average Traffic Density: {traffic_density:.4f} trips/meter
- High-Congestion Segments: {congestion_pct:.1f}%
- Number of Street Segments: {nodes}

Network Context:
- Network Average Traffic: {avg_network_traffic:.1f} trips/street
- Network Maximum Traffic: {max_network_traffic} trips/street

Provide a 2-3 sentence assessment of this route's efficiency, focusing on:
1. Whether it successfully avoids high-congestion areas
2. Overall route quality (excellent/good/fair/poor)
3. Any notable traffic concerns

Be concise and practical."""

        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[
                {"role": "system", "content": "You are a traffic route analyst. Provide brief, actionable assessments."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.5,
            max_tokens=150
        )

        return response.choices[0].message.content.strip()
        
    except Exception as e:
        print(f"⚠️  AI analysis error: {e}")
        return "Route calculated successfully. The path avoids high-traffic areas where possible."
  
 
@app.route("/api/passenger-pickup-guide", methods=["POST"])
def api_passenger_guide():
    """Analyze location and return User Location + Optimal Pickup Location."""
    try:
        data = request.get_json()
        query = data.get('location', '')
        
        if not query:
            return jsonify({"error": "Location is required"}), 400

        # Geocode using the Shared Global List
        lat, lng = None, None
        location_name = query
        query_lower = query.lower()
        
        # Try exact/partial match in our database
        for loc in NYC_LOCATIONS:
            if query_lower in loc["name"].lower() or query_lower in loc["address"].lower():
                lat, lng = loc["lat"], loc["lng"]
                location_name = loc["name"]
                break
        
        # Fallback if not found (Default to Times Square area)
        if lat is None:
            print(f"⚠️ Location '{query}' not found in DB, using fallback.")
            lat, lng = 40.7580, -73.9855
            location_name = "Unknown Location (Defaulting to Midtown)"
            
        # Get Traffic Data
        search_point = Point(lng, lat)
        search_point_proj = gpd.GeoSeries([search_point], crs="EPSG:4326").to_crs(streets_gdf.crs)[0]
        
        current_traffic = 0
        with lock:
            if not streets_gdf.empty:
                distances = streets_gdf.geometry.distance(search_point_proj)
                nearest_idx = distances.idxmin()
                current_traffic = int(streets_gdf.at[nearest_idx, "pickups"] + streets_gdf.at[nearest_idx, "dropoffs"])

        # Calculate "Optimal" Spot
        # Dynamic offset based on traffic intensity
        # High traffic -> Move further (approx 1-2 blocks)
        offset_scale = 0.0020 if current_traffic > 15 else 0.0010
        
        # Simple heuristic: Move slightly South-East (often clear in grid)
        # In a real app, this would traverse the graph to a lower-weight node
        optimal_lat = lat - (offset_scale * 0.6)
        optimal_lng = lng + (offset_scale * 0.6)
        
        # AI Advice
        system_prompt = f"""You are a NYC taxi expert. 
        User is at: "{location_name}" (Traffic: {current_traffic} trips).
        We have calculated an optimal spot about 1-2 minutes walk away.
        
        Explain WHY they should move to the designated pin (e.g., "Walk to the corner to avoid the congestion," "Cross the avenue").
        Keep it strictly under 2 sentences."""

        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "system", "content": system_prompt}],
            temperature=0.7,
            max_tokens=100
        )
        
        return jsonify({
            "location": location_name,
            "user_coords": [lng, lat],
            "optimal_coords": [optimal_lng, optimal_lat],
            "traffic": current_traffic,
            "advice": response.choices[0].message.content.strip()
        })

    except Exception as e:
        print(f"Error in passenger guide: {e}")
        return jsonify({"error": str(e)}), 500

# --- NEW: Partner Data Ingestion Endpoint ---
@app.route("/api/v1/partner/ingest", methods=["POST"])
def api_partner_ingest():
    """
    Internal API for partners to push traffic data.
    Headers: {'X-API-Key': 'your_key'}
    Body: {
        "source": "company_name",
        "trips": [
            {"lat": 40.75, "lng": -73.98, "type": "pickup"},
            ...
        ]
    }
    """
    try:
        # Security Check
        api_key = request.headers.get("X-API-Key")
        if api_key not in PARTNER_API_KEYS.values():
            return jsonify({"error": "Unauthorized: Invalid or missing API Key"}), 401
            
        data = request.get_json()
        trips = data.get("trips", [])
        source = data.get("source", "Unknown")
        
        if not trips:
            return jsonify({"message": "No trips provided"}), 400
            
        processed_count = 0
        
        # Process Data Batch
        # We reuse the existing graph logic so this data immediately affects 
        # the map, heatmaps, and route optimization.
        for trip in trips:
            lat = trip.get("lat")
            lng = trip.get("lng")
            trip_type = trip.get("type", "pickup") # 'pickup' or 'dropoff'
            
            if lat is not None and lng is not None:
                try:
                    # Validate coordinates are floats
                    lat, lng = float(lat), float(lng)
                    
                    # Update the main dataframe
                    idx = increment_nearest_street(lat, lng, pickup=(trip_type == 'pickup'))
                    
                    if idx is not None:
                        trip_window.append((idx, trip_type))
                        processed_count += 1
                except ValueError:
                    continue
                    
        print(f"🔌 Partner Ingest ({source}): Processed {processed_count} / {len(trips)} trips.")
        
        return jsonify({
            "status": "success",
            "processed": processed_count,
            "message": "Data successfully ingested into live traffic stream."
        })

    except Exception as e:
        print(f"Partner API Error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/congestion-zones", methods=["GET"])
def api_congestion_zones():
    """Return top congestion zones with their activity over time."""
    try:
        with lock:
            # Get top 10 busiest streets
            active_streets = streets_gdf[streets_gdf["pickups"] + streets_gdf["dropoffs"] > 0].copy()
            
            if active_streets.empty:
                return jsonify({"zones": [], "timestamp": time.time()})
            
            active_streets["total_activity"] = active_streets["pickups"] + active_streets["dropoffs"]
            top_zones = active_streets.nlargest(10, "total_activity")
            
            zones = []
            for idx, row in top_zones.iterrows():
                zones.append({
                    "name": row.get('name', f"Street #{idx}"),
                    "activity": int(row["total_activity"]),
                    "pickups": int(row["pickups"]),
                    "dropoffs": int(row["dropoffs"])
                })
            
            return jsonify({
                "zones": zones,
                "timestamp": time.time(),
                "total_streets": len(active_streets)
            })
            
    except Exception as e:
        print(f"Congestion zones error: {e}")
        return jsonify({"zones": [], "error": str(e)}), 500
if __name__ == "__main__":
    app.run(port=5001, host="0.0.0.0", debug=True)