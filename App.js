import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl'; 
import 'mapbox-gl/dist/mapbox-gl.css';

const API_BASE = process.env.REACT_APP_API_BASE;
const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_API_KEY;

export default function TrafficMap() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  
  // --- Core States ---
  const [isLoading, setIsLoading] = useState(true);
  const [mapboxLoaded, setMapboxLoaded] = useState(false); // New state for CDN load
  const [stats, setStats] = useState(null);
  const [topZones, setTopZones] = useState([]);
  const [mapError, setMapError] = useState(null);
  const streetsDataRef = useRef(null); // Store raw GeoJSON for feature lookups
  
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [activeFilter, setActiveFilter] = useState(null);
  const [queryInput, setQueryInput] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const chatEndRef = useRef(null);

  const [fromInput, setFromInput] = useState('');
  const [toInput, setToInput] = useState('');
  const [fromSuggestions, setFromSuggestions] = useState([]);
  const [toSuggestions, setToSuggestions] = useState([]);
  const [selectedFrom, setSelectedFrom] = useState(null);
  const [selectedTo, setSelectedTo] = useState(null);
  const [isSearchingRoute, setIsSearchingRoute] = useState(false);
  const [activeRoute, setActiveRoute] = useState(null);
  const [showFromSuggestions, setShowFromSuggestions] = useState(false);
  const [showToSuggestions, setShowToSuggestions] = useState(false);
  const [routePanelOpen, setRoutePanelOpen] = useState(false);

  const [manualPinMode, setManualPinMode] = useState(false);
  const [pickupMarker, setPickupMarker] = useState(null);
  const [dropoffMarker, setDropoffMarker] = useState(null);
  const [manualPickupCoords, setManualPickupCoords] = useState(null);
  const [manualDropoffCoords, setManualDropoffCoords] = useState(null);

  const [routeMode, setRouteMode] = useState('fastest'); // 'fastest' | 'quiet'
  const [driverHotspots, setDriverHotspots] = useState([]);
  const [showDriverTools, setShowDriverTools] = useState(false);
  
  const [showPassengerModal, setShowPassengerModal] = useState(false);
  const [passengerLocationInput, setPassengerLocationInput] = useState('');
  
  const [showDevModal, setShowDevModal] = useState(false);
  const [devApiKey, setDevApiKey] = useState('dev_test_123');
  const [devJsonPayload, setDevJsonPayload] = useState(JSON.stringify({
    source: "partner_simulation",
    trips: [
      { lat: 40.7580, lng: -73.9855, type: "pickup" },
      { lat: 40.7580, lng: -73.9855, type: "pickup" },
      { lat: 40.7580, lng: -73.9855, type: "pickup" },
      { lat: 40.7484, lng: -73.9857, type: "dropoff" }
    ]
  }, null, 2));
  const [devResponse, setDevResponse] = useState(null);
  
  const passengerMarkersRef = useRef([]);

  // 1. Load Mapbox from CDN
  useEffect(() => {
    if (window.mapboxgl) {
      setMapboxLoaded(true);
      return;
    }

    const link = document.createElement('link');
    link.href = 'https://api.mapbox.com/mapbox-gl-js/v2.14.1/mapbox-gl.css';
    link.rel = 'stylesheet';
    document.head.appendChild(link);

    const script = document.createElement('script');
    script.src = 'https://api.mapbox.com/mapbox-gl-js/v2.14.1/mapbox-gl.js';
    script.async = true;
    script.onload = () => setMapboxLoaded(true);
    script.onerror = () => setMapError("Failed to load Mapbox library");
    document.head.appendChild(script);

    return () => {
      // Optional cleanup
      // document.head.removeChild(link);
      // document.head.removeChild(script);
    };
  }, []);

  useEffect(() => {
    if (!mapboxLoaded || map.current) return;

    try {
      const mapboxgl = window.mapboxgl;
      mapboxgl.accessToken = MAPBOX_TOKEN;

      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/dark-v11',
        center: [-73.98, 40.75],
        zoom: 12
      });

      map.current.on('load', () => {
        console.log('Map loaded successfully');

        // 1. Streets Layer
        map.current.addSource('streets', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        
        map.current.addLayer({
          id: 'busy-streets',
          type: 'line',
          source: 'streets',
          // Filter: Show streets with >= 4 trips
          filter: ['>=', ['get', 'count'], 4],
          paint: {
            'line-width': ['interpolate', ['linear'], ['get', 'count'], 4, 4, 24, 9],
            'line-color': [
              'interpolate',
              ['linear'],
              ['get', 'count'],
              4, '#ffff00',
              8, '#ffcc00',
              14, '#ff9900',
              16, '#ff6600',
              20, '#ff3300',
              24, '#ff0000'
            ],
            'line-opacity': 0.95
          }
        });

        // 2. Heatmap Layer
        map.current.addSource('congestion', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.current.addLayer({
          id: 'congestion-heat',
          type: 'heatmap',
          source: 'congestion',
          paint: {
            'heatmap-weight': ['get', 'intensity'],
            'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.35, 15, 0.8],
            'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 15, 15, 30],
            'heatmap-color': [
              'interpolate',
              ['linear'],
              ['heatmap-density'],
              0, 'rgba(173,216,230,0)',
              0.1, 'rgb(173,216,230)',
              0.3, 'rgb(135,206,250)',
              0.5, 'rgb(255,255,153)',
              0.7, 'rgb(255,165,0)',
              0.85, 'rgb(255,69,0)',
              1, 'rgb(220,20,60)'
            ],
            'heatmap-opacity': 0.6
          }
        });

        // 3. Route Layer
        map.current.addSource('route', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });
        map.current.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          paint: {
            'line-color': '#1e90ff',
            'line-width': 6,
            'line-opacity': 0.8
          }
        });

        setIsLoading(false);
        fetchData();

        const interval = setInterval(fetchData, 10000);
        return () => clearInterval(interval);
      });
    } catch (error) {
      console.error('Map init error:', error);
      setMapError(error.message);
    }
  }, [mapboxLoaded]);

  const fetchData = async () => {
    try {
      const streetsRes = await fetch(`${API_BASE}/streets`);
      if (streetsRes.ok) {
        const streetsData = await streetsRes.json();
        streetsDataRef.current = streetsData; // Store raw data for clicks
        if (map.current.getSource('streets')) {
          map.current.getSource('streets').setData(streetsData);
        }
      }

      const congestionRes = await fetch(`${API_BASE}/congestion`);
      if (congestionRes.ok) {
        const congestionData = await congestionRes.json();
        if (map.current.getSource('congestion')) {
          map.current.getSource('congestion').setData(congestionData);
        }
      }

      const statsRes = await fetch(`${API_BASE}/stats`);
      if (statsRes.ok) {
        setStats(await statsRes.json());
      }

      // --- FETCH TOP CONGESTION ZONES ---
      const zonesRes = await fetch(`${API_BASE}/congestion-zones`);
      if (zonesRes.ok) {
        const zonesData = await zonesRes.json();
        // Slice to get top 5
        setTopZones(zonesData.zones.slice(0, 5));
      }

    } catch (error) {
      console.error('Fetch error:', error);
    }
  };

  // --- Focus Logic ---
  const focusOnZone = (zone) => {
    if (!streetsDataRef.current || !map.current || !window.mapboxgl) return;

    // Find the feature by name. 
    // Note: If backend names don't match exactly, this might need fuzzier matching.
    const feature = streetsDataRef.current.features.find(f => f.properties.name === zone.name);

    if (feature) {
      const coordinates = feature.geometry.coordinates;
      const bounds = new window.mapboxgl.LngLatBounds();

      // Handle different geometry types (LineString vs MultiLineString)
      if (feature.geometry.type === 'LineString') {
        coordinates.forEach(coord => bounds.extend(coord));
      } else if (feature.geometry.type === 'MultiLineString') {
        coordinates.forEach(line => line.forEach(coord => bounds.extend(coord)));
      }

      map.current.fitBounds(bounds, { padding: 100, maxZoom: 16, duration: 1500 });

      // Temporary Popup
      new window.mapboxgl.Popup({ closeButton: false, closeOnClick: true })
        .setLngLat(bounds.getCenter())
        .setHTML(`<div style="color:#000; padding:5px;"><strong>${zone.name}</strong><br>Activity: ${zone.activity}</div>`)
        .addTo(map.current);
    } else {
      console.warn("Feature not found for zone:", zone.name);
    }
  };

  // --- Driver Recommendations ---
  const fetchDriverRecommendations = async () => {
    if (!window.mapboxgl) return;
    try {
      const res = await fetch(`${API_BASE}/driver-insights`);
      if (res.ok) {
        const data = await res.json();
        setDriverHotspots(data.hotspots);

        // Clear existing hotspot markers
        document.querySelectorAll('.driver-hotspot').forEach(el => el.remove());

        // Add new markers
        data.hotspots.forEach(spot => {
          const el = document.createElement('div');
          el.className = 'driver-hotspot';
          el.innerHTML = '<div style="font-size:24px; animation: bounce 1s infinite;">💰</div>';
          el.style.cursor = 'pointer';

          new window.mapboxgl.Marker(el)
            .setLngLat(spot.coordinates)
            .setPopup(new window.mapboxgl.Popup({ offset: 25 })
              .setHTML(`<strong>High Demand!</strong><br>${spot.street}<br>Pickups: ${spot.pickups}`))
            .addTo(map.current);
        });

        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `🚕 Found ${data.hotspots.length} high-demand pickup spots based on current activity.`
        }]);
      }
    } catch (error) {
      console.error("Error fetching driver insights", error);
    }
  };

  const clearDriverHotspots = () => {
    document.querySelectorAll('.driver-hotspot').forEach(el => el.remove());
    setDriverHotspots([]);
  };

  // --- Best Time Query ---
  const askBestTime = () => {
    const prompt = "Based on current traffic patterns, when is the best time to travel to Manhattan core?";
    setMessages(prev => [...prev, { role: 'user', content: prompt }]);
    setIsSending(true);

    fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prompt })
    })
      .then(res => res.json())
      .then(data => {
        setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
      })
      .catch(err => {
        setMessages(prev => [...prev, { role: 'assistant', content: "Sorry, I couldn't fetch the prediction." }]);
      })
      .finally(() => setIsSending(false));
  };

  // --- Passenger Pickup Logic (Dual Pins) ---
  const handlePassengerSubmit = async () => {
    if (!passengerLocationInput.trim() || !window.mapboxgl) return;
    
    const locationQuery = passengerLocationInput;
    setShowPassengerModal(false);
    setPassengerLocationInput('');

    setMessages(prev => [...prev, { 
        role: 'user', 
        content: `🙋 I'm at "${locationQuery}". Where should I stand?` 
    }]);
    
    setIsSending(true);

    try {
        const response = await fetch(`${API_BASE}/passenger-pickup-guide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: locationQuery })
        });

        if (response.ok) {
            const data = await response.json();
            
            passengerMarkersRef.current.forEach(marker => marker.remove());
            passengerMarkersRef.current = [];
            
            const userEl = document.createElement('div');
            userEl.className = 'passenger-marker';
            userEl.innerHTML = '<div style="font-size:32px; filter: drop-shadow(0 0 5px rgba(0,0,0,0.5)); cursor: pointer;">🙋</div>';
            
            const userMarker = new window.mapboxgl.Marker(userEl)
                .setLngLat(data.user_coords)
                .setPopup(new window.mapboxgl.Popup({ offset: 25 }).setHTML(`<strong>You are here</strong><br>${data.location}`))
                .addTo(map.current);
            
            passengerMarkersRef.current.push(userMarker);

            const bestEl = document.createElement('div');
            bestEl.className = 'passenger-marker';
            bestEl.innerHTML = '<div style="font-size:32px; animation: bounce 1s infinite; filter: drop-shadow(0 0 8px #00ff00); cursor: pointer;">✨</div>';
            
            const bestMarker = new window.mapboxgl.Marker(bestEl)
                .setLngLat(data.optimal_coords)
                .setPopup(new window.mapboxgl.Popup({ offset: 25 }).setHTML(`<strong>Optimal Spot</strong><br>Walk here!`))
                .addTo(map.current);

            passengerMarkersRef.current.push(bestMarker);
                
            const bounds = new window.mapboxgl.LngLatBounds()
                .extend(data.user_coords)
                .extend(data.optimal_coords);
            
            map.current.fitBounds(bounds, { padding: 100, maxZoom: 16 });

            setMessages(prev => [...prev, { 
                role: 'assistant', 
                content: `📍 **Positioning Advice:**\n\n${data.advice}\n\n(Look for the ✨ pin on the map!)` 
            }]);
        } else {
            setMessages(prev => [...prev, { role: 'assistant', content: "❌ Couldn't analyze that location. Try a major landmark." }]);
        }
    } catch (e) {
        console.error(e);
        setMessages(prev => [...prev, { role: 'assistant', content: "❌ Connection error." }]);
    } finally {
        setIsSending(false);
    }
  };

  // --- Developer API Logic ---
  const sendPartnerData = async () => {
    setDevResponse(null);
    try {
      const payload = JSON.parse(devJsonPayload);
      const response = await fetch(`${API_BASE}/v1/partner/ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': devApiKey
        },
        body: JSON.stringify(payload)
      });
      
      const data = await response.json();
      setDevResponse(data);
      
      if (response.ok) {
        fetchData();
      }
    } catch (err) {
      setDevResponse({ error: "Invalid JSON or Network Error" });
    }
  };

  // --- Manual Pin Functions ---
  const enableManualPinMode = () => {
    if (manualPinMode || !window.mapboxgl) return;
    setManualPinMode(true);

    // Clear only the route line
    if (map.current.getSource('route')) {
      map.current.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    }
    document.querySelectorAll('.route-marker').forEach(el => el.remove());

    // Pickup Marker
    const pickupEl = document.createElement('div');
    pickupEl.innerHTML = '<div style="font-size: 32px; cursor: move;">📍</div>';
    const pickup = new window.mapboxgl.Marker({ element: pickupEl, draggable: true })
      .setLngLat([-73.985, 40.755])
      .addTo(map.current);
    
    pickup.on('dragend', () => {
      const { lng, lat } = pickup.getLngLat();
      setManualPickupCoords({ lat, lng });
    });
    setPickupMarker(pickup);
    setManualPickupCoords({ lat: 40.755, lng: -73.985 });

    // Dropoff Marker
    const dropoffEl = document.createElement('div');
    dropoffEl.innerHTML = '<div style="font-size: 32px; cursor: move;">🏁</div>';
    const dropoff = new window.mapboxgl.Marker({ element: dropoffEl, draggable: true })
      .setLngLat([-73.975, 40.765])
      .addTo(map.current);

    dropoff.on('dragend', () => {
      const { lng, lat } = dropoff.getLngLat();
      setManualDropoffCoords({ lat, lng });
    });
    setDropoffMarker(dropoff);
    setManualDropoffCoords({ lat: 40.765, lng: -73.975 });

    setMessages(prev => [...prev, { role: 'assistant', content: '🎯 Manual pin mode: Drag 📍 and 🏁.' }]);
  };

  const disableManualPinMode = () => {
    if (pickupMarker) pickupMarker.remove();
    if (dropoffMarker) dropoffMarker.remove();
    setPickupMarker(null);
    setDropoffMarker(null);
    setManualPinMode(false);
    setManualPickupCoords(null);
    setManualDropoffCoords(null);
  };

  const resetManualPins = () => {
    if (pickupMarker) {
      pickupMarker.setLngLat([-73.985, 40.755]);
      setManualPickupCoords({ lat: 40.755, lng: -73.985 });
    }
    if (dropoffMarker) {
      dropoffMarker.setLngLat([-73.975, 40.765]);
      setManualDropoffCoords({ lat: 40.765, lng: -73.975 });
    }
    if (map.current.getSource('route')) {
      map.current.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    }
    setActiveRoute(null);
  };

  // --- AI Route Finding (Manual Pins) ---
  const findAIRoute = async () => {
    if (!manualPickupCoords || !manualDropoffCoords || isSearchingRoute || !window.mapboxgl) return;
    setIsSearchingRoute(true);

    setMessages(prev => [...prev, {
      role: 'user',
      content: `🤖 Finding ${routeMode === 'quiet' ? 'quiet 🌳' : 'fastest 🚀'} route...`
    }]);

    try {
      const response = await fetch(`${API_BASE}/optimize-route-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_lat: manualPickupCoords.lat,
          start_lng: manualPickupCoords.lng,
          end_lat: manualDropoffCoords.lat,
          end_lng: manualDropoffCoords.lng,
          mode: routeMode
        })
      });

      if (response.ok) {
        const data = await response.json();
        const route = data.route;
        
        if (map.current.getSource('route')) {
          map.current.getSource('route').setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: {},
              geometry: route.geometry
            }]
          });
        }

        const coordinates = route.geometry.coordinates;
        const bounds = coordinates.reduce((b, c) => b.extend(c), new window.mapboxgl.LngLatBounds(coordinates[0], coordinates[0]));
        map.current.fitBounds(bounds, { padding: 80 });

        setActiveRoute({ ...route, from: 'Manual Pickup', to: 'Manual Dropoff' });
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `✅ Route found (${routeMode.toUpperCase()})\nStats: ${Math.round(route.duration/60)}min, ${(route.distance/1000).toFixed(1)}km\nAnalysis: ${route.ai_analysis}`
        }]);
      }
    } catch (error) {
      setMessages(prev => [...prev, { role: 'assistant', content: '❌ Connection error.' }]);
    } finally {
      setIsSearchingRoute(false);
    }
  };

  // --- Standard Route Finding (Search Bar) ---
  const searchLocations = async (query, isFrom = true) => {
    if (!query.trim()) {
      isFrom ? setFromSuggestions([]) : setToSuggestions([]);
      isFrom ? setShowFromSuggestions(false) : setShowToSuggestions(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      if (response.ok) {
        const data = await response.json();
        if (isFrom) { setFromSuggestions(data.suggestions); setShowFromSuggestions(true); }
        else { setToSuggestions(data.suggestions); setShowToSuggestions(true); }
      }
    } catch (e) { console.error(e); }
  };

  const selectLocation = (location, isFrom = true) => {
    if (isFrom) {
      setSelectedFrom(location);
      setFromInput(location.address);
      setShowFromSuggestions(false);
    } else {
      setSelectedTo(location);
      setToInput(location.address);
      setShowToSuggestions(false);
    }
  };

  const findOptimalRoute = async () => {
    if (!selectedFrom || !selectedTo || isSearchingRoute || !window.mapboxgl) return;
    setIsSearchingRoute(true);
    
    try {
      const response = await fetch(`${API_BASE}/optimize-route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start_lat: selectedFrom.lat, start_lng: selectedFrom.lng,
          end_lat: selectedTo.lat, end_lng: selectedTo.lng
        })
      });

      if (response.ok) {
        const data = await response.json();
        const route = data.route;
        
        if (map.current.getSource('route')) {
          map.current.getSource('route').setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: route.geometry }]
          });
        }
        
        document.querySelectorAll('.route-marker').forEach(el => el.remove());
        new window.mapboxgl.Marker({ element: createMarker('📍') }).setLngLat([selectedFrom.lng, selectedFrom.lat]).addTo(map.current);
        new window.mapboxgl.Marker({ element: createMarker('🏁') }).setLngLat([selectedTo.lng, selectedTo.lat]).addTo(map.current);
        
        setActiveRoute({ ...route, from: selectedFrom.address, to: selectedTo.address });
      }
    } catch (e) { console.error(e); }
    finally { setIsSearchingRoute(false); }
  };

  const createMarker = (icon) => {
    const el = document.createElement('div');
    el.className = 'route-marker';
    el.innerHTML = icon;
    el.style.fontSize = '24px';
    return el;
  };

  const clearRoute = () => {
    if (map.current.getSource('route')) map.current.getSource('route').setData({ type: 'FeatureCollection', features: [] });
    document.querySelectorAll('.route-marker').forEach(el => el.remove());
    if (manualPinMode) disableManualPinMode();
    setActiveRoute(null);
    setSelectedFrom(null);
    setSelectedTo(null);
    setFromInput('');
    setToInput('');
  };

  // --- Chat & Filters ---
  const sendMessage = async () => {
    if (!input.trim() || isSending) return;
    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsSending(true);
    try {
      const response = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMessage })
      });
      if (response.ok) {
        const data = await response.json();
        setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
      }
    } catch (e) { console.error(e); }
    finally { setIsSending(false); }
  };

  const applyQuickFilter = (filterName) => {
    if (!map.current) return;
    // Reset first
    map.current.setFilter('busy-streets', ['>=', ['get', 'count'], 4]);
    map.current.setPaintProperty('busy-streets', 'line-color', [
       'interpolate', ['linear'], ['get', 'count'], 4, '#ffff00', 24, '#ff0000'
    ]);

    if (filterName === 'high-traffic') {
       map.current.setFilter('busy-streets', ['>=', ['get', 'count'], 15]);
       map.current.setPaintProperty('busy-streets', 'line-color', '#ff0000');
    } else if (filterName === 'low-congestion') {
       map.current.setFilter('busy-streets', ['all', ['>=', ['get', 'count'], 1], ['<=', ['get', 'count'], 5]]);
       map.current.setPaintProperty('busy-streets', 'line-color', '#00ff00');
    }
    setActiveFilter({ description: filterName });
  };

  const clearMapFilter = () => {
     if (!map.current) return;
     map.current.setFilter('busy-streets', ['>=', ['get', 'count'], 4]);
     map.current.setPaintProperty('busy-streets', 'line-color', [
        'interpolate', ['linear'], ['get', 'count'], 4, '#ffff00', 24, '#ff0000'
     ]);
     setActiveFilter(null);
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh' }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

        {/* Error Toast */}
        {mapError && (
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', background: 'red', color: 'white', padding: '1rem', borderRadius: '0.5rem' }}>
            <strong>Map Error:</strong> {mapError}
          </div>
        )}

        {/* Route Optimizer Panel */}
        <div style={{
          position: 'absolute', top: '10px', right: '10px', width: '320px',
          background: 'rgba(0,0,0,0.85)', color: 'white', padding: '1rem',
          borderRadius: '0.5rem', border: '1px solid #333',
          transform: routePanelOpen ? 'translateX(0)' : 'translateX(360px)',
          transition: 'transform 280ms ease', zIndex: 800
        }}>
          <h4 style={{ margin: '0 0 1rem 0', fontSize: '1rem' }}>🗺️ Route Optimizer</h4>

          {!manualPinMode ? (
            <>
              <div style={{ marginBottom: '0.75rem', position: 'relative' }}>
                <input type="text" value={fromInput} onChange={(e) => { setFromInput(e.target.value); searchLocations(e.target.value, true); }}
                  onFocus={() => setShowFromSuggestions(fromSuggestions.length > 0)} placeholder="📍 Pick up location"
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #444', background: '#1a1a1a', color: 'white', outline: 'none', boxSizing: 'border-box' }} />
                {showFromSuggestions && fromSuggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#2a2a2a', border: '1px solid #444', borderRadius: '0 0 0.375rem 0.375rem', maxHeight: '150px', overflowY: 'auto', zIndex: 1000 }}>
                    {fromSuggestions.map((s, idx) => (
                      <div key={idx} onClick={() => selectLocation(s, true)} style={{ padding: '0.5rem', cursor: 'pointer', borderBottom: '1px solid #333' }}>{s.address}</div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ marginBottom: '0.75rem', position: 'relative' }}>
                <input type="text" value={toInput} onChange={(e) => { setToInput(e.target.value); searchLocations(e.target.value, false); }}
                  onFocus={() => setShowToSuggestions(toSuggestions.length > 0)} placeholder="🏁 Drop off location"
                  style={{ width: '100%', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #444', background: '#1a1a1a', color: 'white', outline: 'none', boxSizing: 'border-box' }} />
                {showToSuggestions && toSuggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#2a2a2a', border: '1px solid #444', borderRadius: '0 0 0.375rem 0.375rem', maxHeight: '150px', overflowY: 'auto', zIndex: 1000 }}>
                    {toSuggestions.map((s, idx) => (
                      <div key={idx} onClick={() => selectLocation(s, false)} style={{ padding: '0.5rem', cursor: 'pointer', borderBottom: '1px solid #333' }}>{s.address}</div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button onClick={findOptimalRoute} disabled={!selectedFrom || !selectedTo || isSearchingRoute}
                  style={{ flex: 1, padding: '0.75rem', borderRadius: '0.375rem', border: 'none', background: (!selectedFrom || !selectedTo || isSearchingRoute) ? '#444' : '#0066cc', color: 'white', cursor: 'pointer', fontWeight: '600' }}>
                  {isSearchingRoute ? '⏳' : '🔍 Find Route'}
                </button>
                {(activeRoute || isSearchingRoute) && (
                  <button onClick={clearRoute} style={{ padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #666', background: 'transparent', color: '#ccc', cursor: 'pointer' }}>❌</button>
                )}
              </div>
              <div style={{ borderTop: '1px solid #333', paddingTop: '0.75rem', marginTop: '0.75rem' }}>
                <button onClick={enableManualPinMode} style={{ width: '100%', padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #ff9900', background: 'transparent', color: '#ff9900', cursor: 'pointer', fontWeight: '600', marginBottom: '0.5rem' }}>
                  🎯 Manual Pin Selection
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ padding: '0.75rem', background: '#1a1a1a', borderRadius: '0.375rem', border: '1px solid #ff9900', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
                <div style={{ color: '#ff9900', fontWeight: '600', marginBottom: '0.5rem' }}>🎯 Manual Pin Mode Active</div>
                <div style={{ fontSize: '0.75rem', color: '#ccc' }}>Drag the 📍 and 🏁 pins on the map.</div>
              </div>

              {/* Route Preference Toggle */}
              <div style={{ marginBottom: '1rem', padding: '0.5rem', background: '#222', borderRadius: '4px' }}>
                <label style={{ color: '#aaa', fontSize: '0.75rem', display: 'block', marginBottom: '0.5rem' }}>Route Preference</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button onClick={() => setRouteMode('fastest')} style={{ flex: 1, padding: '0.4rem', borderRadius: '4px', border: 'none', background: routeMode === 'fastest' ? '#0066cc' : '#333', color: 'white', fontSize: '0.75rem', cursor: 'pointer' }}>🚀 Fastest</button>
                  <button onClick={() => setRouteMode('quiet')} style={{ flex: 1, padding: '0.4rem', borderRadius: '4px', border: 'none', background: routeMode === 'quiet' ? '#00cc66' : '#333', color: 'white', fontSize: '0.75rem', cursor: 'pointer' }}>🌳 Quietest</button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <button onClick={findAIRoute} disabled={!manualPickupCoords || !manualDropoffCoords || isSearchingRoute}
                  style={{ flex: 1, padding: '0.75rem', borderRadius: '0.375rem', border: 'none', background: (!manualPickupCoords || !manualDropoffCoords || isSearchingRoute) ? '#444' : '#00cc66', color: 'white', cursor: 'pointer', fontWeight: '600' }}>
                  {isSearchingRoute ? '⏳' : '🤖 Calculate'}
                </button>
                <button onClick={resetManualPins} style={{ flex: 1, padding: '0.75rem', borderRadius: '0.375rem', border: '1px solid #ff3333', background: 'transparent', color: '#ff3333', cursor: 'pointer', fontWeight: '600' }}>🗑️ Reset</button>
              </div>
              <button onClick={disableManualPinMode} style={{ width: '100%', padding: '0.6rem', borderRadius: '0.375rem', border: '1px solid #666', background: 'transparent', color: '#999', cursor: 'pointer', fontSize: '0.8rem' }}>← Back to Address Search</button>
            </>
          )}

          {activeRoute && (
            <div style={{ padding: '0.5rem', background: '#1a1a1a', borderRadius: '0.375rem', border: '1px solid #444', fontSize: '0.8rem', marginTop: '0.75rem' }}>
              <div style={{ color: '#1e90ff', fontWeight: '600', marginBottom: '0.25rem' }}>📊 Route Summary</div>
              <div>⏱️ {Math.round(activeRoute.duration / 60)} minutes</div>
              <div>📏 {Math.round(activeRoute.distance / 1000 * 10) / 10} km</div>
              <div>🚦 Mode: {routeMode}</div>
            </div>
          )}
        </div>

        {/* Stats Overlay (Pickups/Dropoffs) */}
        {stats && (
          <div style={{ position: 'absolute', top: '10px', left: '10px', background: 'rgba(0,0,0,0.7)', color: 'white', padding: '1rem', borderRadius: '0.5rem' }}>
            <div>Pickups: {stats.total_pickups}</div>
            <div>Dropoffs: {stats.total_dropoffs}</div>
          </div>
        )}

        {topZones.length > 0 && (
          <div style={{ 
            position: 'absolute', 
            top: '110px',
            left: '10px', 
            background: 'rgba(0,0,0,0.7)', 
            color: 'white', 
            padding: '1rem', 
            borderRadius: '0.5rem',
            width: '230px',
            border: '1px solid #444',
            backdropFilter: 'blur(4px)'
          }}>
            <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem', color: '#ff3333', display:'flex', alignItems:'center' }}>
              Top 5 Congested
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem' }}>
              {topZones.map((zone, i) => (
                <div 
                  key={i} 
                  onClick={() => focusOnZone(zone)}
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    borderBottom: i < 4 ? '1px solid #333' : 'none', 
                    paddingBottom: i < 4 ? '0.25rem' : '0',
                    cursor: 'pointer',
                    transition: 'background 0.2s',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <div style={{display:'flex', alignItems:'center', gap:'4px', overflow: 'hidden'}}>
                      <span style={{fontSize:'0.8rem'}}>🎯</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '120px', color: '#ccc' }}>
                        {zone.name}
                      </span>
                  </div>
                  <span style={{ fontWeight: 'bold', color: '#ffaa00' }}>
                    {zone.activity}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Passenger Modal Overlay */}
        {showPassengerModal && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <div style={{
              width: '300px', background: '#1a1a1a', padding: '1.5rem',
              borderRadius: '0.5rem', border: '1px solid #444',
              boxShadow: '0 10px 25px rgba(0,0,0,0.5)'
            }}>
              <h3 style={{ color: 'white', marginTop: 0, fontSize: '1.1rem' }}>🙋 Where are you?</h3>
              <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: '1rem' }}>
                Enter your current location or landmark.
              </p>
              
              <input 
                autoFocus
                type="text" 
                value={passengerLocationInput}
                onChange={(e) => setPassengerLocationInput(e.target.value)}
                placeholder="e.g. Grand Central, 5th Ave & 42nd"
                onKeyPress={(e) => e.key === 'Enter' && handlePassengerSubmit()}
                style={{
                  width: '100%', padding: '0.75rem', marginBottom: '1rem',
                  borderRadius: '4px', border: '1px solid #444',
                  background: '#2a2a2a', color: 'white', outline: 'none'
                }}
              />
              
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  onClick={() => setShowPassengerModal(false)}
                  style={{
                    flex: 1, padding: '0.6rem', borderRadius: '4px',
                    border: '1px solid #444', background: 'transparent',
                    color: '#aaa', cursor: 'pointer'
                  }}>
                  Cancel
                </button>
                <button 
                  onClick={handlePassengerSubmit}
                  disabled={!passengerLocationInput.trim()}
                  style={{
                    flex: 1, padding: '0.6rem', borderRadius: '4px',
                    border: 'none', background: '#0066cc',
                    color: 'white', fontWeight: 'bold', cursor: 'pointer'
                  }}>
                  Find Spot
                </button>
              </div>
            </div>
          </div>
        )}

        {/* NEW: Developer API Modal */}
        {showDevModal && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: '500px', background: '#1a1a1a', padding: '1.5rem', borderRadius: '0.5rem', border: '1px solid #444', boxShadow: '0 10px 40px rgba(0,0,0,0.7)', display:'flex', flexDirection:'column', maxHeight:'90vh' }}>
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'1rem'}}>
                  <h3 style={{ color: '#00ff00', margin: 0, fontSize: '1.2rem', fontFamily: 'monospace' }}>&lt;Developer Console /&gt;</h3>
                  <button onClick={() => setShowDevModal(false)} style={{background:'none', border:'none', color:'#aaa', fontSize:'1.5rem', cursor:'pointer'}}>×</button>
              </div>
              
              <p style={{ color: '#ccc', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                Simulate external partner data ingestion (e.g., Uber, Lyft, City Transit).
              </p>

              <div style={{marginBottom:'1rem'}}>
                  <label style={{display:'block', color:'#666', fontSize:'0.75rem', marginBottom:'4px'}}>API Key</label>
                  <input type="text" value={devApiKey} onChange={e => setDevApiKey(e.target.value)} style={{width:'100%', padding:'0.5rem', background:'#111', border:'1px solid #333', color:'#fff', fontFamily:'monospace'}} />
              </div>

              <div style={{marginBottom:'1rem', flex:1}}>
                  <label style={{display:'block', color:'#666', fontSize:'0.75rem', marginBottom:'4px'}}>JSON Payload</label>
                  <textarea 
                    value={devJsonPayload} 
                    onChange={e => setDevJsonPayload(e.target.value)}
                    style={{width:'100%', height:'200px', padding:'0.5rem', background:'#111', border:'1px solid #333', color:'#0f0', fontFamily:'monospace', fontSize:'0.8rem', resize:'none'}} 
                  />
              </div>

              {devResponse && (
                  <div style={{marginBottom:'1rem', padding:'0.5rem', background: devResponse.error ? 'rgba(255,0,0,0.1)' : 'rgba(0,255,0,0.1)', border: devResponse.error ? '1px solid red' : '1px solid green', borderRadius:'4px'}}>
                      <pre style={{margin:0, fontSize:'0.75rem', color: devResponse.error ? '#ff5555' : '#55ff55', whiteSpace:'pre-wrap'}}>
                          {JSON.stringify(devResponse, null, 2)}
                      </pre>
                  </div>
              )}

              <button 
                onClick={sendPartnerData}
                style={{ width: '100%', padding: '0.75rem', borderRadius: '4px', border: 'none', background: '#0066cc', color: 'white', fontWeight: 'bold', cursor: 'pointer', fontSize:'0.9rem' }}>
                POST /api/v1/partner/ingest
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Chat Panel */}
      <div style={{ width: '350px', background: '#1a1a1a', display: 'flex', flexDirection: 'column', borderLeft: '1px solid #333', position: 'relative', zIndex: 1000 }}>
        <div style={{ padding: '1rem', background: '#2a2a2a', borderBottom: '1px solid #333', color: 'white', position: 'relative' }}>
          <button onClick={() => setRoutePanelOpen(prev => !prev)} style={{ position: 'absolute', left: '-18px', top: '12px', width: '36px', height: '36px', borderRadius: '6px', border: '1px solid #444', background: '#111', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>{routePanelOpen ? '◀' : '▶'}</button>
          <h3 style={{ margin: 0, fontSize: '1rem' }}>🚕 Traffic AI Assistant</h3>
        </div>

        {/* Recommendations Section */}
        <div style={{ padding: '0.75rem', background: '#222', borderBottom: '1px solid #333' }}>
          <label style={{ fontSize: '0.8rem', color: '#aaa', display: 'block', marginBottom: '0.5rem' }}>🧠 Smart Recommendations</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
            <button onClick={askBestTime} style={{ padding: '0.5rem', background: '#333', border: '1px solid #444', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>🕒 Best time to travel?</button>
            <button onClick={() => { setShowDriverTools(!showDriverTools); if(!showDriverTools) fetchDriverRecommendations(); else clearDriverHotspots(); }} style={{ padding: '0.5rem', background: showDriverTools ? '#ffaa00' : '#333', border: '1px solid #444', color: showDriverTools ? '#000' : '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left' }}>🚕 Driver: Where to go?</button>
            <button onClick={() => setShowPassengerModal(true)} style={{ gridColumn: 'span 2', padding: '0.6rem', background: '#0066cc', border: '1px solid #444', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem', textAlign: 'center', fontWeight: 'bold' }}><span>🙋</span> Passenger: Where should I stand?</button>
          </div>
        </div>

        {/* Quick Filters */}
        <div style={{ padding: '0.75rem', background: '#222', borderBottom: '1px solid #333' }}>
          <label style={{ fontSize: '0.8rem', color: '#aaa', display: 'block', marginBottom: '0.25rem' }}>⚡ Quick Filters</label>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            <button onClick={() => applyQuickFilter('high-traffic')} style={{ padding: '0.3rem 0.5rem', borderRadius: '0.375rem', border: '1px solid #ff3333', background: activeFilter?.description?.includes('High') ? '#ff3333' : 'transparent', color: 'white', cursor: 'pointer', fontSize: '0.7rem' }}>🔴 High</button>
            <button onClick={() => applyQuickFilter('low-congestion')} style={{ padding: '0.3rem 0.5rem', borderRadius: '0.375rem', border: '1px solid #00ff00', background: activeFilter?.description?.includes('Low') ? '#00ff00' : 'transparent', color: activeFilter?.description?.includes('Low') ? '#000' : 'white', cursor: 'pointer', fontSize: '0.7rem' }}>🟢 Low</button>
            {activeFilter && ( <button onClick={clearMapFilter} style={{ padding: '0.3rem 0.5rem', borderRadius: '0.375rem', border: '1px solid #666', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: '0.7rem' }}>Clear</button> )}
          </div>
        </div>
        
        {/* NEW: Developer Tools Section */}
        <div style={{ padding: '0.75rem', background: '#1a1a1a', borderBottom: '1px solid #333' }}>
           <button 
             onClick={() => setShowDevModal(true)}
             style={{
               width: '100%', padding: '0.5rem', background: '#111', border: '1px dashed #666', 
               color: '#00ff00', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem', fontFamily: 'monospace'
             }}>
             &lt;Developer Console /&gt;
           </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {messages.length === 0 && ( <div style={{ color: '#666', fontSize: '0.85rem', textAlign: 'center', marginTop: '1rem' }}><p>👋 Hi! Ask about traffic or check the recommendations above.</p></div> )}
          {messages.map((msg, idx) => ( <div key={idx} style={{ alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '90%' }}> <div style={{ padding: '0.6rem', borderRadius: '0.75rem', background: msg.role === 'user' ? '#0066cc' : '#2a2a2a', color: 'white', fontSize: '0.8rem', lineHeight: '1.4', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>{msg.content}</div> </div> ))}
          <div ref={chatEndRef} />
        </div>

        <div style={{ padding: '0.75rem', background: '#2a2a2a', borderTop: '1px solid #333' }}>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input type="text" value={input} onChange={(e) => setInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && sendMessage()} placeholder="Ask about traffic..." disabled={isSending} style={{ flex: 1, padding: '0.6rem', borderRadius: '0.5rem', border: '1px solid #444', background: '#1a1a1a', color: 'white', fontSize: '0.85rem', outline: 'none' }} />
            <button onClick={sendMessage} disabled={isSending || !input.trim()} style={{ padding: '0.6rem 1rem', borderRadius: '0.5rem', border: 'none', background: isSending || !input.trim() ? '#444' : '#0066cc', color: 'white', cursor: isSending || !input.trim() ? 'not-allowed' : 'pointer', fontSize: '0.85rem', fontWeight: '600' }}>Send</button>
          </div>
        </div>
      </div>
    </div>
  );
}