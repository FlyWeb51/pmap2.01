/**
 * scripts/promote-polls.js
 *
 * Turns the scraper's raw inbox (api/polls-inbox.json: Wikipedia,
 * PollingSource and Pollsmax rows, many duplicates, inconsistent race IDs)
 * into the clean per-race files the site reads:
 *
 *   data/polls/<raceId>.json          AZ-H-06-2026, IA-S-2026, generic-ballot
 *   data/poll-average/<raceId>.json   recency-weighted D and R average
 *   data/polls/index.json             one line per race: latest poll + average
 *
 * Automatic checks, since nobody hand-reviews 1,600 rows:
 *   - general election only: exactly one Democrat and one Republican must be
 *     identifiable (party tag in the row, or a last-name match to the FEC
 *     candidate list / Kalshi market names for that seat)
 *   - parsed end date, not in the future, cycle 2026
 *   - pollster cleaned of wiki markup and margin-of-error suffixes
 *   - duplicates (same race, pollster, end date within 2 days, same numbers)
 *     merged; every site the poll was found on is kept in `foundOn`
 *   - aggregate-only rows (site averages) are never treated as polls
 * Polls already in data/polls/ with an original sourceUrl are kept as-is.
 * Every promoted poll is marked reviewStatus: "auto" so it is distinguishable
 * from hand-approved ones.
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const INBOX = path.join(ROOT, "api", "polls-inbox.json");
const POLLS_DIR = path.join(ROOT, "data", "polls");
const AVG_DIR = path.join(ROOT, "data", "poll-average");
const FEC_DIR = path.join(ROOT, "data", "fec");
const KALSHI_DIR = path.join(ROOT, "data", "kalshi");
const TODAY = new Date();

const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/* ---------- race id ---------- */
function raceIdOf(p) {
  const id = String(p.raceId || "").trim();
  const agg = String(p.aggregatorUrl || "");
  if (/^generic/i.test(id)) return "generic-ballot";
  let m = id.match(/^([A-Z]{2})-senate$/i);
  if (m) return `${m[1].toUpperCase()}-S-2026`;
  m = id.match(/^([A-Z]{2})-(?:governor|gov)$/i);
  if (m) return `${m[1].toUpperCase()}-G-2026`;
  m = id.match(/^([A-Z]{2})-(\d{1,2})$/);
  if (m) return `${m[1]}-H-${String(Math.max(1, +m[2])).padStart(2, "0")}-2026`;
  m = id.match(/^([A-Z]{2})$/);
  if (m) {
    if (/governor/i.test(agg)) return `${m[1]}-G-2026`;
    if (/senate/i.test(agg)) return `${m[1]}-S-2026`;
  }
  return null;
}

/* ---------- dates ---------- */
function endDate(s) {
  s = String(s || "").replace(/rowspan="?\d+"?\s*\|?/g, "").replace(/&ndash;|–|—/g, "-").trim();
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})\s*$/) || s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // "August 31 - September 1, 2026", "September 3-5, 2026", "Oct 2, 2026"
  m = s.match(/([A-Za-z]+)?\s*(\d{1,2})\s*,?\s*(\d{4})\s*$/);
  if (m) {
    const year = m[3];
    let month = m[1] && MONTHS[m[1].toLowerCase()];
    if (!month) {
      const names = s.match(/[A-Za-z]+/g) || [];
      for (let i = names.length - 1; i >= 0; i--) if (MONTHS[names[i].toLowerCase()]) { month = MONTHS[names[i].toLowerCase()]; break; }
    }
    if (month) return `${year}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  return null;
}

/* ---------- pollster ---------- */
function cleanPollster(s) {
  let partisan = null;
  s = String(s || "")
    .replace(/rowspan="?\d+"?\s*\|?/g, "")
    .replace(/[a-z-]+="[^|]*\|/gi, "") // leftover wiki cell attributes: style="..."|
    .replace(/±\s*[\d.]+%?/g, "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s*\d{4}\s+err\s+[\d.]+/gi, "") // PollingSource accuracy note
    .trim();
  const tag = s.match(/\((D|R)\)/);
  if (tag) { partisan = tag[1]; s = s.replace(/\s*\((D|R)\)/g, "").trim(); }
  return { name: s.replace(/\s{2,}/g, " ").replace(/^[|\s]+|[|\s]+$/g, ""), partisan };
}
const pollsterKey = (s) => s.toLowerCase().replace(/[^a-z]/g, "").replace(/(college|university|poll|polling|research|group|insights|survey)/g, "").slice(0, 10);

/* ---------- parties ---------- */
const lastName = (n) => {
  const parts = String(n || "").replace(/\(.*?\)/g, "").replace(/,?\s+(jr|sr|ii|iii|iv)\.?$/i, "").trim().split(/\s+/);
  return (parts[parts.length - 1] || "").toLowerCase().replace(/[^a-z'-]/g, "");
};
const partyTag = (n) => {
  const m = String(n).match(/\((D|R|DFL|I|L|G|Ind|Lib|Grn)\)/i);
  if (!m) return null;
  const t = m[1].toUpperCase();
  return t === "DFL" ? "D" : t === "R" ? "R" : t === "D" ? "D" : "O";
};

// last name -> party, per seat, from FEC filings and Kalshi candidate names.
const partyCache = {};
function seatParties(raceId) {
  if (partyCache[raceId]) return partyCache[raceId];
  const map = {};
  const [st, type, num] = raceId.split("-");
  const fecFile = type === "S" ? `${st}-senate.json` : type === "H" ? `${st}-${num}.json` : null;
  const fec = fecFile && (read(path.join(FEC_DIR, fecFile)) || (type === "H" && num === "01" ? read(path.join(FEC_DIR, `${st}-00.json`)) : null));
  for (const c of (fec && fec.candidates) || []) {
    const last = String(c.name || "").split(",")[0].toLowerCase().trim().split(/\s+/).pop();
    const party = c.party === "DEM" || c.party === "DFL" ? "D" : c.party === "REP" ? "R" : "O";
    if (last && !map[last]) map[last] = party;
  }
  const kfile = type === "S" ? `${st}-senate.json` : type === "G" ? `${st}-governor.json` : type === "H" ? `${st}-${num}.json` : null;
  const k = kfile && read(path.join(KALSHI_DIR, kfile));
  if (k) {
    if (k.democrat && k.democrat.candidate) map[lastName(k.democrat.candidate)] = "D";
    if (k.republican && k.republican.candidate) map[lastName(k.republican.candidate)] = "R";
  }
  return (partyCache[raceId] = map);
}

function twoParty(raceId, results) {
  const map = seatParties(raceId);
  const tagged = results.map((r) => {
    const party = partyTag(r.candidate) || map[lastName(r.candidate)] || (/^democrat/i.test(r.candidate) ? "D" : /^republican/i.test(r.candidate) ? "R" : null);
    return { candidate: String(r.candidate).replace(/\s*\((D|R|DFL)\)\s*/i, "").trim(), party, pct: Number(r.pct ?? r.percentage) };
  }).filter((r) => isFinite(r.pct));
  const d = tagged.filter((r) => r.party === "D");
  const r = tagged.filter((x) => x.party === "R");
  if (d.length !== 1 || r.length !== 1) return null;
  return tagged;
}

/* ---------- weighting (same rules the site's averages describe) ---------- */
function weightOf(p) {
  const age = (TODAY - new Date(p.endDate)) / 864e5;
  const recency = Math.pow(0.5, Math.max(0, age) / 30);
  const sample = Math.min(Math.sqrt((p.sampleSize || 500) / 500), 2);
  const pop = { LV: 1, RV: 0.9, V: 0.9, A: 0.7 }[p.population] ?? 0.85;
  const partisan = p.partisan ? 0.5 : 1;
  return Math.round(recency * sample * pop * partisan * 10000) / 10000;
}

// The matchup most of the 8 newest polls test (e.g. Talarico vs Paxton, not
// pre-runoff Talarico vs Cornyn). Polls of other matchups stay listed but
// are left out of the average.
function currentMatchup(polls) {
  const key = (p) => ["D", "R"].map((pt) => lastName((p.results.find((x) => x.party === pt) || {}).candidate)).join("|");
  const counts = {};
  for (const p of polls.slice(0, 8)) counts[key(p)] = (counts[key(p)] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? { key, value: best[0] } : null;
}

function average(polls, raceId) {
  const cm = raceId === "generic-ballot" ? null : currentMatchup(polls);
  if (cm) for (const p of polls) p.otherMatchup = cm.key(p) !== cm.value || undefined;
  const recent = polls.filter((p) => !p.otherMatchup && (TODAY - new Date(p.endDate)) / 864e5 <= 90);
  if (!recent.length) return null;
  let w = 0, d = 0, r = 0;
  for (const p of recent) {
    const D = p.results.find((x) => x.party === "D"), R = p.results.find((x) => x.party === "R");
    if (!D || !R) continue;
    w += p.weight; d += p.weight * D.pct; r += p.weight * R.pct;
  }
  if (!w) return null;
  // Fullest version of each candidate's name across recent polls ("Sherrod Brown", not "Brown").
  const name = (party) => recent
    .map((p) => (p.results.find((x) => x.party === party) || {}).candidate || "")
    .map((n) => n.replace(/\s*\((D|R)\)\s*/g, ""))
    .sort((a, b) => b.length - a.length)[0];
  return {
    polls: recent.length,
    dem: Math.round((d / w) * 10) / 10, rep: Math.round((r / w) * 10) / 10,
    margin: Math.round(((d - r) / w) * 10) / 10,
    demCandidate: name("D") || "Democrat", repCandidate: name("R") || "Republican",
  };
}

/* ---------- main ---------- */
function main() {
  const inbox = read(INBOX, []);
  const byRace = {};
  let skipped = { noRace: 0, aggregate: 0, noDate: 0, notGeneral: 0, future: 0 };

  // Existing curated files first (they carry original source links).
  for (const f of fs.existsSync(POLLS_DIR) ? fs.readdirSync(POLLS_DIR) : []) {
    if (!/^[A-Z]{2}-[HSG]-.*\.json$|^generic-ballot\.json$/.test(f)) continue;
    const j = read(path.join(POLLS_DIR, f));
    const raceId = f.replace(/\.json$/, "");
    for (const p of (j && j.polls) || []) {
      if (p.reviewStatus === "auto") continue; // regenerated below
      const res = twoParty(raceId, p.results || []) || (p.results || []).map((r) => ({ candidate: r.candidate, party: partyTag(r.candidate), pct: Number(r.pct ?? r.percentage) }));
      const ed = p.endDate || endDate(p.fieldDates || p.completedDate);
      if (!ed) continue;
      (byRace[raceId] ||= []).push({ ...p, endDate: ed, results: res, reviewStatus: p.reviewStatus || "approved", foundOn: p.foundOn || [] });
    }
  }

  for (const raw of inbox) {
    if (raw.isAggregateOnly) { skipped.aggregate++; continue; }
    const raceId = raceIdOf(raw);
    if (!raceId) { skipped.noRace++; continue; }
    const ed = endDate(raw.fieldDates);
    if (!ed || !ed.startsWith("2026") && !ed.startsWith("2025")) { skipped.noDate++; continue; }
    if (new Date(ed) > new Date(TODAY.getTime() + 864e5)) { skipped.future++; continue; }
    const results = twoParty(raceId, raw.results || []);
    if (!results) { skipped.notGeneral++; continue; }
    const pn = cleanPollster(raw.pollster);
    const poll = {
      pollster: pn.name,
      endDate: ed,
      fieldDates: String(raw.fieldDates || "").replace(/rowspan="?\d+"?\s*\|?/g, "").replace(/[a-z-]+="[^|]*\|/gi, "").trim(),
      sampleSize: Number(raw.sampleSize) || null,
      population: raw.population ? String(raw.population).toUpperCase() : null,
      partisan: raw.partisanLean || pn.partisan || null,
      results,
      sourceUrl: raw.sourceUrl || null,
      foundOn: raw.aggregatorUrl ? [raw.aggregatorUrl] : [],
      reviewStatus: "auto",
    };
    const list = (byRace[raceId] ||= []);
    const dup = list.find((q) => {
      if (Math.abs(new Date(q.endDate) - new Date(ed)) > 2 * 864e5) return false;
      const qd = q.results.find((x) => x.party === "D"), qr = q.results.find((x) => x.party === "R");
      const pd = results.find((x) => x.party === "D"), pr = results.find((x) => x.party === "R");
      const same = qd && qr && Math.abs(qd.pct - pd.pct) < 0.6 && Math.abs(qr.pct - pr.pct) < 0.6;
      const a = pollsterKey(cleanPollster(q.pollster).name), b = pollsterKey(poll.pollster);
      return same && (a === b || a.slice(0, 4) === b.slice(0, 4));
    });
    if (dup) {
      // merge: fill gaps, remember every site it appeared on
      for (const k of ["sampleSize", "population", "partisan", "sourceUrl", "fieldDates"]) if (!dup[k] && poll[k]) dup[k] = poll[k];
      if (poll.pollster.length > dup.pollster.length && dup.reviewStatus === "auto") dup.pollster = poll.pollster;
      for (const r of dup.results) {
        const alt = poll.results.find((x) => x.party === r.party && x.party !== "O");
        if (alt && alt.candidate.length > r.candidate.length && dup.reviewStatus === "auto") r.candidate = alt.candidate;
      }
      for (const u of poll.foundOn) if (!dup.foundOn.includes(u)) dup.foundOn.push(u);
    } else list.push(poll);
  }

  fs.mkdirSync(POLLS_DIR, { recursive: true });
  fs.mkdirSync(AVG_DIR, { recursive: true });
  const index = {};
  let total = 0, auto = 0;
  for (const [raceId, polls] of Object.entries(byRace)) {
    polls.forEach((p) => {
      p.weight = weightOf(p);
      // keep both field names: the race panels read `pct`, older pages read `percentage`
      p.results = p.results.map((r) => ({ candidate: r.party && r.party !== "O" && raceId !== "generic-ballot" ? `${String(r.candidate).replace(/\s*\((D|R)\)\s*/g, "")} (${r.party})` : r.candidate, party: r.party, pct: r.pct, percentage: r.pct }));
    });
    polls.sort((a, b) => b.endDate.localeCompare(a.endDate));
    total += polls.length; auto += polls.filter((p) => p.reviewStatus === "auto").length;
    const avg = average(polls, raceId);
    fs.writeFileSync(path.join(POLLS_DIR, `${raceId}.json`), JSON.stringify({ raceId, count: polls.length, updated_at: new Date().toISOString(), polls }, null, 2));
    fs.writeFileSync(path.join(AVG_DIR, `${raceId}.json`), JSON.stringify({
      race_id: raceId, poll_count: avg ? avg.polls : 0, window_days: 90, ...(avg || {}),
      average: avg ? [{ candidate: `${avg.demCandidate} (D)`, pct: avg.dem }, { candidate: `${avg.repCandidate} (R)`, pct: avg.rep }] : [],
    }, null, 2));
    index[raceId] = { count: polls.length, latest: { pollster: polls[0].pollster, endDate: polls[0].endDate }, average: avg };
  }
  fs.writeFileSync(path.join(POLLS_DIR, "index.json"), JSON.stringify({ updated_at: new Date().toISOString(), races: index }, null, 2));
  const newest = Object.values(index).map((x) => x.latest.endDate).sort().pop();
  console.log(`polls: ${Object.keys(index).length} races, ${total} polls (${auto} auto-promoted), newest ${newest}. Skipped: ${JSON.stringify(skipped)}`);
}

main();
