/**
 * scripts/build-generic-polls.js
 *
 * Pulls the true generic-ballot polls ("Generic Democrat" vs "Generic
 * Republican", no named candidates) out of the NYT poll files, by state and
 * by district, for the state generic ballot screen in the terminal (F9).
 *
 * Writes data/generic-polls.json:
 *   { updated, states: { "WI": [poll...] }, districts: { "PA-07": [poll...] } }
 *   poll = { race, pollster, end, n, pop, partisan, lean, margin, url }
 * race = which contest the generic question asked about (senate, governor, house).
 * margin = generic Democrat minus generic Republican, in points.
 * lean = "R" or "D" when the firm mainly works for one party (pollster
 * alignment below, or the NYT partisan flag).
 */

const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "data", "polls-nyt");
const OUT = path.join(__dirname, "..", "data", "generic-polls.json");

// Firms that mainly poll for one party's campaigns and groups.
const ALIGNED = [[/co\/efficient/i, "R"], [/cygnal/i, "R"], [/tyson group/i, "R"], [/ragnar/i, "R"], [/public opinion strategies/i, "R"], [/fabrizio/i, "R"], [/mclaughlin/i, "R"], [/trafalgar/i, "R"], [/ppp|public policy polling/i, "D"], [/global strategy group/i, "D"], [/impact research/i, "D"], [/gqr/i, "D"]];
const isGeneric = (r) => /generic/i.test(r.candidate || "");

function polls(file, race) {
  let d; try { d = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")); } catch { return []; }
  let list = Array.isArray(d) ? d : d.polls || [];
  if (!Array.isArray(list)) list = Object.values(list);
  const out = new Map();
  for (const p of list) {
    const rs = (p && p.results) || [];
    const gd = rs.find((r) => r.party === "D" && isGeneric(r)), gr = rs.find((r) => r.party === "R" && isGeneric(r));
    if (!gd || !gr || rs.some((r) => (r.party === "D" || r.party === "R") && !isGeneric(r))) continue;
    const al = ALIGNED.find(([re]) => re.test(p.pollster || ""));
    const lean = p.partisan === "REP" ? "R" : p.partisan === "DEM" ? "D" : al ? al[1] : null;
    const key = `${p.pollster}|${p.endDate}|${p.population}`;
    out.set(key, { race, pollster: p.pollster, end: p.endDate, n: p.sampleSize || null, pop: p.population || null, partisan: p.partisan || null, lean, margin: Math.round((gd.percentage - gr.percentage) * 10) / 10, url: p.sourceUrl || null });
  }
  return [...out.values()].sort((a, b) => (a.end < b.end ? 1 : -1));
}

const res = { updated: new Date().toISOString(), source: "The New York Times polling data (CC BY 4.0)", states: {}, districts: {} };
for (const f of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
  const m = f.match(/^([A-Z]{2})-(S|G|H)(?:-(\d\d))?-2026\.json$/);
  if (!m) continue;
  const ps = polls(f, { S: "senate", G: "governor", H: "house" }[m[2]]);
  if (!ps.length) continue;
  if (m[2] === "H") res.districts[`${m[1]}-${m[3]}`] = ps;
  else { // a statewide question can appear in both the Senate and governor files
    const seen = new Set((res.states[m[1]] || []).map((p) => `${p.pollster}|${p.end}|${p.pop}`));
    res.states[m[1]] = [...(res.states[m[1]] || []), ...ps.filter((p) => !seen.has(`${p.pollster}|${p.end}|${p.pop}`))].sort((a, b) => (a.end < b.end ? 1 : -1));
  }
}
fs.writeFileSync(OUT, JSON.stringify(res));
const n = (o) => Object.values(o).reduce((a, l) => a + l.length, 0);
console.log(`generic polls: ${n(res.states)} statewide in ${Object.keys(res.states).length} states, ${n(res.districts)} in ${Object.keys(res.districts).length} districts`);
