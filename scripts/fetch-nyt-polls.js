/**
 * scripts/fetch-nyt-polls.js
 *
 * Pulls The New York Times polling datasets (CC BY 4.0) and converts them
 * into this site's poll format.
 *
 * Inputs (either or both):
 *   1. URLs listed in scripts/nyt-polls-sources.json  (fetched by the workflow)
 *   2. Any .csv files dropped into data/nyt-drop/     (manual fallback: download
 *      the CSVs from the NYT page yourself, commit them there, done)
 *
 * Outputs (data/polls-nyt/):
 *   <raceId>.json   e.g. AZ-S-2026.json, PA-H-07-2026.json, GA-G-2026.json
 *                   same shape as data/polls/<raceId>.json
 *   generic.json    generic congressional ballot polls + weighted average
 *   index.json      every race with poll count, latest poll, simple margin
 *   meta.json       timestamps, row counts, and the required attribution
 *
 * The NYT files follow the column layout 538 used (one row per candidate
 * answer, grouped by question_id). Column names are matched loosely so a
 * renamed column doesn't break the run; unknown layouts are reported, not
 * guessed at.
 *
 * License note: CC BY 4.0 requires attribution. meta.json carries the credit
 * line and the site displays it wherever these polls appear.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SOURCES = path.join(__dirname, "nyt-polls-sources.json");
const DROP_DIR = path.join(ROOT, "data", "nyt-drop");
const OUT_DIR = path.join(ROOT, "data", "polls-nyt");
const CYCLE = "2026";
const UA = "pmap2.01-poll-fetcher/1.0 (election tracker; attribution to The New York Times)";

const ATTRIBUTION = {
  text: "Polling data: The New York Times, licensed CC BY 4.0",
  license: "https://creativecommons.org/licenses/by/4.0/",
  source: "https://www.nytimes.com/interactive/polls/latest-polls.html",
};

const STATE_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};

/* ---------- CSV ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/^﻿/, ""));
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    head.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

// First non-empty value among several possible column names.
const pick = (o, ...keys) => { for (const k of keys) if (o[k] != null && o[k] !== "") return o[k]; return ""; };
const num = (v) => { const n = parseFloat(String(v).replace(/[%,]/g, "")); return isFinite(n) ? n : null; };

function isoDate(v) {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // 538 used m/d/yy
  if (m) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function stateCode(v) {
  if (!v) return null;
  const s = v.trim();
  if (/^[A-Z]{2}$/.test(s)) return s;
  return STATE_ABBR[s.toLowerCase().replace(/\s*cd-?\d+$/, "")] || null;
}

function partyCode(v) {
  const s = String(v || "").toUpperCase();
  if (s.startsWith("DEM") || s === "D") return "D";
  if (s.startsWith("REP") || s === "R") return "R";
  if (s.startsWith("IND") || s === "I") return "I";
  return s ? s.slice(0, 3) : "";
}

/* ---------- classify a row ---------- */
function raceIdFor(r) {
  const office = pick(r, "office_type", "office", "race_type", "type").toLowerCase();
  const st = stateCode(pick(r, "state", "state_abbrev", "state_name"));
  if (office.includes("senate")) return st ? `${st}-S-${CYCLE}` : null;
  if (office.includes("governor")) return st ? `${st}-G-${CYCLE}` : null;
  if (office.includes("house") || office.includes("representative")) {
    let d = pick(r, "seat_number", "district", "seat_name", "cd");
    d = parseInt(String(d).replace(/\D/g, ""), 10);
    if (!st || !isFinite(d)) return null;
    return `${st}-H-${String(Math.max(d, 1)).padStart(2, "0")}-${CYCLE}`;
  }
  return null;
}

function isGeneric(rows) {
  const h = Object.keys(rows[0] || {});
  return h.includes("dem") && h.includes("rep");
}

/* ---------- conversion ---------- */
function pollMeta(r) {
  const pop = pick(r, "population", "population_full").toUpperCase();
  const partisan = pick(r, "partisan");
  const internal = /^(true|1|yes)$/i.test(pick(r, "internal"));
  return {
    pollster: pick(r, "display_name", "pollster", "pollster_name", "pollster_display_name") || "Unknown",
    sponsors: pick(r, "sponsors", "sponsor") || null,
    startDate: isoDate(pick(r, "start_date", "startdate")),
    endDate: isoDate(pick(r, "end_date", "enddate", "date")),
    sampleSize: num(pick(r, "sample_size", "samplesize", "sample")),
    population: pop ? pop.split("-")[0] : null,
    partisan: partisan || null,
    internal,
    sourceUrl: pick(r, "url", "url_topline", "source_url", "link") || null,
    sourceTag: "nyt",
  };
}

function convertRaceRows(rows, stats) {
  const byQuestion = new Map();
  for (const r of rows) {
    const cycle = pick(r, "cycle", "election_cycle");
    if (cycle && cycle !== CYCLE) continue;
    const stage = pick(r, "stage").toLowerCase();
    // Primaries are over; keep the general-election picture (and runoffs).
    if (stage && !stage.includes("general") && !stage.includes("runoff")) continue;
    const raceId = raceIdFor(r);
    if (!raceId) { stats.unmatched++; continue; }
    const qid = pick(r, "question_id", "poll_id") + "|" + raceId;
    if (!byQuestion.has(qid)) byQuestion.set(qid, { raceId, meta: pollMeta(r), hypothetical: /^true$/i.test(pick(r, "hypothetical")), results: [] });
    const pct = num(pick(r, "pct", "percentage", "value"));
    if (pct == null) continue;
    const name = pick(r, "candidate_name", "candidate", "answer");
    const party = partyCode(pick(r, "party", "candidate_party"));
    byQuestion.get(qid).results.push({ candidate: party ? `${name} (${party})` : name, party, percentage: pct });
  }

  const races = {};
  for (const q of byQuestion.values()) {
    if (q.results.length < 2) continue;
    q.results.sort((a, b) => b.percentage - a.percentage);
    (races[q.raceId] ||= []).push({ ...q.meta, hypothetical: q.hypothetical, results: q.results, note: null });
  }
  // If a poll asked several matchups, keep non-hypothetical ones when present.
  for (const id of Object.keys(races)) {
    const real = races[id].filter((p) => !p.hypothetical);
    if (real.length) races[id] = real;
    races[id].sort((a, b) => String(b.endDate).localeCompare(String(a.endDate)));
  }
  return races;
}

function convertGeneric(rows) {
  return rows
    .filter((r) => { const c = pick(r, "cycle"); return !c || c === CYCLE; })
    .map((r) => ({ ...pollMeta(r), dem: num(r.dem), rep: num(r.rep) }))
    .filter((p) => p.dem != null && p.rep != null && p.endDate)
    .sort((a, b) => b.endDate.localeCompare(a.endDate));
}

// Same spirit as the site's existing weighting: recency x sample x population x partisanship.
function weightedAverage(polls, valueFn, asOf = new Date()) {
  let wsum = 0, vsum = 0, used = 0;
  for (const p of polls) {
    const ageDays = (asOf - new Date(p.endDate)) / 864e5;
    if (ageDays < 0 || ageDays > 60) continue;
    const v = valueFn(p);
    if (v == null) continue;
    const recency = Math.pow(0.5, ageDays / 14);
    const sample = Math.min(Math.sqrt((p.sampleSize || 600) / 600), 2);
    const pop = { LV: 1, RV: 0.9, V: 0.9, A: 0.7 }[p.population] ?? 0.85;
    const partisan = p.partisan || p.internal ? 0.5 : 1;
    const w = recency * sample * pop * partisan;
    wsum += w; vsum += w * v; used++;
  }
  return used ? { value: Math.round((vsum / wsum) * 10) / 10, polls: used } : null;
}

function marginOf(p) {
  const d = p.results.find((x) => x.party === "D");
  const r = p.results.find((x) => x.party === "R");
  return d && r ? d.percentage - r.percentage : null;
}

/* ---------- load inputs ---------- */
async function loadInputs() {
  const files = [];
  if (fs.existsSync(SOURCES)) {
    const cfg = JSON.parse(fs.readFileSync(SOURCES, "utf8"));
    for (const f of cfg.files || []) {
      if (!f.url) continue;
      try {
        const res = await fetch(f.url, { headers: { "User-Agent": UA } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        files.push({ name: f.name || f.url, text: await res.text(), from: f.url });
        console.log(`[nyt] fetched ${f.name || f.url}`);
      } catch (e) {
        console.log(`[nyt] FAILED ${f.name || f.url}: ${e.message}`);
      }
    }
  }
  if (fs.existsSync(DROP_DIR)) {
    for (const fn of fs.readdirSync(DROP_DIR).filter((x) => x.toLowerCase().endsWith(".csv"))) {
      files.push({ name: fn, text: fs.readFileSync(path.join(DROP_DIR, fn), "utf8"), from: `data/nyt-drop/${fn}` });
      console.log(`[nyt] read dropped file ${fn}`);
    }
  }
  return files;
}

async function main() {
  const inputs = await loadInputs();
  if (!inputs.length) {
    console.log("[nyt] No sources configured yet. Add download links to scripts/nyt-polls-sources.json or drop CSVs into data/nyt-drop/.");
    return;
  }

  const stats = { files: [], unmatched: 0 };
  const races = {};
  let generic = [];

  for (const f of inputs) {
    const rows = parseCSV(f.text);
    if (!rows.length) { stats.files.push({ name: f.name, rows: 0, kind: "empty" }); continue; }
    if (isGeneric(rows)) {
      generic = generic.concat(convertGeneric(rows));
      stats.files.push({ name: f.name, rows: rows.length, kind: "generic" });
      continue;
    }
    if (!Object.keys(rows[0]).some((k) => ["pct", "percentage"].includes(k))) {
      stats.files.push({ name: f.name, rows: rows.length, kind: "skipped (no pct column)", columns: Object.keys(rows[0]).slice(0, 30) });
      continue;
    }
    const conv = convertRaceRows(rows, stats);
    for (const [id, polls] of Object.entries(conv)) (races[id] ||= []).push(...polls);
    stats.files.push({ name: f.name, rows: rows.length, kind: "race", races: Object.keys(conv).length });
  }

  // Safety: if every input parsed to nothing, don't wipe the last good output.
  if (!Object.keys(races).length && !generic.length) {
    console.error("[nyt] Inputs parsed to zero polls. Column layout may have changed:", JSON.stringify(stats, null, 2));
    process.exit(1);
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index = {};
  for (const [raceId, pollsRaw] of Object.entries(races)) {
    const seen = new Set();
    const polls = pollsRaw.filter((p) => {
      const k = [p.pollster, p.endDate, p.sampleSize, p.population, p.results.map((r) => r.percentage).join("/")].join("|");
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    const avg = weightedAverage(polls, marginOf);
    fs.writeFileSync(path.join(OUT_DIR, `${raceId}.json`), JSON.stringify({ raceId, count: polls.length, attribution: ATTRIBUTION, polls }, null, 2));
    index[raceId] = {
      count: polls.length,
      latest: polls[0] ? { pollster: polls[0].pollster, endDate: polls[0].endDate, margin: marginOf(polls[0]) } : null,
      averageMargin: avg ? avg.value : null,
      averagePolls: avg ? avg.polls : 0,
    };
  }

  const gAvgD = weightedAverage(generic, (p) => p.dem);
  const gAvgR = weightedAverage(generic, (p) => p.rep);
  fs.writeFileSync(path.join(OUT_DIR, "generic.json"), JSON.stringify({
    attribution: ATTRIBUTION,
    average: gAvgD && gAvgR ? { dem: gAvgD.value, rep: gAvgR.value, margin: Math.round((gAvgD.value - gAvgR.value) * 10) / 10, polls: gAvgD.polls } : null,
    polls: generic.slice(0, 400),
  }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "index.json"), JSON.stringify(index, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "meta.json"), JSON.stringify({
    updated_at: new Date().toISOString(),
    attribution: ATTRIBUTION,
    races: Object.keys(index).length,
    genericPolls: generic.length,
    unmatchedRows: stats.unmatched,
    files: stats.files,
  }, null, 2));

  console.log(`[nyt] ${Object.keys(index).length} races, ${generic.length} generic-ballot polls, ${stats.unmatched} unmatched rows.`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
