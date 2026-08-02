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

  fs.writeFileSync(
    path.join(OUT_DIR, "meta.json"),
    JSON.stringify({ updated_at: new Date().toISOString(), states_ok: ok, states_skipped: skipped, states_errors: errors }, null, 2)
  );
  console.log(`\nDone. ${ok} states with live markets, ${skipped} skipped (no market), ${errors} error(s).`);
}

main().catch((e) => {
  console.error("Kalshi fetch failed unexpectedly:", e.message);
  console.error(e.stack);
});
