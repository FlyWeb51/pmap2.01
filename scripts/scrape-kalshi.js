/**
 * scripts/scrape-kalshi.js
 *
 * Fetches Kalshi's live, public (no API key) prediction-market prices for
 * every 2026 Senate race, server-side (GitHub Actions has no CORS
 * restriction -- that only applies to browsers, which is why this can't
 * run client-side despite needing no key).
 *
 * Ticker pattern, confirmed from a real live Kalshi market:
 *   SENATE{2-letter state}-26-D   (Democrat wins the seat)
 *   SENATE{2-letter state}-26-R   (Republican wins the seat)
 * States with no 2026 race, or where Kalshi hasn't listed the market yet,
 * simply 404 -- handled gracefully, not a failure.
 *
 * Prices are cents-as-dollars (e.g. "0.4600" = 46 cents = 46% implied
 * probability). We report yes_bid/yes_ask (the live tradeable spread) and
 * last_price (the most recent actual trade) so the frontend can show
 * whichever is most meaningful.
 *
 * Run on its own tighter schedule (e.g. every 30 min) -- separate from the
 * main 12-hour data build, since this is a fast, cheap set of lookups.
 */

const fs = require("fs");
const path = require("path");

const BASE = process.env.KALSHI_BASE || "https://external-api.kalshi.com/trade-api/v2";
const UA = "pmap2.01-kalshi-fetcher/1.0 (educational election tracker; contact via repo issues)";
const OUT_DIR = path.join(__dirname, "..", "data", "kalshi");

// All 35 states with a 2026 Senate race (from the confirmed PollingSource
// hub-page enumeration earlier in this project). Kalshi will 404 cleanly
// for any state where it hasn't listed a market -- caught, not fatal.
const SENATE_STATES = [
  "AK", "IA", "ME", "MI", "NE", "SC", "TX", // Toss-up
  "MN", "OH", "GA", "NC", "NH",             // Lean/Likely D
  "FL",                                     // Lean/Likely R (special)
  "CO", "DE", "IL", "MA", "NJ", "NM", "OR", "RI", "VA", // Safe D
  "AL", "AR", "ID", "KS", "KY", "LA", "MS", "MT", "OK", "SD", "TN", "WV", "WY", // Safe R
];

const ALL_HOUSE_DISTRICTS = [
  "AL-01", "AL-02", "AL-03", "AL-04", "AL-05", "AL-06", "AL-07", "AK-01", "AZ-01", "AZ-02",
  "AZ-03", "AZ-04", "AZ-05", "AZ-06", "AZ-07", "AZ-08", "AZ-09", "AR-01", "AR-02", "AR-03",
  "AR-04", "CA-01", "CA-02", "CA-03", "CA-04", "CA-05", "CA-06", "CA-07", "CA-08", "CA-09",
  "CA-10", "CA-11", "CA-12", "CA-13", "CA-14", "CA-15", "CA-16", "CA-17", "CA-18", "CA-19",
  "CA-20", "CA-21", "CA-22", "CA-23", "CA-24", "CA-25", "CA-26", "CA-27", "CA-28", "CA-29",
  "CA-30", "CA-31", "CA-32", "CA-33", "CA-34", "CA-35", "CA-36", "CA-37", "CA-38", "CA-39",
  "CA-40", "CA-41", "CA-42", "CA-43", "CA-44", "CA-45", "CA-46", "CA-47", "CA-48", "CA-49",
  "CA-50", "CA-51", "CA-52", "CO-01", "CO-02", "CO-03", "CO-04", "CO-05", "CO-06", "CO-07",
  "CO-08", "CT-01", "CT-02", "CT-03", "CT-04", "CT-05", "DE-01", "FL-01", "FL-02", "FL-03",
  "FL-04", "FL-05", "FL-06", "FL-07", "FL-08", "FL-09", "FL-10", "FL-11", "FL-12", "FL-13",
  "FL-14", "FL-15", "FL-16", "FL-17", "FL-18", "FL-19", "FL-20", "FL-21", "FL-22", "FL-23",
  "FL-24", "FL-25", "FL-26", "FL-27", "FL-28", "GA-01", "GA-02", "GA-03", "GA-04", "GA-05",
  "GA-06", "GA-07", "GA-08", "GA-09", "GA-10", "GA-11", "GA-12", "GA-13", "GA-14", "HI-01",
  "HI-02", "ID-01", "ID-02", "IL-01", "IL-02", "IL-03", "IL-04", "IL-05", "IL-06", "IL-07",
  "IL-08", "IL-09", "IL-10", "IL-11", "IL-12", "IL-13", "IL-14", "IL-15", "IL-16", "IL-17",
  "IN-01", "IN-02", "IN-03", "IN-04", "IN-05", "IN-06", "IN-07", "IN-08", "IN-09", "IA-01",
  "IA-02", "IA-03", "IA-04", "KS-01", "KS-02", "KS-03", "KS-04", "KY-01", "KY-02", "KY-03",
  "KY-04", "KY-05", "KY-06", "LA-01", "LA-02", "LA-03", "LA-04", "LA-05", "LA-06", "ME-01",
  "ME-02", "MD-01", "MD-02", "MD-03", "MD-04", "MD-05", "MD-06", "MD-07", "MD-08", "MA-01",
  "MA-02", "MA-03", "MA-04", "MA-05", "MA-06", "MA-07", "MA-08", "MA-09", "MI-01", "MI-02",
  "MI-03", "MI-04", "MI-05", "MI-06", "MI-07", "MI-08", "MI-09", "MI-10", "MI-11", "MI-12",
  "MI-13", "MN-01", "MN-02", "MN-03", "MN-04", "MN-05", "MN-06", "MN-07", "MN-08", "MS-01",
  "MS-02", "MS-03", "MS-04", "MO-01", "MO-02", "MO-03", "MO-04", "MO-05", "MO-06", "MO-07",
  "MO-08", "MT-01", "MT-02", "NE-01", "NE-02", "NE-03", "NV-01", "NV-02", "NV-03", "NV-04",
  "NH-01", "NH-02", "NJ-01", "NJ-02", "NJ-03", "NJ-04", "NJ-05", "NJ-06", "NJ-07", "NJ-08",
  "NJ-09", "NJ-10", "NJ-11", "NJ-12", "NM-01", "NM-02", "NM-03", "NY-01", "NY-02", "NY-03",
  "NY-04", "NY-05", "NY-06", "NY-07", "NY-08", "NY-09", "NY-10", "NY-11", "NY-12", "NY-13",
  "NY-14", "NY-15", "NY-16", "NY-17", "NY-18", "NY-19", "NY-20", "NY-21", "NY-22", "NY-23",
  "NY-24", "NY-25", "NY-26", "NC-01", "NC-02", "NC-03", "NC-04", "NC-05", "NC-06", "NC-07",
  "NC-08", "NC-09", "NC-10", "NC-11", "NC-12", "NC-13", "NC-14", "ND-01", "OH-01", "OH-02",
  "OH-03", "OH-04", "OH-05", "OH-06", "OH-07", "OH-08", "OH-09", "OH-10", "OH-11", "OH-12",
  "OH-13", "OH-14", "OH-15", "OK-01", "OK-02", "OK-03", "OK-04", "OK-05", "OR-01", "OR-02",
  "OR-03", "OR-04", "OR-05", "OR-06", "PA-01", "PA-02", "PA-03", "PA-04", "PA-05", "PA-06",
  "PA-07", "PA-08", "PA-09", "PA-10", "PA-11", "PA-12", "PA-13", "PA-14", "PA-15", "PA-16",
  "PA-17", "RI-01", "RI-02", "SC-01", "SC-02", "SC-03", "SC-04", "SC-05", "SC-06", "SC-07",
  "SD-01", "TN-01", "TN-02", "TN-03", "TN-04", "TN-05", "TN-06", "TN-07", "TN-08", "TN-09",
  "TX-01", "TX-02", "TX-03", "TX-04", "TX-05", "TX-06", "TX-07", "TX-08", "TX-09", "TX-10",
  "TX-11", "TX-12", "TX-13", "TX-14", "TX-15", "TX-16", "TX-17", "TX-18", "TX-19", "TX-20",
  "TX-21", "TX-22", "TX-23", "TX-24", "TX-25", "TX-26", "TX-27", "TX-28", "TX-29", "TX-30",
  "TX-31", "TX-32", "TX-33", "TX-34", "TX-35", "TX-36", "TX-37", "TX-38", "UT-01", "UT-02",
  "UT-03", "UT-04", "VT-01", "VA-01", "VA-02", "VA-03", "VA-04", "VA-05", "VA-06", "VA-07",
  "VA-08", "VA-09", "VA-10", "VA-11", "WA-01", "WA-02", "WA-03", "WA-04", "WA-05", "WA-06",
  "WA-07", "WA-08", "WA-09", "WA-10", "WV-01", "WV-02", "WI-01", "WI-02", "WI-03", "WI-04",
  "WI-05", "WI-06", "WI-07", "WI-08", "WY-01",
];

/* ------------------------------------------------------------------------
 * v2 fixes (Oct 2026):
 *  - Kalshi lists Democrat and Republican as two SEPARATE yes/no markets, so
 *    the raw prices rarely add to 100 (e.g. 98.1 + 2.4). We now keep the raw
 *    price AND a normalized share (D / (D + R)) so the map colors and the
 *    overview page read consistently.
 *  - Requests run in parallel with a small concurrency cap and retry on
 *    429/5xx. The old one-at-a-time loop took several minutes per run, which
 *    is part of why GitHub's scheduler kept slipping the "30 min" job to
 *    every 3 to 7 hours.
 *  - National House/Senate control markets are fetched for the overview page.
 *  - The script now exits non-zero if Kalshi is unreachable, so a broken run
 *    shows red in Actions instead of silently committing nothing.
 * ---------------------------------------------------------------------- */

const CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, attempt = 0) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404) return null; // market/event not listed -- not an error
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(800 * Math.pow(2, attempt));
    return fetchJson(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`Kalshi ${res.status} for ${url}`);
  return res.json();
}

async function fetchMarket(ticker) {
  const data = await fetchJson(`${BASE}/markets/${ticker}`);
  return data && data.market ? data.market : null;
}

function toProbability(market) {
  if (!market) return null;
  if (market.status && !["active", "open", "initialized"].includes(String(market.status).toLowerCase())) {
    // settled/closed markets: fall through to last price, still informative
  }
  const bid = Number(market.yes_bid_dollars ?? (market.yes_bid != null ? market.yes_bid / 100 : NaN));
  const ask = Number(market.yes_ask_dollars ?? (market.yes_ask != null ? market.yes_ask / 100 : NaN));
  const last = Number(market.last_price_dollars ?? (market.last_price != null ? market.last_price / 100 : NaN));
  let pct;
  // Only trust the midpoint when the spread is real (not a 1c/99c empty book).
  if (bid > 0 && ask > 0 && ask - bid <= 0.2) pct = ((bid + ask) / 2) * 100;
  else if (last > 0) pct = last * 100;
  else if (bid > 0 && ask > 0) pct = ((bid + ask) / 2) * 100;
  else return null;
  return Math.round(pct * 10) / 10;
}

function sideInfo(market, ticker) {
  const pct = toProbability(market);
  if (pct == null) return null;
  return {
    pct,
    ticker,
    title: market.title || null,
    candidate: market.yes_sub_title || null,
    volume: market.volume ?? null,
    spread: (market.yes_ask_dollars != null && market.yes_bid_dollars != null)
      ? Math.round((Number(market.yes_ask_dollars) - Number(market.yes_bid_dollars)) * 100) : null,
  };
}

// Normalized two-party share. Adds `share` (0-100) to each side.
function normalize(dem, rep) {
  if (dem && rep) {
    const tot = dem.pct + rep.pct;
    if (tot > 0) {
      dem.share = Math.round((dem.pct / tot) * 1000) / 10;
      rep.share = Math.round((100 - dem.share) * 10) / 10;
    }
  } else if (dem) {
    dem.share = dem.pct;
  } else if (rep) {
    rep.share = rep.pct;
  }
}

async function fetchPair(prefix) {
  const [dM, rM] = await Promise.all([
    fetchMarket(`${prefix}-26-D`),
    fetchMarket(`${prefix}-26-R`),
  ]);
  const democrat = sideInfo(dM, `${prefix}-26-D`);
  const republican = sideInfo(rM, `${prefix}-26-R`);
  if (!democrat && !republican) return null;
  normalize(democrat, republican);
  return { democrat, republican, fetchedAt: new Date().toISOString() };
}

// Kalshi's list of election series. Used to skip tickers that don't exist
// (saves ~2,000 404s per run) and to find the newer "KXHOUSE.." district
// series. If the listing fails we fall back to trying every pattern.
let SERIES = null;
async function loadSeries() {
  try {
    const data = await fetchJson(`${BASE}/series?category=Elections`);
    if (data && Array.isArray(data.series) && data.series.length) {
      SERIES = new Set(data.series.map((x) => x.ticker));
      console.log(`[kalshi] ${SERIES.size} election series listed`);
    }
  } catch (e) {
    console.log(`[kalshi] series listing failed (${e.message}); trying every ticker pattern`);
  }
}
const listed = (prefix) => !SERIES || SERIES.has(prefix);

async function firstPair(prefixes) {
  for (const p of prefixes) {
    if (!listed(p)) continue;
    const pair = await fetchPair(p);
    if (pair) return { series: p, ...pair };
  }
  return null;
}

async function fetchHouseDistrict(district) {
  // Two naming families exist: HOUSEAZ6 (leading zero dropped) and the newer
  // KXHOUSEMO5 / KXHOUSEUT01. At-large seats use 1 or AL.
  const [state, distNumRaw] = district.split("-");
  const n = parseInt(distNumRaw, 10);
  const prefixes = [`HOUSE${state}${n}`, `KXHOUSE${state}${n}`, `KXHOUSE${state}${String(n).padStart(2, "0")}`];
  if (n === 1) prefixes.push(`HOUSE${state}AL`, `KXHOUSE${state}AL`);
  const pair = await firstPair(prefixes);
  return pair ? { district, ...pair } : null;
}

async function fetchStateRace(state) {
  // Ohio and Florida 2026 are special elections: SENATEOHS, SENATEFLS.
  const pair = await firstPair([`SENATE${state}`, `SENATE${state}S`]);
  return pair ? { state, ...pair } : null;
}

// States electing a governor in November 2026.
const GOVERNOR_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "HI", "ID", "IL", "IA", "KS", "ME", "MD", "MA", "MI",
  "MN", "NE", "NV", "NH", "NM", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "VT", "WI", "WY",
];
async function fetchGovernor(state) {
  const pair = await firstPair([`GOVPARTY${state}`]);
  return pair ? { state, ...pair } : null;
}

/* ---------- national markets ---------- */
const mid = (m) => {
  const bid = Number(m.yes_bid_dollars), ask = Number(m.yes_ask_dollars), last = Number(m.last_price_dollars);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return last > 0 ? last : null;
};

// Open 2026 event for a series (skips the 2028 versions some series carry).
async function openEvent(series) {
  const data = await fetchJson(`${BASE}/events?series_ticker=${series}&status=open&with_nested_markets=true`);
  const evs = (data && data.events) || [];
  return evs.find((e) => /(^|-)(26|2026|26NOV03|27FEB)/.test(e.event_ticker.replace(series, ""))) || evs.find((e) => !/2028|28/.test(e.event_ticker)) || null;
}

// "At least N" ladders -> the value where the market crosses 50%.
function ladderMedian(markets) {
  const pts = markets
    .map((m) => ({ t: Number((m.ticker.match(/-AL(\d+(?:\.\d+)?)$/) || [])[1]), p: mid(m) }))
    .filter((x) => isFinite(x.t) && x.p != null)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  if (pts[0].p < 0.5) return { median: pts[0].t, note: "below lowest rung" };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.p >= 0.5 && b.p < 0.5) {
      const f = (a.p - 0.5) / (a.p - b.p || 1);
      return { median: Math.round((a.t + f * (b.t - a.t)) * 10) / 10, ladder: pts.map((x) => ({ atLeast: x.t, pct: Math.round(x.p * 1000) / 10 })) };
    }
  }
  return { median: pts[pts.length - 1].t, note: "above highest rung", ladder: pts.map((x) => ({ atLeast: x.t, pct: Math.round(x.p * 1000) / 10 })) };
}

async function fetchNational() {
  const out = {};
  const control = { house: "CONTROLH", senate: "CONTROLS" };
  for (const [key, series] of Object.entries(control)) {
    try {
      const ev = await openEvent(series);
      if (ev && ev.markets) out[key] = {
        event: ev.event_ticker, title: ev.title,
        outcomes: ev.markets.map((m) => ({ ticker: m.ticker, label: m.yes_sub_title || m.title, pct: m && mid(m) != null ? Math.round(mid(m) * 1000) / 10 : null })).filter((x) => x.pct != null),
      };
    } catch (e) { console.log(`[kalshi:national] ${series}: ${e.message}`); }
  }
  const ladders = {
    housePopVoteMarginD: "KXHOUSEPOPVOTEMARGIND", // D minus R national House vote, points
    houseSeatsD: "KXDHOUSEWON",                   // Democratic House seats won
    senateSeatsWonD: "KXDSENATEWON",              // Democratic Senate seats won this cycle
  };
  for (const [key, series] of Object.entries(ladders)) {
    try {
      const ev = await openEvent(series);
      const med = ev && ev.markets ? ladderMedian(ev.markets) : null;
      if (med) out[key] = { event: ev.event_ticker, title: ev.title, ...med };
    } catch (e) { console.log(`[kalshi:national] ${series}: ${e.message}`); }
  }
  for (const [key, series] of Object.entries({ blueWave: "KXBLUEWAVECOMBO", redWave: "KXREDWAVECOMBO" })) {
    try {
      const ev = await openEvent(series);
      const m = ev && ev.markets && ev.markets[0];
      if (m && mid(m) != null) out[key] = { event: ev.event_ticker, question: m.yes_sub_title || ev.title, pct: Math.round(mid(m) * 1000) / 10 };
    } catch (e) { console.log(`[kalshi:national] ${series}: ${e.message}`); }
  }
  out.fetchedAt = new Date().toISOString();
  return out;
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = { ok: true, value: await worker(items[idx]) }; }
      catch (e) { results[idx] = { ok: false, error: e.message }; }
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
  return results;
}

// On a transient error, carry the last good file forward instead of dropping it.
function keepPrevious(target, key, file) {
  try {
    const p = path.join(OUT_DIR, file);
    if (fs.existsSync(p)) target[key] = Object.assign(JSON.parse(fs.readFileSync(p, "utf8")), { stale: true });
  } catch {}
}


const STATE_NAMES = {AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming"};

// Kalshi tickers are not always what they look like: SENATELA-26 is the
// Kentucky race (its own title says so). Trust the market title over the
// ticker and file each race under the state its title names.
function stateFromTitle(r) {
  const t = [r.democrat && r.democrat.title, r.republican && r.republican.title].filter(Boolean).join(" ");
  const hits = Object.entries(STATE_NAMES).filter(([, n]) => new RegExp(`\\b${n}\\b`).test(t));
  // "Virginia" also matches inside "West Virginia"; prefer the longest name
  hits.sort((a, b) => b[1].length - a[1].length);
  return hits.length ? hits[0][0] : null;
}
function rekeyByTitle(results, label) {
  const out = {};
  for (const [key, r] of Object.entries(results)) {
    const st = stateFromTitle(r) || key;
    if (st !== key) console.log(`[${label}] ${r.series || key} is really ${STATE_NAMES[st]} per its title; filing under ${st}`);
    if (out[st] && out[st].series && !r.series) continue;
    out[st] = { ...r, state: st, tickerState: key };
  }
  return out;
}

// Independent races (e.g. Nebraska: Osborn vs Ricketts) have no real D/R
// pair. When the two sides don't add up to ~100, don't rescale them;
// mark the race so pages show the Republican's odds against "the field".
function markThirdParty(r) {
  if (!r || !r.democrat || !r.republican) return r;
  if (r.democrat.pct + r.republican.pct < 85) {
    r.thirdParty = true;
    r.democrat.share = r.democrat.pct;
    r.republican.share = r.republican.pct;
    r.fieldVsRepublican = Math.round((100 - r.republican.pct) * 10) / 10;
  }
  return r;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  await loadSeries();

  const sen = await pool(SENATE_STATES, fetchStateRace);
  const allSenate = {};
  let ok = 0, skipped = 0, errors = 0;
  sen.forEach((r, i) => {
    const st = SENATE_STATES[i];
    if (!r.ok) { errors++; console.log(`[senate] ${st} ERROR ${r.error}`); keepPrevious(allSenate, st, `${st}-senate.json`); return; }
    if (!r.value) { skipped++; return; }
    allSenate[st] = r.value; ok++;
    fs.writeFileSync(path.join(OUT_DIR, `${st}-senate.json`), JSON.stringify(r.value, null, 2));
  });

  const hou = await pool(ALL_HOUSE_DISTRICTS, fetchHouseDistrict);
  const allHouse = {};
  let hOk = 0, hSkipped = 0, hErrors = 0;
  hou.forEach((r, i) => {
    const d = ALL_HOUSE_DISTRICTS[i];
    if (!r.ok) { hErrors++; console.log(`[house] ${d} ERROR ${r.error}`); keepPrevious(allHouse, d, `${d}.json`); return; }
    if (!r.value) { hSkipped++; return; }
    allHouse[d] = r.value; hOk++;
    fs.writeFileSync(path.join(OUT_DIR, `${d}.json`), JSON.stringify(r.value, null, 2));
  });

  const gov = await pool(GOVERNOR_STATES, fetchGovernor);
  const allGov = {};
  let gOk = 0;
  gov.forEach((r, i) => {
    const st = GOVERNOR_STATES[i];
    if (!r.ok) { console.log(`[governor] ${st} ERROR ${r.error}`); keepPrevious(allGov, st, `${st}-governor.json`); return; }
    if (!r.value) return;
    allGov[st] = r.value; gOk++;
    fs.writeFileSync(path.join(OUT_DIR, `${st}-governor.json`), JSON.stringify(r.value, null, 2));
  });

  // Total failure (Kalshi down / blocked): keep the last good files and fail.
  if (ok === 0 && hOk === 0) {
    console.error(`Kalshi returned nothing (senate errors ${errors}, house errors ${hErrors}). Keeping previous data.`);
    process.exit(1);
  }

  // Drop per-race files for markets that disappeared, so stale odds don't linger.
  for (const f of fs.readdirSync(OUT_DIR)) {
    const m = f.match(/^([A-Z]{2})-senate\.json$/);
    if (m && !allSenate[m[1]]) fs.unlinkSync(path.join(OUT_DIR, f));
    const h = f.match(/^([A-Z]{2}-\d{2})\.json$/);
    if (h && !allHouse[h[1]]) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  // file each race under the state its market title names, fix third-party races
  const fixedSenate = rekeyByTitle(allSenate, "senate");
  for (const k of Object.keys(allSenate)) if (!fixedSenate[k]) { try { fs.unlinkSync(path.join(OUT_DIR, `${k}-senate.json`)); } catch {} }
  for (const [k, r] of Object.entries(fixedSenate)) { markThirdParty(r); fs.writeFileSync(path.join(OUT_DIR, `${k}-senate.json`), JSON.stringify(r, null, 2)); }
  Object.keys(allSenate).forEach((k) => delete allSenate[k]); Object.assign(allSenate, fixedSenate);
  const fixedGov = rekeyByTitle(allGov, "governor");
  for (const k of Object.keys(allGov)) if (!fixedGov[k]) { try { fs.unlinkSync(path.join(OUT_DIR, `${k}-governor.json`)); } catch {} }
  for (const [k, r] of Object.entries(fixedGov)) { markThirdParty(r); fs.writeFileSync(path.join(OUT_DIR, `${k}-governor.json`), JSON.stringify(r, null, 2)); }
  Object.keys(allGov).forEach((k) => delete allGov[k]); Object.assign(allGov, fixedGov);
  fs.writeFileSync(path.join(OUT_DIR, "all-senate.json"), JSON.stringify(allSenate));
  fs.writeFileSync(path.join(OUT_DIR, "all-house.json"), JSON.stringify(allHouse));
  fs.writeFileSync(path.join(OUT_DIR, "all-governor.json"), JSON.stringify(allGov));

  let national = {};
  try { national = await fetchNational(); } catch (e) { console.log("national:", e.message); }
  fs.writeFileSync(path.join(OUT_DIR, "national.json"), JSON.stringify(national, null, 2));

  fs.writeFileSync(
    path.join(OUT_DIR, "meta.json"),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      runtime_seconds: Math.round((Date.now() - t0) / 1000),
      senate_ok: ok, senate_skipped: skipped, senate_errors: errors,
      house_ok: hOk, house_skipped: hSkipped, house_errors: hErrors,
      governor_ok: gOk,
      national: Object.keys(national).filter((k) => k !== "fetchedAt"),
    }, null, 2)
  );
  console.log(`Senate: ${ok} live, ${skipped} not listed, ${errors} error(s).`);
  console.log(`House: ${hOk} live, ${hSkipped} not listed, ${hErrors} error(s).`);
  console.log(`Governor: ${gOk} live.`);
  console.log(`National: ${Object.keys(national).filter((k) => k !== "fetchedAt").join(", ") || "none found"}`);
}

main().catch((e) => {
  console.error("Kalshi fetch failed unexpectedly:", e.stack || e.message);
  process.exit(1);
});
