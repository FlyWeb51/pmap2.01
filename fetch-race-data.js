/**
 * fetch-race-data.js
 *
 * Pulls two things with real, live API calls:
 *   1. Full race campaign finance data (FEC) — every filed candidate
 *      for a given state + district, not a guessed name list.
 *   2. District demographic profile (Census ACS 5-year estimates).
 *
 * Requires Node 18+ (uses built-in fetch).
 *
 * Setup:
 *   export FEC_API_KEY="your_fec_key"
 *   export CENSUS_API_KEY="your_census_key"
 *
 * Usage:
 *   node fetch-race-data.js race CA 12          # House race, CA district 12
 *   node fetch-race-data.js race TX senate       # Senate race, Texas
 *   node fetch-race-data.js district CA 12       # District demographic profile
 */

const FEC_API_KEY = process.env.FEC_API_KEY;
const CENSUS_API_KEY = process.env.CENSUS_API_KEY;

const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
  IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32",
  NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39",
  OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56", DC: "11", PR: "72",
};

async function fecGet(path, params) {
  if (!FEC_API_KEY) throw new Error("Missing FEC_API_KEY env var");
  const url = new URL(`https://api.open.fec.gov/v1/${path}`);
  url.searchParams.set("api_key", FEC_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FEC ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function censusGet(variables, geoFor, geoIn) {
  if (!CENSUS_API_KEY) throw new Error("Missing CENSUS_API_KEY env var");
  const url = new URL("https://api.census.gov/data/2022/acs/acs5");
  url.searchParams.set("get", variables.join(","));
  url.searchParams.set("for", geoFor);
  url.searchParams.set("in", geoIn);
  url.searchParams.set("key", CENSUS_API_KEY);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Census failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// ---- 1. Full race campaign finance (FEC) ----
async function getFullRace(state, district) {
  const isSenate = String(district).toLowerCase() === "senate";
  const office = isSenate ? "S" : "H";

  const params = {
    state,
    office,
    election_year: "2026",
    per_page: "100",
    sort: "-receipts",
  };
  if (!isSenate) params.district = String(district).padStart(2, "0");

  const search = await fecGet("candidates/search/", params);
  const candidates = search.results || [];

  // Pull committee totals for each candidate (their principal campaign committee)
  const withTotals = await Promise.all(
    candidates.map(async (c) => {
      let totals = null;
      try {
        const t = await fecGet(`candidate/${c.candidate_id}/totals/`, {
          cycle: "2026",
        });
        totals = t.results?.[0] || null;
      } catch (e) {
        totals = { error: e.message };
      }
      return {
        candidate_id: c.candidate_id,
        name: c.name,
        party: c.party_full,
        incumbent_challenge: c.incumbent_challenge_full,
        status: c.candidate_status,
        raised: totals?.receipts ?? null,
        spent: totals?.disbursements ?? null,
        cash_on_hand: totals?.cash_on_hand_end_period ?? null,
        debt: totals?.debts_owed_by_committee ?? null,
        coverage_end_date: totals?.coverage_end_date ?? null,
      };
    })
  );

  return {
    race: isSenate ? `${state} — Senate` : `${state}-${params.district}`,
    candidate_count: withTotals.length,
    candidates: withTotals,
  };
}

// ---- 2. District demographic profile (Census ACS) ----
async function getDistrictProfile(state, district) {
  const fips = STATE_FIPS[state.toUpperCase()];
  if (!fips) throw new Error(`Unknown state abbreviation: ${state}`);
  const districtPadded = String(district).padStart(2, "0");

  // Variables: population, median household income, median age,
  // bachelor's+ count, total 25+ pop (for education rate),
  // poverty count, poverty universe, owner-occupied, total occupied
  const vars = [
    "B01003_001E", // total population
    "B19013_001E", // median household income
    "B01002_001E", // median age
    "B15003_022E", // bachelor's degree
    "B15003_023E", // master's degree
    "B15003_024E", // professional degree
    "B15003_025E", // doctorate
    "B15003_001E", // total 25+ population (education universe)
    "B17001_002E", // income below poverty line
    "B17001_001E", // poverty universe
    "B25003_002E", // owner-occupied housing units
    "B25003_001E", // total occupied housing units
  ];

  const data = await censusGet(
    vars,
    `congressional district:${districtPadded}`,
    `state:${fips}`
  );

  const [header, row] = data;
  const rec = Object.fromEntries(header.map((h, i) => [h, row[i]]));
  const num = (k) => (rec[k] != null ? Number(rec[k]) : null);

  const bachelorsPlus =
    num("B15003_022E") + num("B15003_023E") + num("B15003_024E") + num("B15003_025E");
  const educationUniverse = num("B15003_001E");

  return {
    state: state.toUpperCase(),
    district: districtPadded,
    population: num("B01003_001E"),
    median_household_income: num("B19013_001E"),
    median_age: num("B01002_001E"),
    bachelors_or_higher_pct: educationUniverse
      ? +((bachelorsPlus / educationUniverse) * 100).toFixed(1)
      : null,
    poverty_rate_pct: num("B17001_001E")
      ? +((num("B17001_002E") / num("B17001_001E")) * 100).toFixed(1)
      : null,
    homeownership_rate_pct: num("B25003_001E")
      ? +((num("B25003_002E") / num("B25003_001E")) * 100).toFixed(1)
      : null,
    source: "Census ACS 5-Year Estimates, 2022",
  };
}

// ---- CLI entry point ----
async function main() {
  const [, , mode, state, district] = process.argv;
  if (!mode || !state) {
    console.error(
      "Usage:\n  node fetch-race-data.js race <STATE> <district|senate>\n  node fetch-race-data.js district <STATE> <district>"
    );
    process.exit(1);
  }

  try {
    if (mode === "race") {
      const result = await getFullRace(state, district);
      console.log(JSON.stringify(result, null, 2));
    } else if (mode === "district") {
      const result = await getDistrictProfile(state, district);
      console.log(JSON.stringify(result, null, 2));
    } else {
      throw new Error(`Unknown mode: ${mode}`);
    }
  } catch (e) {
    console.error("Error:", e.message);
    process.exit(1);
  }
}

main();

module.exports = { getFullRace, getDistrictProfile };
