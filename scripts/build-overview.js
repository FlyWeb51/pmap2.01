/**
 * scripts/build-overview.js
 *
 * Builds data/overview.json for overview.html (the national "big picture"
 * page): chamber control math, wave meter, flip watch list.
 *
 * Inputs, all already in the repo:
 *   index.html               MEMBERS, RATINGS_OVERRIDES, APPORTION (current seats + ratings)
 *   data/kalshi/*.json        per-race and national prediction-market odds
 *   data/polls-nyt/*.json     NYT polls (if configured)
 *   data/generic-ballot.json  older generic-ballot average (fallback)
 *
 * Runs at the end of the Kalshi and NYT workflows. No network calls.
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (p, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8")); } catch { return fallback; }
};

/* ---------- pull the embedded constants out of index.html ---------- */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
function constant(name) {
  const m = html.match(new RegExp("^const " + name + " = (.*);\\s*$", "m"));
  if (!m) throw new Error(`Could not find const ${name} in index.html`);
  return Function(`"use strict";return (${m[1]});`)();
}
const MEMBERS = constant("MEMBERS");
const RATINGS_OVERRIDES = constant("RATINGS_OVERRIDES");
const APPORTION = constant("APPORTION");
const STATE_NAMES = constant("STATE_NAMES");

const CATS = ["Solid D", "Likely D", "Lean D", "Tilt D", "Tilt R", "Lean R", "Likely R", "Solid R"];
const KEY2CAT = { SolidD: "Solid D", LikelyD: "Likely D", LeanD: "Lean D", TiltD: "Tilt D", TiltR: "Tilt R", LeanR: "Lean R", LikelyR: "Likely R", SolidR: "Solid R" };
// Rough win probability for the D candidate by rating, used only where Kalshi has no market.
const RATING_PD = { "Solid D": 0.99, "Likely D": 0.9, "Lean D": 0.75, "Tilt D": 0.58, "Tilt R": 0.42, "Lean R": 0.25, "Likely R": 0.1, "Solid R": 0.01 };

const kHouse = read("data/kalshi/all-house.json", {});
const kSenate = read("data/kalshi/all-senate.json", {});
const kNational = read("data/kalshi/national.json", {});
const kMeta = read("data/kalshi/meta.json", {});
const nytIndex = read("data/polls-nyt/index.json", {});
const nytGeneric = read("data/polls-nyt/generic.json", null);
const nytMeta = read("data/polls-nyt/meta.json", null);
const oldGeneric = read("data/generic-ballot.json", null);
const kGov = read("data/kalshi/all-governor.json", {});
const pollIndex = (read("data/polls/index.json", {}) || {}).races || {};
const genericAvg = read("data/poll-average/generic-ballot.json", null);
// Race polling: NYT when configured, otherwise the site's own promoted polls.
const pollFor = (raceId) => {
  const n = nytIndex[raceId];
  if (n && n.averageMargin != null) return { averageMargin: n.averageMargin, averagePolls: n.averagePolls, latest: n.latest, source: "NYT" };
  const p = pollIndex[raceId];
  if (p && p.average) return { averageMargin: p.average.margin, averagePolls: p.average.polls, latest: p.latest, source: "site" };
  return null;
};

const kalshiD = (e) => {
  if (!e) return null;
  const d = e.democrat, r = e.republican;
  if (d && d.share != null) return d.share / 100;
  if (d && r) return d.pct / (d.pct + r.pct);
  if (d) return d.pct / 100;
  if (r) return 1 - (r.share ?? r.pct) / 100;
  return null;
};

/* ---------- House ---------- */
const overrideMap = {};
for (const [k, list] of Object.entries(RATINGS_OVERRIDES)) list.forEach((id) => (overrideMap[id] = KEY2CAT[k]));

const house = { current: { D: 0, R: 0, I: 0, vacant: 0 }, ratings: Object.fromEntries(CATS.map((c) => [c, 0])), seats: [] };
for (const [st, n] of Object.entries(APPORTION)) {
  for (let d = 1; d <= n; d++) {
    const dn = n === 1 ? 0 : d;
    const m = MEMBERS.find((x) => x.c === "rep" && x.s === st && (x.d === dn || (n === 1 && (x.d === 0 || x.d === 1))));
    const id = `${st}-${String(d).padStart(2, "0")}`;
    const holder = m ? m.p : "V";
    if (holder === "V") house.current.vacant++; else house.current[holder] = (house.current[holder] || 0) + 1;
    const rating = overrideMap[`${st}-${d}`] || (m ? (m.p === "R" ? "Solid R" : "Solid D") : null);
    if (rating) house.ratings[rating]++;
    const k = kalshiD(kHouse[id]);
    const pD = k != null ? k : rating ? RATING_PD[rating] : 0.5;
    house.seats.push({ id, label: n === 1 ? `${st}-AL` : id, holder, incumbent: m ? m.n : null, rating, kalshiD: k, pD, nyt: pollFor(`${st}-H-${String(d).padStart(2, "0")}-2026`) });
  }
}
const r = house.ratings;
house.byRating = {
  D: r["Solid D"] + r["Likely D"] + r["Lean D"],
  tiltD: r["Tilt D"], tiltR: r["Tilt R"],
  R: r["Solid R"] + r["Likely R"] + r["Lean R"],
};
house.expectedD = Math.round(house.seats.reduce((s, x) => s + x.pD, 0));
house.expectedR = 435 - house.expectedD;
house.kalshiMarkets = Object.keys(kHouse).length;

/* ---------- Senate ---------- */
const SENATORS = MEMBERS.filter((m) => m.c === "sen");
const upNow = (m) => m.e.startsWith("2027") || m.e.startsWith("2026");
const holdover = { D: 0, R: 0 };
for (const m of SENATORS) if (!upNow(m)) holdover[m.p === "R" ? "R" : "D"]++; // independents caucus with Dems
const senate = { current: { D: 0, R: 0, I: 0 }, holdover, races: [] };
for (const m of SENATORS) senate.current[m.p]++;
for (const m of SENATORS.filter(upNow)) {
  const k = kalshiD(kSenate[m.s]);
  senate.races.push({
    state: m.s, name: STATE_NAMES[m.s], incumbent: m.n, holder: m.p,
    special: m.e.startsWith("2026"),
    kalshiD: k,
    nyt: pollFor(`${m.s}-S-2026`),
  });
}
senate.races.sort((a, b) => (a.kalshiD == null) - (b.kalshiD == null) || Math.abs((a.kalshiD ?? 0.5) - 0.5) - Math.abs((b.kalshiD ?? 0.5) - 0.5));
const pdSen = (x) => (x.kalshiD != null ? x.kalshiD : x.holder === "R" ? 0.1 : 0.9);
senate.expectedD = Math.round(holdover.D + senate.races.reduce((s, x) => s + pdSen(x), 0));
senate.expectedR = 100 - senate.expectedD;
senate.needForMajorityD = 51; // VP breaks ties for Republicans
senate.needForMajorityR = 50;
senate.dNetNeeded = 51 - (senate.current.D + senate.current.I);

/* ---------- Generic ballot / wave meter ---------- */
let generic = null;
if (nytGeneric && nytGeneric.average) {
  generic = { ...nytGeneric.average, source: "The New York Times (CC BY 4.0)", asOf: nytMeta && nytMeta.updated_at };
} else if (genericAvg && genericAvg.margin != null) {
  generic = { dem: genericAvg.dem, rep: genericAvg.rep, margin: genericAvg.margin, polls: genericAvg.poll_count, source: `${genericAvg.poll_count} polls from the last ${genericAvg.window_days} days (Wikipedia, PollingSource), recency-weighted`, asOf: (pollIndex["generic-ballot"] || {}).latest && pollIndex["generic-ballot"].latest.endDate };
} else if (oldGeneric && oldGeneric.average) {
  generic = { ...oldGeneric.average, polls: oldGeneric.meta && oldGeneric.meta.pollCount, source: oldGeneric.meta && oldGeneric.meta.source, asOf: oldGeneric.meta && oldGeneric.meta.asOf };
}
// National House popular vote margins in recent midterms (D minus R, points).
const HISTORY = [
  { year: 2006, margin: 8.0, note: "Democrats gained 31 seats" },
  { year: 2010, margin: -6.8, note: "Republicans gained 63 seats" },
  { year: 2014, margin: -5.7, note: "Republicans gained 13 seats" },
  { year: 2018, margin: 8.6, note: "Democrats gained 41 seats" },
  { year: 2022, margin: -2.8, note: "Republicans gained 9 seats" },
];
function waveLabel(m) {
  if (m == null) return "No data";
  const a = Math.abs(m), side = m > 0 ? "Blue" : "Red";
  if (a >= 7) return `${side} wave`;
  if (a >= 4) return `${side} tilt`;
  if (a >= 1.5) return `Lean ${m > 0 ? "D" : "R"}`;
  return "Neutral";
}

/* ---------- Flip watch ---------- */
const flips = [];
for (const s of house.seats) {
  if (s.kalshiD == null || s.holder === "V") continue;
  const fav = s.kalshiD >= 0.5 ? "D" : "R";
  if ((s.holder === "R" && fav === "D") || (s.holder === "D" && fav === "R")) {
    flips.push({ chamber: "House", id: s.label, holder: s.holder, incumbent: s.incumbent, favored: fav, prob: Math.round(Math.max(s.kalshiD, 1 - s.kalshiD) * 100) });
  }
}
for (const s of senate.races) {
  if (s.kalshiD == null) continue;
  const fav = s.kalshiD >= 0.5 ? "D" : "R";
  const h = s.holder === "I" ? "D" : s.holder;
  if (h !== fav) flips.push({ chamber: "Senate", id: s.state, holder: s.holder, incumbent: s.incumbent, favored: fav, prob: Math.round(Math.max(s.kalshiD, 1 - s.kalshiD) * 100) });
}
flips.sort((a, b) => b.prob - a.prob);

// Closest races by market odds (most uncertain first).
const tossups = house.seats
  .filter((s) => s.kalshiD != null)
  .sort((a, b) => Math.abs(a.kalshiD - 0.5) - Math.abs(b.kalshiD - 0.5))
  .slice(0, 15)
  .map((s) => ({ id: s.label, holder: s.holder, incumbent: s.incumbent, dPct: Math.round(s.kalshiD * 100) }));

/* ---------- Governors ---------- */
const governors = Object.values(kGov).map((g) => {
  const d = kalshiD(g);
  return {
    state: g.state, name: STATE_NAMES[g.state], kalshiD: d,
    dem: g.democrat && g.democrat.candidate, rep: g.republican && g.republican.candidate,
    poll: pollFor(`${g.state}-G-2026`),
  };
}).sort((a, b) => Math.abs(a.kalshiD - 0.5) - Math.abs(b.kalshiD - 0.5));

/* ---------- Market-implied national numbers ---------- */
const markets = {
  houseControlD: kNational.house && (kNational.house.outcomes.find((o) => /dem/i.test(o.label)) || {}).pct,
  senateControlD: kNational.senate && (kNational.senate.outcomes.find((o) => /dem/i.test(o.label)) || {}).pct,
  blueWave: kNational.blueWave || null,
  popVoteMarginD: kNational.housePopVoteMarginD ? kNational.housePopVoteMarginD.median : null,
  houseSeatsD: kNational.houseSeatsD ? kNational.houseSeatsD.median : null,
  senateSeatsWonD: kNational.senateSeatsWonD ? kNational.senateSeatsWonD.median : null,
};

const out = {
  generatedAt: new Date().toISOString(),
  electionDate: "2026-11-03",
  house: {
    current: house.current, ratings: house.ratings, byRating: house.byRating,
    expectedD: house.expectedD, expectedR: house.expectedR, kalshiMarkets: house.kalshiMarkets,
    netD: house.expectedD - (house.current.D + house.current.I),
  },
  senate: {
    current: senate.current, holdover: senate.holdover, expectedD: senate.expectedD, expectedR: senate.expectedR,
    dNetNeeded: senate.dNetNeeded, races: senate.races,
  },
  generic: generic ? { ...generic, label: waveLabel(generic.margin) } : null,
  history: HISTORY,
  kalshiNational: kNational,
  markets,
  governors,
  flips: flips.slice(0, 40),
  flipCounts: {
    houseDtoR: flips.filter((f) => f.chamber === "House" && f.favored === "R").length,
    houseRtoD: flips.filter((f) => f.chamber === "House" && f.favored === "D").length,
    senateDtoR: flips.filter((f) => f.chamber === "Senate" && f.favored === "R").length,
    senateRtoD: flips.filter((f) => f.chamber === "Senate" && f.favored === "D").length,
  },
  tossups,
  sources: {
    kalshiUpdated: kMeta.updated_at || null,
    nytUpdated: nytMeta ? nytMeta.updated_at : null,
    nytAttribution: nytMeta ? nytMeta.attribution : null,
  },
};

fs.writeFileSync(path.join(ROOT, "data", "overview.json"), JSON.stringify(out, null, 2));
console.log(`overview: House exp D ${out.house.expectedD} / R ${out.house.expectedR}; Senate exp D ${out.senate.expectedD} / R ${out.senate.expectedR}; generic ${generic ? generic.margin : "n/a"}; ${flips.length} favored flips`);
