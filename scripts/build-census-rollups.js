/**
 * scripts/build-census-rollups.js
 *
 * Rolls the 435 district Census profiles (data/census/XX-NN.json) up into
 * statewide and national profiles, so Senate and governor race panels can
 * show demographics too.
 *
 *   data/census/state/<ST>.json   statewide profile
 *   data/census/state/US.json     national profile (comparison column)
 *
 * Counts and percentages are exact population-weighted sums. Median income and
 * median age can't be rebuilt from district medians, so those two are the
 * population-weighted average of district medians and flagged `approx`.
 */

const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "data", "census");
const OUT = path.join(DIR, "state");

const num = (v) => { const n = parseFloat(String(v).replace(/[$,%]/g, "")); return isFinite(n) ? n : null; };
const PCT = ["Bachelor's or higher", "Poverty rate", "Homeownership", "White (non-Hispanic)", "Black", "Hispanic / Latino", "Asian", "Native American", "Other / multiracial"];
const MED = ["Median household income", "Median age"];

function roll(files) {
  let pop = 0;
  const sums = {};
  for (const f of files) {
    const p = f.profile || {};
    const w = num(p.Population);
    if (!w) continue;
    pop += w;
    for (const k of [...PCT, ...MED]) { const v = num(p[k]); if (v != null) sums[k] = (sums[k] || 0) + v * w; }
  }
  if (!pop) return null;
  const profile = { Population: Math.round(pop).toLocaleString("en-US") };
  for (const k of MED) if (sums[k] != null) {
    const v = sums[k] / pop;
    profile[k] = k.includes("income") ? "$" + Math.round(v).toLocaleString("en-US") : Math.round(v * 10) / 10;
  }
  for (const k of PCT) if (sums[k] != null) profile[k] = (Math.round((sums[k] / pop) * 10) / 10) + "%";
  return profile;
}

function main() {
  const byState = {};
  const all = [];
  for (const fn of fs.readdirSync(DIR)) {
    const m = fn.match(/^([A-Z]{2})-\d{2}\.json$/);
    if (!m) continue;
    const j = JSON.parse(fs.readFileSync(path.join(DIR, fn), "utf8"));
    (byState[m[1]] ||= []).push(j);
    all.push(j);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString();
  const note = "Population-weighted rollup of district ACS profiles. Median income and median age are weighted averages of district medians (approximate).";
  for (const [st, files] of Object.entries(byState)) {
    fs.writeFileSync(path.join(OUT, `${st}.json`), JSON.stringify({ updated_at: stamp, scope: st, districts: files.length, approx: MED, note, profile: roll(files) }, null, 2));
  }
  fs.writeFileSync(path.join(OUT, "US.json"), JSON.stringify({ updated_at: stamp, scope: "US", districts: all.length, approx: MED, note, profile: roll(all) }, null, 2));
  console.log(`census rollups: ${Object.keys(byState).length} states + US from ${all.length} districts`);
}

main();
