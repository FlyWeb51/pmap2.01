/**
 * scripts/build-data.js
 *
 * The "hivemind" builder. Fetches FEC race data and Census demographics
 * for every seat and writes static JSON files the frontend reads directly —
 * no server needed. Run by GitHub Actions on a schedule or via the
 * "Run workflow" button.
 *
 * Output layout (matches the frontend's expectations exactly):
 *   data/fec/AZ-02.json          -> { race, candidates: [{name, party:"DEM", totals:{...}}] }
 *   data/fec/VT-00.json          -> at-large seats use "00"
 *   data/fec/TX-senate.json      -> senate races
 *   data/census/AZ-02.json       -> { profile: { "Population": "798,999", ... } }
 *   data/polls/AZ-H-01-2026.json -> { race_id, polls: [...] }
 *   data/poll-average/AZ-H-01-2026.json -> { race_id, poll_count, average: [...] }
 *   data/meta.json               -> { updated_at, seats_ok, seats_failed }
 *
 * Existing files are left untouched when a fetch fails, so one bad API
 * moment never blanks out the live site.
 *
 * Env: FEC_API_KEY, CENSUS_API_KEY
 * Optional: RATE_DELAY_MS (default 1200), ONLY_STATE=AZ (partial run for testing)
 */

const fs = require("fs");
const path = require("path");
const fec = require("../lib/fec");
const census = require("../lib/census");
const { HOUSE_SEATS_BY_STATE, ALL_STATES } = require("../seats");

const ROOT = path.join(__dirname, "..");
const DATA = path.join(ROOT, "data");
const RATE_DELAY_MS = Number(process.env.RATE_DELAY_MS || 1200);
const ONLY_STATE = process.env.ONLY_STATE || null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeJson(relPath, obj) {
  const p = path.join(DATA, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

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

// Frontend file naming: at-large -> "00", otherwise zero-padded district
function seatFileCode(state, districtNumber) {
  return HOUSE_SEATS_BY_STATE[state] === 1 ? "00" : String(districtNumber).padStart(2, "0");
}

function toFrontendRaceShape(d) {
  return {
    race: d.race,
    updated_at: new Date().toISOString(),
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
  };
}

function toFrontendProfileShape(p) {
  return {
    updated_at: new Date().toISOString(),
    profile: {
      "Population": p.population != null ? p.population.toLocaleString("en-US") : "—",
      "Median household income":
        p.median_household_income != null ? "$" + p.median_household_income.toLocaleString("en-US") : "—",
      "Median age": p.median_age ?? "—",
      "Bachelor's or higher": p.bachelors_or_higher_pct != null ? p.bachelors_or_higher_pct + "%" : "—",
      "Poverty rate": p.poverty_rate_pct != null ? p.poverty_rate_pct + "%" : "—",
      "Homeownership": p.homeownership_rate_pct != null ? p.homeownership_rate_pct + "%" : "—",
      "White (non-Hispanic)": p.white_pct != null ? p.white_pct + "%" : "—",
      "Black": p.black_pct != null ? p.black_pct + "%" : "—",
      "Hispanic / Latino": p.hispanic_pct != null ? p.hispanic_pct + "%" : "—",
      "Asian": p.asian_pct != null ? p.asian_pct + "%" : "—",
      "Native American": p.native_pct != null ? p.native_pct + "%" : "—",
      "Other / multiracial": p.other_pct != null ? p.other_pct + "%" : "—",
    },
  };
}

function buildPollFiles() {
  let polls = [];
  try {
    polls = JSON.parse(fs.readFileSync(path.join(ROOT, "api", "polls-data.json"), "utf8")).filter(
      (p) => p.reviewStatus === "approved"
    );
  } catch {
    console.log("polls: no api/polls-data.json found, skipping");
    return;
  }
  const byRace = {};
  for (const p of polls) (byRace[p.raceId] ||= []).push(p);

  for (const [raceId, racePolls] of Object.entries(byRace)) {
    writeJson(`polls/${raceId}.json`, { race_id: raceId, polls: racePolls });

    const sums = {};
    let weightTotal = 0;
    for (const poll of racePolls) {
      const w = Number(poll.weight) || 1;
      weightTotal += w;
      for (const r of poll.results || []) {
        sums[r.candidate] = (sums[r.candidate] || 0) + w * Number(r.pct || 0);
      }
    }
    const average = weightTotal
      ? Object.entries(sums).map(([candidate, s]) => ({ candidate, pct: +(s / weightTotal).toFixed(1) }))
      : [];
    writeJson(`poll-average/${raceId}.json`, { race_id: raceId, poll_count: racePolls.length, average });
  }
  console.log(`polls: wrote ${Object.keys(byRace).length} race(s)`);
}

async function main() {
  const states = ONLY_STATE ? [ONLY_STATE.toUpperCase()] : ALL_STATES;
  let ok = 0;
  let failed = 0;

  // Poll files first — no API calls, always safe
  buildPollFiles();

  for (const state of states) {
    const nDistricts = HOUSE_SEATS_BY_STATE[state];
    const seatList = [];
    for (let d = 1; d <= nDistricts; d++) seatList.push({ kind: "H", num: d });
    seatList.push({ kind: "S" });

    for (const seat of seatList) {
      const label =
        seat.kind === "S" ? `${state}-senate` : `${state}-${seatFileCode(state, seat.num)}`;
      process.stdout.write(`${label} ... `);

      // FEC race
      try {
        const raceParam = seat.kind === "S" ? "senate" : String(seat.num);
        const d = await fec.fetchRace(state, raceParam);
        writeJson(`fec/${label}.json`, toFrontendRaceShape(d));
        process.stdout.write(`fec:${d.candidate_count} `);
        ok++;
      } catch (e) {
        process.stdout.write(`fec:FAIL(${e.message.slice(0, 60)}) `);
        failed++; // existing file, if any, stays in place
      }

      // Census profile (House seats only)
      if (seat.kind === "H") {
        try {
          const cd = seatFileCode(state, seat.num);
          const p = await census.fetchDistrictProfile(state, cd === "00" ? "00" : cd);
          writeJson(`census/${label}.json`, toFrontendProfileShape(p));
          process.stdout.write("census:ok");
          ok++;
        } catch (e) {
          process.stdout.write(`census:FAIL(${e.message.slice(0, 60)})`);
          failed++;
        }
      }

      console.log("");
      await sleep(RATE_DELAY_MS);
    }
  }

  writeJson("meta.json", {
    updated_at: new Date().toISOString(),
    seats_ok: ok,
    seats_failed: failed,
  });
  console.log(`\nDone. ok=${ok} failed=${failed}. Output in data/`);

  // Fail the workflow loudly only if nothing at all succeeded
  if (ok === 0 && failed > 0) process.exit(1);
}

main();
