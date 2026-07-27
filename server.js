const express = require("express");
const cache = require("./lib/cache");
const fec = require("./lib/fec");
const census = require("./lib/census");
const { getAllHouseSeats, getAllSenateSeats } = require("./seats");

const app = express();
const PORT = process.env.PORT || 3001;

// How long cached data is trusted before we re-hit the source API.
const RACE_TTL_MS = 3 * 24 * 60 * 60 * 1000;      // 3 days — money changes with filings
const DISTRICT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days — demographics barely move

app.use(express.static("public"));

// GET /api/race/CA/12   or   /api/race/TX/senate
app.get("/api/race/:state/:district", async (req, res) => {
  const { state, district } = req.params;
  const key = `${state.toUpperCase()}-${district}`;
  try {
    const result = await cache.getOrFetch("fec", key, RACE_TTL_MS, () =>
      fec.fetchRace(state, district)
    );
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/district/CA/12
app.get("/api/district/:state/:district", async (req, res) => {
  const { state, district } = req.params;
  const key = `${state.toUpperCase()}-${district}`;
  try {
    const result = await cache.getOrFetch("census", key, DISTRICT_TTL_MS, () =>
      census.fetchDistrictProfile(state, district)
    );
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Force a fresh pull regardless of cache age (a manual "refresh" button)
app.post("/api/race/:state/:district/refresh", async (req, res) => {
  const { state, district } = req.params;
  const key = `${state.toUpperCase()}-${district}`;
  try {
    const fresh = await fec.fetchRace(state, district);
    cache.write("fec", key, fresh);
    res.json({ data: fresh, fromCache: false, ageDays: 0 });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/seats — every House + Senate seat, with cache status
app.get("/api/seats", (req, res) => {
  const seats = [...getAllHouseSeats(), ...getAllSenateSeats().map((s) => ({ state: s.state, district: "senate" }))];
  const withStatus = seats.map((s) => {
    const key = `${s.state}-${s.district}`;
    const entry = cache.read("fec", key);
    return {
      state: s.state,
      district: s.district,
      cached: !!entry,
      ageDays: cache.ageDays(entry),
    };
  });
  res.json({ count: withStatus.length, seats: withStatus });
});

app.listen(PORT, () => {
  console.log(`Election data server running on http://localhost:${PORT}`);
});
