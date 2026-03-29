const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const express = require("express");
const fs = require("fs");
const app = express();

app.use(express.json());
app.use(express.static("."));

const data = JSON.parse(fs.readFileSync("./data.json", "utf-8"));

// ---------------- DISTANCE ----------------
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------- GEOCODING ----------------
async function getCoordinates(city) {
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1`
    );
    const data = await res.json();

    if (!data.results || data.results.length === 0) return null;

    return {
      lat: data.results[0].latitude,
      lon: data.results[0].longitude
    };
  } catch {
    return null;
  }
}

// ---------------- WEATHER (FIXED) ----------------
async function getWeather(lat, lon) {
  try {
    if (!lat || !lon) return null;

    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`
    );

    const data = await res.json();

    if (!data.current_weather) return null;

    return data.current_weather.temperature;
  } catch (err) {
    console.log("Weather error:", err);
    return null;
  }
}

// ---------------- TRAVEL ENGINE ----------------
function getTravelOptions(distance, people, factor) {
  const d = Math.max(distance, 50);

  return {
    flight: {
      time: Math.round(((d / 600) + 3) * 2),
      cost: Math.round(d * 5 * factor * 2 * people)
    },
    train: {
      time: Math.round(((d / 60) + 1) * 2),
      cost: Math.round(d * 1.5 * 2 * people)
    },
    bus: {
      time: Math.round(((d / 50) + 1) * 2),
      cost: Math.round(d * 1.2 * 2 * people)
    }
  };
}

// ---------------- REASON ----------------
function getReason(mode, distance, days) {
  if (distance > 800 && mode === "flight") return "long distance - saves time";
  if (distance < 300 && mode === "bus") return "short distance - efficient";
  if (mode === "train") return "balanced option";
  if (days <= 2 && mode === "flight") return "short trip - faster matters";
  return "good overall option";
}

// ---------------- STEP 1 ----------------
app.post("/step1", async (req, res) => {
  const { city, people } = req.body;

  const origin = await getCoordinates(city);
  if (!origin) return res.json({ error: "City not found" });

  const results = await Promise.all(data.map(async p => {

    // ✅ Ensure coordinates exist
    let lat = p.lat;
    let lon = p.lon;

    if (!lat || !lon) {
      const coords = await getCoordinates(p.name);
      if (coords) {
        lat = coords.lat;
        lon = coords.lon;
      }
    }

    const dist = getDistance(origin.lat, origin.lon, lat, lon);
    const t = getTravelOptions(dist, people, p.flightFactor || 1);

    const temp = await getWeather(lat, lon);

    return {
      name: p.name,
      distance: dist,
      idealDays: p.idealDays,
      temperature: temp,
      flight: t.flight,
      train: t.train,
      bus: t.bus
    };
  }));

  res.json(results);
});

// ---------------- STEP 2 ----------------
app.post("/step2", (req, res) => {
  const { data, days } = req.body;

  const results = data.map(r => {
    const modes = [
      { name: "flight", ...r.flight },
      { name: "train", ...r.train },
      { name: "bus", ...r.bus }
    ];

    const costs = modes.map(m => m.cost);
    const times = modes.map(m => m.time);

    const minC = Math.min(...costs), maxC = Math.max(...costs);
    const minT = Math.min(...times), maxT = Math.max(...times);

    let best = null;
    let bestScore = -Infinity;

    modes.forEach(m => {
      let costScore = (maxC - m.cost) / (maxC - minC || 1);
      let timeScore = (maxT - m.time) / (maxT - minT || 1);

      let score = costScore * 0.5 + timeScore * 0.5;

      // ✅ WEATHER IMPACT (NEW)
      if (r.temperature !== null) {
        if (r.temperature > 35) score -= 0.2;
        if (r.temperature >= 20 && r.temperature <= 30) score += 0.2;
      }

      if (r.distance > 800 && m.name === "flight") score += 0.25;
      if (r.distance < 300 && m.name === "bus") score += 0.2;
      if (days <= 2 && m.name === "flight") score += 0.2;

      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    });

    return {
      ...r,
      bestMode: best.name,
      bestCost: best.cost,
      bestTime: best.time,
      reason: getReason(best.name, r.distance, days)
    };
  });

  res.json(results);
});

// ---------------- STEP 3 ----------------
app.post("/step3", (req, res) => {
  const { data, days } = req.body;

  const total = days * 24;

  let results = data.filter(r => {
    const burden = r.bestTime / total;
    return burden <= 0.35 && days >= r.idealDays;
  });

  results.sort((a, b) => {
    const scoreA = (0.6 * (1 / a.bestCost)) + (0.4 * (1 / a.bestTime));
    const scoreB = (0.6 * (1 / b.bestCost)) + (0.4 * (1 / b.bestTime));
    return scoreB - scoreA;
  });

  res.json(results.slice(0, 5));
});

// ---------------- SERVER ----------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
