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

const BASE = "https://external-api.kalshi.com/trade-api/v2";
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

const COMPETITIVE_HOUSE_DISTRICTS = [
  // Toss-up
  "AZ-01","AZ-06","CA-22","CA-48","CO-08","FL-22","MI-07","MI-08","MN-02",
  "NC-01","NY-17","NY-19","OH-13","OR-05","PA-07","PA-08","TX-15","VA-07",
  // Lean D
  "CA-13","CA-21","CA-41","CA-45","IL-14","IL-17","KS-03","ME-02","MI-03",
  "NC-13","NJ-07","NM-02","NY-03","NY-04","NY-18","NY-22","PA-17","TX-07","WA-03","WA-08","WI-03",
  // Lean R
  "CA-40","FL-13","FL-27","FL-28","IA-01","LA-06","MT-01","NC-14","NE-02",
  "NJ-02","NY-01","NY-02","NY-11","OH-01","PA-01","TX-23","TX-34","VA-02",
  // Likely D
  "AZ-04","CA-01","CA-03","CA-06","CA-24","CA-25","CA-47","CO-06","CO-07",
  "CT-05","FL-14","GA-07","IL-06","IL-11","IL-13","MI-11","MN-03","NH-01",
  "NJ-03","NJ-05","NJ-11","NV-03","NV-04","OR-06","PA-06","VA-10",
  // Likely R
  "AL-02","FL-07","FL-08","FL-09","IA-02","IA-03","ID-01","MI-04","MN-01",
  "NC-03","NE-01","NV-02","OH-09","SC-01","TX-09","TX-28","TX-35","WA-05",
];

async function fetchHouseDistrict(district) {
  // district is "AZ-01" style; Kalshi ticker guess has no hyphen: AZ01
  const compact = district.replace("-", "");
  const [dMarket, rMarket] = await Promise.all([
    fetchMarket(`HOUSE${compact}-26-D`).catch(() => null),
    fetchMarket(`HOUSE${compact}-26-R`).catch(() => null),
  ]);
  const dPct = toProbability(dMarket);
  const rPct = toProbability(rMarket);
  if (dPct == null && rPct == null) return null;

  return {
    district,
    democrat: dPct != null ? { pct: dPct, ticker: `HOUSE${compact}-26-D`, title: dMarket && dMarket.title } : null,
    republican: rPct != null ? { pct: rPct, ticker: `HOUSE${compact}-26-R`, title: rMarket && rMarket.title } : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchMarket(ticker) {
  const res = await fetch(`${BASE}/markets/${ticker}`, { headers: { "User-Agent": UA } });
  if (res.status === 404) return null; // market doesn't exist yet -- not an error
  if (!res.ok) throw new Error(`Kalshi fetch failed for "${ticker}": ${res.status}`);
  const data = await res.json();
  return data.market || null;
}

function toProbability(market) {
  if (!market) return null;
  // Prefer the live bid/ask midpoint when both sides have a real quote;
  // fall back to last traded price for thin/no-liquidity markets.
  const bid = Number(market.yes_bid_dollars);
  const ask = Number(market.yes_ask_dollars);
  const last = Number(market.last_price_dollars);
  let pct;
  if (bid > 0 && ask > 0) pct = ((bid + ask) / 2) * 100;
  else if (last > 0) pct = last * 100;
  else return null;
  return Math.round(pct * 10) / 10;
}

async function fetchStateRace(state) {
  const [dMarket, rMarket] = await Promise.all([
    fetchMarket(`SENATE${state}-26-D`).catch(() => null),
    fetchMarket(`SENATE${state}-26-R`).catch(() => null),
  ]);
  const dPct = toProbability(dMarket);
  const rPct = toProbability(rMarket);
  if (dPct == null && rPct == null) return null; // no Kalshi market for this state at all

  return {
    state,
    democrat: dPct != null ? { pct: dPct, ticker: `SENATE${state}-26-D`, title: dMarket && dMarket.title } : null,
    republican: rPct != null ? { pct: rPct, ticker: `SENATE${state}-26-R`, title: rMarket && rMarket.title } : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0;
  let skipped = 0;
  let errors = 0;

  for (const state of SENATE_STATES) {
    process.stdout.write(`[kalshi:senate] ${state} ... `);
    try {
      const result = await fetchStateRace(state);
      if (!result) {
        console.log("no market listed, skipped");
        skipped++;
      } else {
        fs.writeFileSync(path.join(OUT_DIR, `${state}-senate.json`), JSON.stringify(result, null, 2));
        console.log(
          `D:${result.democrat ? result.democrat.pct + "%" : "-"} R:${result.republican ? result.republican.pct + "%" : "-"}`
        );
        ok++;
      }
    } catch (e) {
      errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // light, polite spacing
  }

  // ---- House: competitive districts only ----
  let hOk = 0, hSkipped = 0, hErrors = 0;
  for (const district of COMPETITIVE_HOUSE_DISTRICTS) {
    process.stdout.write(`[kalshi:house] ${district} ... `);
    try {
      const result = await fetchHouseDistrict(district);
      if (!result) {
        console.log("no market listed, skipped");
        hSkipped++;
      } else {
        fs.writeFileSync(path.join(OUT_DIR, `${district}.json`), JSON.stringify(result, null, 2));
        console.log(
          `D:${result.democrat ? result.democrat.pct + "%" : "-"} R:${result.republican ? result.republican.pct + "%" : "-"}`
        );
        hOk++;
      }
    } catch (e) {
      hErrors++;
      console.log(`ERROR: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  fs.writeFileSync(
    path.join(OUT_DIR, "meta.json"),
    JSON.stringify({
      updated_at: new Date().toISOString(),
      senate_ok: ok, senate_skipped: skipped, senate_errors: errors,
      house_ok: hOk, house_skipped: hSkipped, house_errors: hErrors,
    }, null, 2)
  );
  console.log(`\nSenate: ${ok} live, ${skipped} skipped, ${errors} error(s).`);
  console.log(`House: ${hOk} live, ${hSkipped} skipped, ${hErrors} error(s).`);
}

main().catch((e) => {
  console.error("Kalshi fetch failed unexpectedly:", e.message);
  console.error(e.stack);
});
