/**
 * scripts/fetch-pres-by-cd.js
 *
 * 2024 presidential results for every congressional district, on the lines
 * used in the 2026 election (Texas, California, North Carolina, Ohio, Utah,
 * Alabama, Florida, Tennessee and Louisiana redrew; their 2024 results are
 * recalculated onto the new districts).
 *
 * Source: The Downballot, "2020 & 2024 presidential election results for
 * congressional districts used in the 2026 elections" (public Google Sheet,
 * "Vote totals" tab). Cite as The Downballot, the-db.co/presbycd.
 *
 * Writes data/baseline-2024-cd.json:
 *   { source, citation, updated, national: {...}, districts: { "TX-23": { harris, trump, total, marginD, newLines } } }
 * marginD = Harris minus Trump, percentage points of all votes cast.
 */

const fs = require("fs");
const path = require("path");
const SHEET = "1eZfaFI-c-PFOoKx1-zZA2MP0_dxRq_LVK0re3BOQqy0";
const URL_CSV = `https://docs.google.com/spreadsheets/d/${SHEET}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent("Vote totals")}`;
const OUT = path.join(__dirname, "..", "data", "baseline-2024-cd.json");

function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const num = (s) => { const n = Number(String(s || "").replace(/[,%\s]/g, "")); return isFinite(n) ? n : null; };

async function main() {
  const res = await fetch(URL_CSV, { headers: { "User-Agent": "pmap2.01 election tracker (cites The Downballot)" } });
  const text = await res.text();
  if (!res.ok || !/District/.test(text)) throw new Error(`sheet fetch failed: HTTP ${res.status} ${text.slice(0, 120)}`);
  const rows = parseCSV(text);
  const districts = {};
  for (const r of rows) {
    const code = (r[0] || "").trim();
    const m = code.match(/^([A-Z]{2})-(AL|\d\d)$/);
    if (!m) continue;
    // columns: District, Incumbent, Party, (blank), 2024 Harris, Trump, Total, Harris %, Trump %, Margin, (blank), 2020 Biden, Trump, Total, ...
    const harris = num(r[4]), trump = num(r[5]), total = num(r[6]);
    if (!harris || !trump || !total) continue;
    const key = `${m[1]}-${m[2] === "AL" ? "01" : m[2]}`;
    districts[key] = {
      harris, trump, total,
      marginD: Math.round(((harris - trump) / total) * 10000) / 100,
      newLines: !(num(r[11]) > 0), // no 2020 figure = district redrawn for 2026
    };
  }
  const n = Object.keys(districts).length;
  if (n < 430) throw new Error(`only ${n} districts parsed; sheet layout may have changed`);
  const H = Object.values(districts).reduce((a, d) => a + d.harris, 0), T = Object.values(districts).reduce((a, d) => a + d.trump, 0), V = Object.values(districts).reduce((a, d) => a + d.total, 0);
  const out = {
    source: "https://www.the-downballot.com/p/the-downballots-calculations-of-presidential",
    citation: "The Downballot, 2020 & 2024 presidential election results for congressional districts used in the 2026 elections (the-db.co/presbycd)",
    note: "2024 presidential results on the district lines used in 2026. Districts in states that redrew for 2026 are recalculated onto the new lines (newLines: true).",
    updated: new Date().toISOString(),
    national: { harris: H, trump: T, total: V, marginD: Math.round(((H - T) / V) * 10000) / 100 },
    districts,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const redrawn = [...new Set(Object.entries(districts).filter(([, d]) => d.newLines).map(([k]) => k.slice(0, 2)))];
  console.log(`pres by CD: ${n} districts, national D${out.national.marginD >= 0 ? "+" : ""}${out.national.marginD}, redrawn states: ${redrawn.join(" ")}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
