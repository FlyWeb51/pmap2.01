/**
 * scripts/fetch-wiki-generic.js
 *
 * Statewide generic congressional ballot polls (Democratic vs Republican for
 * the U.S. House, no candidate names) for every state, from the "Statewide
 * polling" tables on Wikipedia's "2026 United States House of Representatives
 * elections in <State>" pages. Each poll keeps a link to its original source
 * when Wikipedia cites one.
 *
 * Writes data/generic-wiki.json:
 *   { updated, source, states: { "TX": [ { pollster, end, start, n, pop, moe, dem, rep, margin, lean, url } ] } }
 * margin = Democratic minus Republican, in points. lean = "R"/"D" when the
 * pollster is marked (R)/(D) on Wikipedia.
 *
 * Runs in GitHub Actions (needs `npm i --no-save linkedom`). The parser works
 * on any DOM, so the same code can be tested in a browser.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// "September 25 – October 5, 2026" / "Aug 27 – Sept 4, 2026" / "June 21, 2026" / "October 5–8, 2026"
function parseDates(s) {
  s = s.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim();
  const yr = (s.match(/(20\d\d)\s*$/) || [])[1];
  if (!yr) return { start: null, end: null };
  const parts = s.replace(/,?\s*20\d\d\s*$/, "").split(/\s*[–—-]\s*/);
  let mon = null; const out = [];
  for (const p of parts) {
    const m = p.match(/^([A-Za-z]+)\.?\s*(\d{1,2})$/) || p.match(/^(\d{1,2})$/);
    if (!m) continue;
    if (m.length === 3) { mon = MONTHS[m[1].slice(0, 3).toLowerCase()] || mon; out.push([mon, +m[2]]); }
    else if (mon) out.push([mon, +m[1]]);
  }
  if (!out.length) return { start: null, end: null };
  const f = ([mo, d]) => `${yr}-${pad(mo)}-${pad(d)}`;
  return { start: f(out[0]), end: f(out[out.length - 1]) };
}

// Expand a table into a grid of cells, honoring rowspan/colspan.
function grid(table) {
  const rows = [...table.querySelectorAll("tr")], g = [];
  rows.forEach((tr, r) => {
    g[r] = g[r] || [];
    let c = 0;
    for (const cell of [...tr.children]) {
      while (g[r][c]) c++;
      const rs = +cell.getAttribute("rowspan") || 1, cs = +cell.getAttribute("colspan") || 1;
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) { g[r + i] = g[r + i] || []; g[r + i][c + j] = cell; }
      c += cs;
    }
  });
  return g;
}
const txt = (cell) => {
  if (!cell) return "";
  const k = cell.cloneNode(true);
  k.querySelectorAll("sup, .reference, style").forEach((x) => x.remove());
  return k.textContent.replace(/\s+/g, " ").trim();
};
// The level-2 section a table sits in ("Statewide polling", "District 7", ...)
function sectionOf(t) {
  let top = t;
  while (top.parentElement && !(top.parentElement.classList && top.parentElement.classList.contains("mw-parser-output")) && top.parentElement.tagName !== "BODY") top = top.parentElement;
  for (let el = top.previousElementSibling; el; el = el.previousElementSibling) {
    if (el.tagName === "H2" || (el.classList && el.classList.contains("mw-heading2"))) return el.textContent.replace(/\[edit\]/g, "").trim();
  }
  return "";
}
const pct = (s) => { const m = String(s).match(/(\d+(?:\.\d+)?)\s*%/); return m ? +m[1] : null; };

function parseStatewide(doc) {
  for (const t of doc.querySelectorAll("table.wikitable")) {
    const g = grid(t);
    if (!g.length) continue;
    const head = g[0].map(txt);
    const col = (re) => head.findIndex((h) => re.test(h));
    const iSrc = col(/^poll ?source/i), iDem = col(/^(democratic|generic ?democrat(ic)?|dfl)$/i), iRep = col(/^(republican|generic ?republican)$/i);
    if (iSrc < 0 || iDem < 0 || iRep < 0) continue; // candidate tables have names, not parties
    if (/district|at-large/i.test(sectionOf(t))) continue; // a single seat's poll, not statewide
    const iDate = col(/date/i), iN = col(/sample/i), iMoe = col(/margin/i);
    const out = [], seen = new Set();
    for (let r = 1; r < g.length; r++) {
      const row = g[r];
      if (!row || !row[iSrc] || row[iSrc].tagName === "TH") continue;
      const dem = pct(txt(row[iDem])), rep = pct(txt(row[iRep]));
      if (dem == null || rep == null) continue;
      const src = txt(row[iSrc]), d = parseDates(txt(row[iDate]));
      const sm = txt(row[iN]).replace(/,/g, "").match(/(\d+)?\s*\((LV|RV|A)\)/i);
      let url = null;
      const ref = row[iSrc].querySelector("sup.reference a[href^='#']");
      if (ref) { const note = doc.getElementById(decodeURIComponent(ref.getAttribute("href").slice(1))); const a = note && note.querySelector("a.external"); if (a) url = a.getAttribute("href"); }
      const lean = /\((R)\)/.test(src) ? "R" : /\((D)\)/.test(src) ? "D" : null;
      const p = { pollster: src.replace(/\s*\((R|D)\)\s*/g, " ").trim(), start: d.start, end: d.end, n: sm && sm[1] ? +sm[1] : null, pop: sm ? sm[2].toUpperCase() : null, moe: txt(row[iMoe]) || null, dem, rep, margin: Math.round((dem - rep) * 10) / 10, lean, url };
      const key = `${p.pollster}|${p.end}|${p.pop}`;
      if (seen.has(key) || !p.end) continue; // same poll, LV/RV kept once each
      seen.add(key); out.push(p);
    }
    if (out.length) return out.sort((a, b) => (a.end < b.end ? 1 : -1));
  }
  return [];
}

const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
const pageOf = (name) => `2026_United_States_House_of_Representatives_elections_in_${name.replace(/ /g, "_")}`;

if (typeof module !== "undefined") module.exports = { parseStatewide, parseDates, STATES, pageOf };

if (typeof require !== "undefined" && require.main === module) {
  const fs = require("fs"), path = require("path");
  const { DOMParser } = require("linkedom");
  const OUT = path.join(__dirname, "..", "data", "generic-wiki.json");
  (async () => {
    const res = { updated: new Date().toISOString(), source: "Wikipedia, 2026 United States House of Representatives elections in each state (statewide polling tables); links go to each poll's original source", states: {} };
    let fails = 0;
    for (const [st, name] of Object.entries(STATES)) {
      const u = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageOf(name))}&prop=text&format=json&formatversion=2&redirects=1`;
      try {
        const r = await fetch(u, { headers: { "User-Agent": "pmap2.01 election tracker (github.com/FlyWeb51/pmap2.01)" } });
        const j = await r.json();
        if (!j.parse) continue;
        const doc = new DOMParser().parseFromString(`<html><body>${j.parse.text}</body></html>`, "text/html");
        const polls = parseStatewide(doc);
        if (polls.length) res.states[st] = polls;
      } catch (e) { fails++; console.log(`${st}: ${e.message}`); }
      await new Promise((ok) => setTimeout(ok, 400)); // be polite to the API
    }
    const n = Object.values(res.states).reduce((a, l) => a + l.length, 0);
    if (fails > 10) { console.error(`too many failures (${fails}); keeping the old file`); process.exit(1); }
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(`wiki generic: ${n} statewide polls in ${Object.keys(res.states).length} states (${Object.keys(res.states).join(" ")})`);
  })();
}
