/**
 * scripts/build-census-agesex.js
 *
 * Eligible voters (U.S. citizens 18+) by age group and by sex, plus total
 * men/women and median age, for every congressional district, every state
 * and the U.S. Writes one file the site reads:
 *
 *   data/census/agesex.json
 *   { vintage, source, districts: { "PA-07": {...} }, states: { "PA": {...} }, us: {...} }
 *
 * Each entry:
 *   cvap        citizens 18 and over (the voting-eligible population)
 *   age         { "18-29", "30-44", "45-64", "65+" }  citizens 18+ in each band  (table B29001)
 *   cvapMen / cvapWomen   citizens 18+ by sex                                   (table B05003)
 *   pop, men, women       everyone, all ages                                    (B01003, B05003)
 *   medianAge, medianAgeMen, medianAgeWomen                                     (B01002)
 *
 * Three API calls in total (all districts, all states, the U.S.). Tries the
 * newest ACS 5-year vintage first. Needs CENSUS_API_KEY.
 */

const fs = require("fs");
const path = require("path");
const KEY = process.env.CENSUS_API_KEY;
const OUT = path.join(__dirname, "..", "data", "census", "agesex.json");

const FIPS = { "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY" };
const VARS = [
  "B29001_001E", "B29001_002E", "B29001_003E", "B29001_004E", "B29001_005E",
  "B05003_002E", "B05003_009E", "B05003_011E", "B05003_013E", "B05003_020E", "B05003_022E",
  "B01003_001E", "B01002_001E", "B01002_002E", "B01002_003E",
];

async function get(year, geoFor, geoIn) {
  const u = new URL(`https://api.census.gov/data/${year}/acs/acs5`);
  u.searchParams.set("get", ["NAME", ...VARS].join(","));
  u.searchParams.set("for", geoFor);
  if (geoIn) u.searchParams.set("in", geoIn);
  if (KEY) u.searchParams.set("key", KEY);
  const r = await fetch(u);
  const text = await r.text();
  if (!r.ok || !text.trim().startsWith("[")) throw new Error(`${year} ${geoFor}: HTTP ${r.status} ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

function shape(head, row) {
  const v = Object.fromEntries(head.map((h, i) => [h, row[i]]));
  const n = (k) => { const x = Number(v[k]); return isFinite(x) && x >= 0 ? x : null; };
  const m = (k) => { const x = Number(v[k]); return isFinite(x) && x > 0 ? x : null; };
  return {
    cvap: n("B29001_001E"),
    age: { "18-29": n("B29001_002E"), "30-44": n("B29001_003E"), "45-64": n("B29001_004E"), "65+": n("B29001_005E") },
    cvapMen: n("B05003_009E") + n("B05003_011E"),
    cvapWomen: n("B05003_020E") + n("B05003_022E"),
    pop: n("B01003_001E"), men: n("B05003_002E"), women: n("B05003_013E"),
    medianAge: m("B01002_001E"), medianAgeMen: m("B01002_002E"), medianAgeWomen: m("B01002_003E"),
  };
}

async function main() {
  if (!KEY) { console.log("census agesex: no CENSUS_API_KEY, skipping"); return; }
  let vintage = null, cds = null;
  for (const y of [2024, 2023, 2022]) {
    try { cds = await get(y, "congressional district:*", "state:*"); vintage = y; break; }
    catch (e) { console.log(`census agesex: ${e.message}`); }
  }
  if (!cds) { console.error("census agesex: no ACS vintage answered"); process.exit(1); }
  const [states, us] = await Promise.all([get(vintage, "state:*"), get(vintage, "us:1")]);

  const out = { vintage, source: `U.S. Census Bureau, American Community Survey ${vintage - 4}-${vintage} 5-year estimates (tables B29001, B05003, B01003, B01002)`, updated: new Date().toISOString(), districts: {}, states: {}, us: null };
  const [hd, ...rows] = cds;
  const si = hd.indexOf("state"), ci = hd.indexOf("congressional district");
  for (const r of rows) {
    const st = FIPS[r[si]]; if (!st) continue;
    const cd = r[ci]; if (!/^\d\d$/.test(cd) || cd === "ZZ") continue; // 00 = at-large, 98 = DC delegate
    out.districts[`${st}-${cd === "98" ? "00" : cd}`] = shape(hd, r);
  }
  const [hs, ...srows] = states;
  for (const r of srows) { const st = FIPS[r[hs.indexOf("state")]]; if (st) out.states[st] = shape(hs, r); }
  out.us = shape(us[0], us[1]);

  // sanity: age bands add up to the citizen-18+ total
  let bad = 0;
  for (const [k, d] of Object.entries(out.districts)) { const s = Object.values(d.age).reduce((a, b) => a + b, 0); if (Math.abs(s - d.cvap) > 2) bad++; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`census agesex: ACS ${vintage}, ${Object.keys(out.districts).length} districts, ${Object.keys(out.states).length} states${bad ? `, ${bad} with age bands not adding up` : ""}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
