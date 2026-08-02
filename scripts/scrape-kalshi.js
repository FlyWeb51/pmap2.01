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
  for (const district of ALL_HOUSE_DISTRICTS) {
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
    await new Promise((r) => setTimeout(r, 350));
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
