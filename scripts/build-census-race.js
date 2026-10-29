/**
 * scripts/build-census-race.js
 *
 * Eligible voters (U.S. citizens 18+) by race and ethnicity for every
 * congressional district, every state and the U.S. The turnout simulator
 * (turnout.html) reads this file.
 *
 *   data/census/race-cvap.json
 *   { vintage, source, districts: { "PA-07": {...} }, states: { "PA": {...} }, us: {...} }
 *
 * Each entry: { cvap, white, black, hispanic, asian, other }
 *   white     White alone, not Hispanic        (table B05003H)
 *   black     Black alone                      (table B05003B)
 *   hispanic  Hispanic or Latino, any race     (table B05003I)
 *   asian     Asian alone                      (table B05003D)
 *   other     everyone else (multiracial, Native American, Pacific Islander,
 *             other), computed as cvap minus the four groups above
 *
 * Citizens 18+ in each table = male native + male naturalized
 *                            + female native + female naturalized
 *                            (variables 009, 011, 020, 022).
 *
 * Three API calls (all districts, all states, the U.S.). Tries the newest
 * ACS 5-year vintage first. Needs CENSUS_API_KEY.
 */

const fs = require("fs");
const path = require("path");
const KEY = process.env.CENSUS_API_KEY;
const OUT = path.join(__dirname, "..", "data", "census", "race-cvap.json");

const FIPS = { "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY" };
const GROUPS = { all: "", white: "H", black: "B", hispanic: "I", asian: "D" };
const CIT18 = ["009", "011", "020", "022"];
const VARS = Object.values(GROUPS).flatMap((g) => CIT18.map((n) => `B05003${g}_${n}E`));

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
  const n = (k) => { const x = Number(v[k]); return isFinite(x) && x >= 0 ? x : 0; };
  const sum = (g) => CIT18.reduce((a, c) => a + n(`B05003${g}_${c}E`), 0);
  const o = {};
  for (const [name, g] of Object.entries(GROUPS)) o[name] = sum(g);
  const cvap = o.all; delete o.all;
  o.other = Math.max(0, cvap - o.white - o.black - o.hispanic - o.asian);
  return { cvap, ...o };
}

async function main() {
  if (!KEY) { console.log("census race: no CENSUS_API_KEY, skipping"); return; }
  let vintage = null, cds = null;
  for (const y of [2024, 2023, 2022]) {
    try { cds = await get(y, "congressional district:*", "state:*"); vintage = y; break; }
    catch (e) { console.log(`census race: ${e.message}`); }
  }
  if (!cds) { console.error("census race: no ACS vintage answered"); process.exit(1); }
  const [states, us] = await Promise.all([get(vintage, "state:*"), get(vintage, "us:1")]);

  const out = {
    vintage,
    source: `U.S. Census Bureau, American Community Survey ${vintage - 4}-${vintage} 5-year estimates (tables B05003, B05003B, B05003D, B05003H, B05003I): U.S. citizens 18 and over`,
    note: "District figures use the district lines the ACS was tabulated on. States that redrew for 2026 are approximate.",
    updated: new Date().toISOString(),
    districts: {}, states: {}, us: null,
  };
  const [hd, ...rows] = cds;
  const si = hd.indexOf("state"), ci = hd.indexOf("congressional district");
  for (const r of rows) {
    const st = FIPS[r[si]]; if (!st) continue;
    const cd = r[ci]; if (!/^\d\d$/.test(cd)) continue;
    // 00 = at-large, which the rest of the site calls -01. 98 = DC delegate.
    const num = cd === "00" || cd === "98" ? "01" : cd;
    out.districts[`${st}-${num}`] = shape(hd, r);
  }
  const [hs, ...srows] = states;
  for (const r of srows) { const st = FIPS[r[hs.indexOf("state")]]; if (st) out.states[st] = shape(hs, r); }
  out.us = shape(us[0], us[1]);

  let bad = 0;
  for (const d of Object.values(out.districts)) if (d.white + d.black + d.hispanic + d.asian > d.cvap * 1.03) bad++;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const u = out.us;
  console.log(`census race: ACS ${vintage}, ${Object.keys(out.districts).length} districts, ${Object.keys(out.states).length} states. U.S. CVAP ${u.cvap}: white ${u.white}, black ${u.black}, hispanic ${u.hispanic}, asian ${u.asian}, other ${u.other}${bad ? `; ${bad} districts where groups overshoot the total` : ""}`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
