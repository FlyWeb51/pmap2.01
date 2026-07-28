const CENSUS_API_KEY = process.env.CENSUS_API_KEY;

const STATE_FIPS = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17", IN: "18",
  IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24", MA: "25",
  MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31", NV: "32",
  NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38", OH: "39",
  OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46", TN: "47",
  TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54", WI: "55",
  WY: "56",
};

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

const VARS = [
  "B01003_001E", // total population
  "B19013_001E", // median household income
  "B01002_001E", // median age
  "B15003_022E", "B15003_023E", "B15003_024E", "B15003_025E", // bachelor's+
  "B15003_001E", // education universe (25+)
  "B17001_002E", "B17001_001E", // poverty count / universe
  "B25003_002E", "B25003_001E", // owner-occupied / total occupied
  "B03002_001E", "B03002_003E", "B03002_004E", "B03002_006E", "B03002_005E", "B03002_012E", // race/ethnicity (B03002)
];

async function fetchDistrictProfile(state, district) {
  const fips = STATE_FIPS[state.toUpperCase()];
  if (!fips) throw new Error(`Unknown state abbreviation: ${state}`);
  let districtPadded = String(district).padStart(2, "0");

  let data;
  try {
    data = await censusGet(VARS, `congressional district:${districtPadded}`, `state:${fips}`);
  } catch (e) {
    // At-large fallback: try "00" if "01" wasn't found
    if (districtPadded === "01") {
      districtPadded = "00";
      data = await censusGet(VARS, `congressional district:${districtPadded}`, `state:${fips}`);
    } else {
      throw e;
    }
  }

  const [header, row] = data;
  const rec = Object.fromEntries(header.map((h, i) => [h, row[i]]));
  const num = (k) => (rec[k] != null ? Number(rec[k]) : null);

  const bachelorsPlus =
    num("B15003_022E") + num("B15003_023E") + num("B15003_024E") + num("B15003_025E");
  const educationUniverse = num("B15003_001E");

  const raceTotal = num("B03002_001E");
  const rpct = (k) => (raceTotal ? +((num(k) / raceTotal) * 100).toFixed(1) : null);

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
    white_pct: rpct("B03002_003E"),
    black_pct: rpct("B03002_004E"),
    hispanic_pct: rpct("B03002_012E"),
    asian_pct: rpct("B03002_006E"),
    native_pct: rpct("B03002_005E"),
    other_pct: raceTotal ? +((100 - (rpct("B03002_003E") + rpct("B03002_004E") + rpct("B03002_012E") + rpct("B03002_006E") + rpct("B03002_005E"))).toFixed(1)) : null,
    source: "Census ACS 5-Year Estimates, 2022",
  };
}

module.exports = { fetchDistrictProfile, STATE_FIPS };
