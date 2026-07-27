const express = require("express");
const fs = require("fs");
const path = require("path");
const cache = require("./lib/cache");
const fec = require("./lib/fec");
const census = require("./lib/census");
const { getAllHouseSeats, getAllSenateSeats, HOUSE_SEATS_BY_STATE } = require("./seats");

const app = express();
const PORT = process.env.PORT || 3001;

const RACE_TTL_MS = 3 * 24 * 60 * 60 * 1000;       // 3 days
const DISTRICT_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

// Serve the frontend (index.html lives in public/)
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------ */
/* Original API routes                                                 */
/* ------------------------------------------------------------------ */

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

app.get("/api/seats", (req, res) => {
  const seats = [
    ...getAllHouseSeats(),
    ...getAllSenateSeats().map((s) => ({ state: s.state, district: "senate" })),
  ];
  const withStatus = seats.map((s) => {
    const key = `${s.state}-${s.district}`;
    const entry = cache.read("fec", key);
    return { state: s.state, district: s.district, cached: !!entry, ageDays: cache.ageDays(entry) };
  });
  res.json({ count: withStatus.length, seats: withStatus });
});

/* ------------------------------------------------------------------ */
/* Compatibility routes — match the frontend's expected URLs & shapes  */
/* ------------------------------------------------------------------ */

function partyCode(partyFull) {
  if (!partyFull) return "?";
  const p = String(partyFull).toUpperCase();
  if (p.includes("DEMOCRAT")) return "DEM";
  if (p.includes("REPUBLICAN")) return "REP";
  if (p.includes("LIBERTARIAN")) return "LIB";
  if (p.includes("GREEN")) return "GRN";
  if (p.includes("INDEPENDENT")) return "IND";
  return p.slice(0, 3);
}

// GET /api/fec-race?state=AZ&district=02&office=H&cycle=2026
app.get("/api/fec-race", async (req, res) => {
  const state = String(req.query.state || "").toUpperCase();
  let district = String(req.query.district || "");
  const office = String(req.query.office || "H").toUpperCase();
  if (!state) return res.status(400).json({ error: "Missing state" });

  // Frontend sends "00" for at-large; our fetcher handles 01->00 fallback,
  // and FEC generally records at-large as "00", so pass through as-is.
  const seatParam = office === "S" ? "senate" : district || "01";
  const key = `${state}-${seatParam}`;

  try {
    const result = await cache.getOrFetch("fec", key, RACE_TTL_MS, () =>
      fec.fetchRace(state, seatParam)
    );
    const d = result.data;
    res.json({
      race: d.race,
      cached: result.fromCache,
      cache_age_days: result.ageDays,
      candidates: (d.candidates || []).map((c) => ({
        candidate_id: c.candidate_id,
        name: c.name,
        party: partyCode(c.party),
        incumbent_challenge: c.incumbent_challenge,
        totals:
          c.raised != null || c.spent != null || c.cash_on_hand != null
            ? {
                receipts: c.raised,
                disbursements: c.spent,
                cash_on_hand: c.cash_on_hand,
                last_debts_owed_by_committee: c.debt,
                coverage_end_date: c.coverage_end_date,
              }
            : null,
      })),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// GET /api/census-district?state=AZ&cd=2   (cd=0 means at-large)
app.get("/api/census-district", async (req, res) => {
  const state = String(req.query.state || "").toUpperCase();
  let cd = String(req.query.cd || "");
  if (!state || cd === "") return res.status(400).json({ error: "Missing state or cd" });
  if (cd === "0") cd = "00"; // at-large

  const key = `${state}-${cd}`;
  try {
    const result = await cache.getOrFetch("census", key, DISTRICT_TTL_MS, () =>
      census.fetchDistrictProfile(state, cd)
    );
    const p = result.data;
    res.json({
      cached: result.fromCache,
      profile: {
        "Population": p.population?.toLocaleString("en-US") ?? "—",
        "Median household income": p.median_household_income != null ? "$" + p.median_household_income.toLocaleString("en-US") : "—",
        "Median age": p.median_age ?? "—",
        "Bachelor's or higher": p.bachelors_or_higher_pct != null ? p.bachelors_or_higher_pct + "%" : "—",
        "Poverty rate": p.poverty_rate_pct != null ? p.poverty_rate_pct + "%" : "—",
        "Homeownership": p.homeownership_rate_pct != null ? p.homeownership_rate_pct + "%" : "—",
      },
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Polls — served from api/polls-data.json (approved entries only)     */
/* ------------------------------------------------------------------ */

function loadPolls() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "api", "polls-data.json"), "utf8");
    return JSON.parse(raw).filter((p) => p.reviewStatus === "approved");
  } catch {
    return [];
  }
}

// GET /api/polls?race_id=AZ-H-02-2026
app.get("/api/polls", (req, res) => {
  const raceId = String(req.query.race_id || "");
  const polls = loadPolls().filter((p) => p.raceId === raceId);
  res.json({ race_id: raceId, polls });
});

// GET /api/poll-average?race_id=AZ-H-02-2026  (weighted by poll weight)
app.get("/api/poll-average", (req, res) => {
  const raceId = String(req.query.race_id || "");
  const polls = loadPolls().filter((p) => p.raceId === raceId);
  const sums = {};
  let weightTotal = 0;
  for (const poll of polls) {
    const w = Number(poll.weight) || 1;
    weightTotal += w;
    for (const r of poll.results || []) {
      sums[r.candidate] = (sums[r.candidate] || 0) + w * Number(r.pct || 0);
    }
  }
  const average = weightTotal
    ? Object.entries(sums).map(([candidate, s]) => ({
        candidate,
        pct: +(s / weightTotal).toFixed(1),
      }))
    : [];
  res.json({ race_id: raceId, poll_count: polls.length, average });
});

app.listen(PORT, () => {
  console.log(`Election data server running on http://localhost:${PORT}`);
});
