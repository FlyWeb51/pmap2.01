/**
 * scripts/build-generic-ballot.js
 *
 * Rebuilds data/generic-ballot.json (the national generic ballot the homepage
 * shows on districts with no polling) from the live poll set in
 * data/polls/generic-ballot.json. Before this script existed that file was a
 * one-time CSV drop from July 29 and never changed.
 *
 * The headline average is copied from data/poll-average/generic-ballot.json so
 * every page on the site shows the same number. The series is a weekly
 * recency-weighted average using the same weights as promote-polls.js.
 *
 * Usage: node scripts/build-generic-ballot.js
 */
const fs = require("fs");

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const DAY = 864e5;
const today = new Date(new Date().toISOString().slice(0, 10));

const src = read("data/polls/generic-ballot.json", null);
const avg = read("data/poll-average/generic-ballot.json", null);
if (!src || !avg || typeof avg.dem !== "number") {
  console.log("generic ballot: inputs missing, leaving data/generic-ballot.json as is");
  process.exit(0);
}

const polls = (Array.isArray(src) ? src : src.polls || [])
  .map((p) => {
    const D = (p.results || []).find((r) => r.party === "D");
    const R = (p.results || []).find((r) => r.party === "R");
    const dem = D && Number(D.pct ?? D.percentage), rep = R && Number(R.pct ?? R.percentage);
    if (!p.endDate || !Number.isFinite(dem) || !Number.isFinite(rep)) return null;
    return {
      pollster: p.pollster, lean: p.partisan || null, date: p.endDate, n: p.sampleSize || null,
      population: p.population || null, dem, rep, margin: Math.round((dem - rep) * 10) / 10,
      sourceUrl: p.sourceUrl || (p.foundOn || [])[0] || null, race: "House - Generic Ballot",
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.date.localeCompare(b.date));

function weight(p, asOf) {
  const age = (asOf - new Date(p.date)) / DAY;
  const recency = Math.pow(0.5, Math.max(0, age) / 30);
  const sample = Math.min(Math.sqrt((p.n || 500) / 500), 2);
  const pop = { LV: 1, RV: 0.9, V: 0.9, A: 0.7 }[p.population] ?? 0.85;
  return recency * sample * pop * (p.lean ? 0.5 : 1);
}

function averageAt(asOf) {
  let w = 0, d = 0, r = 0;
  for (const p of polls) {
    const age = (asOf - new Date(p.date)) / DAY;
    if (age < 0 || age > 90) continue;
    const k = weight(p, asOf); w += k; d += k * p.dem; r += k * p.rep;
  }
  if (!w) return null;
  const r1 = (x) => Math.round(x * 100) / 100;
  return { dem: r1(d / w), rep: r1(r / w), margin: r1((d - r) / w) };
}

const series = [];
if (polls.length) {
  for (let t = new Date(polls[0].date); t <= today; t = new Date(+t + 7 * DAY)) {
    const a = averageAt(t);
    if (a) series.push({ date: t.toISOString().slice(0, 10), ...a });
  }
  const last = series[series.length - 1];
  const todayStr = today.toISOString().slice(0, 10);
  const head = { date: todayStr, dem: avg.dem, rep: avg.rep, margin: avg.margin };
  if (last && last.date === todayStr) series[series.length - 1] = head; else series.push(head);
}

const inWindow = polls.filter((p) => (today - new Date(p.date)) / DAY <= 90);
const out = {
  meta: {
    title: "U.S. House generic ballot, 2026",
    generated: new Date().toISOString(),
    asOf: polls.length ? polls[polls.length - 1].date : null,
    source: "Site poll set (NYT polling data, Wikipedia, PollingSource); average matches data/poll-average/generic-ballot.json",
    weighting: "recency (30-day half-life) x sqrt(sample size, capped 2x) x population (LV 1.0 / RV 0.9 / A 0.7) x independence (partisan 0.5), last 90 days",
    pollCount: avg.poll_count || inWindow.length,
    dateRange: inWindow.length ? [inWindow[0].date, inWindow[inWindow.length - 1].date] : [null, null],
  },
  average: { dem: avg.dem, rep: avg.rep, margin: avg.margin },
  series,
  polls,
};

fs.writeFileSync("data/generic-ballot.json", JSON.stringify(out, null, 2) + "\n");
console.log(`generic ballot: D ${avg.dem} / R ${avg.rep} (${out.meta.pollCount} polls, ${out.meta.dateRange.join(" to ")}), ${series.length} series points`);
