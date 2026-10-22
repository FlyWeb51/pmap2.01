/**
 * scripts/add-crosstabs.js <batch.json>
 *
 * Adds crosstabs read by hand (in a Claude chat session) to data/crosstabs/,
 * with the same checks the automatic reader uses: the poll must already be in
 * data/polls/<raceId>.json, and its topline must match within 2 points.
 * Marks each poll as done so the automatic workflow won't read it again.
 *
 * batch.json: [ { raceId, pollster, end, pop, top: "47-45", url, g: "cat|group|d|r;..." } ]
 * `pollster` only needs to be a distinctive part of the name (e.g. "Marist").
 */
const fs = require("fs"), path = require("path");
const { validate } = require("./extract-crosstabs.js");
const ROOT = path.join(__dirname, ".."), OUT = path.join(ROOT, "data", "crosstabs");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const batch = read(process.argv[2], null);
if (!Array.isArray(batch)) { console.error("usage: node scripts/add-crosstabs.js batch.json"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const seenFile = path.join(OUT, "_seen.json"), seen = read(seenFile, {});
let ok = 0, bad = 0;
for (const b of batch) {
  const race = read(path.join(ROOT, "data", "polls", `${b.raceId}.json`), null);
  const p = race && race.polls.find((x) => x.endDate === b.end && x.pollster.toLowerCase().includes(b.pollster.toLowerCase()) && (!b.pop || x.population === b.pop));
  if (!p) { console.log(`skip ${b.raceId} ${b.pollster} ${b.end}: poll not in data/polls`); bad++; continue; }
  const D = p.results.find((r) => r.party === "D") || p.results.find((r) => r.party === "I"), R = p.results.find((r) => r.party === "R");
  const dv = D ? +(D.pct ?? D.percentage) : null, rv = R ? +(R.pct ?? R.percentage) : null;
  const [td, tr] = b.top.split("-").map(Number);
  const groups = b.g.split(";").map((s) => { const [category, group, dem, rep] = s.split("|"); return { category, group, dem: +dem, rep: +rep }; });
  const v = validate({ found: true, topline_dem: td, topline_rep: tr, groups }, dv, rv);
  if (!v.ok) { console.log(`skip ${b.raceId} ${p.pollster} ${b.end}: ${v.why}`); bad++; continue; }
  const file = path.join(OUT, `${b.raceId}.json`), cur = read(file, { raceId: b.raceId, polls: [] });
  cur.polls = cur.polls.filter((x) => !(x.pollster === p.pollster && x.end === p.endDate && (x.pop || "") === (p.population || "")));
  const clean = (c) => (c ? String(c.candidate).replace(/\s*\([A-Z]+\)\s*$/, "").trim() : null);
  cur.polls.push({ pollster: p.pollster, end: p.endDate, pop: p.population || null, n: p.sampleSize || null, url: b.url || p.sourceUrl, partisan: p.partisan || null, dName: clean(D), rName: clean(R), topline: { d: dv, r: rv }, groups: v.groups, note: null, model: "read in chat", at: new Date().toISOString() });
  cur.polls.sort((a, c) => (a.end < c.end ? 1 : -1));
  cur.updated = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(cur));
  seen[`${b.raceId}|${p.pollster}|${p.endDate}|${p.population || ""}`] = { status: "ok", groups: v.groups.length, at: new Date().toISOString(), by: "chat" };
  ok++; console.log(`added ${b.raceId} ${p.pollster} ${b.end}: ${v.groups.length} groups`);
}
fs.writeFileSync(seenFile, JSON.stringify(seen));
const index = {};
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".json") && !f.startsWith("_")) { const d = read(path.join(OUT, f), null); if (d && d.polls && d.polls.length) index[d.raceId] = d.polls.length; }
fs.writeFileSync(path.join(OUT, "_index.json"), JSON.stringify({ updated: new Date().toISOString(), races: index }));
console.log(`crosstabs: ${ok} added, ${bad} skipped`);
