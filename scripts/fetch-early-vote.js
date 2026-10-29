/**
 * scripts/fetch-early-vote.js
 *
 * Pulls the University of Florida Election Lab's 2026 early vote file (one row
 * per state) and writes what early-vote.html reads:
 *
 *   data/early-vote.json          latest numbers for every state + U.S. totals
 *   data/early-vote-history.json  one snapshot per day per state, so the page
 *                                 can chart how fast ballots are coming in
 *
 * Source: https://election.lab.ufl.edu/early-vote/2026-early-voting/
 * Data file: https://election.lab.ufl.edu/data-downloads/earlyvote/2026/US.csv
 * The Election Lab publishes this under CC BY-NC-ND 4.0, so the site credits
 * it everywhere the numbers appear and shows them as published.
 *
 * In the source file a 0 means "this state does not report this", not zero
 * ballots, so breakdowns that are all zero are written as null.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "early-vote.json");
const HIST = path.join(ROOT, "data", "early-vote-history.json");
const URL_CSV = "https://election.lab.ufl.edu/data-downloads/earlyvote/2026/US.csv";
const UA = "Mozilla/5.0 (compatible; pmap2.01-early-vote/1.0; election tracker crediting the UF Election Lab)";

const ATTRIBUTION = {
  text: "Early vote data: University of Florida Election Lab (Michael McDonald), CC BY-NC-ND 4.0",
  license: "https://creativecommons.org/licenses/by-nc-nd/4.0/",
  source: "https://election.lab.ufl.edu/early-vote/2026-early-voting/",
};
const AGE_LABELS = ["18-25", "26-40", "41-65", "65+"];
const RACE = { nh_white: "white", nh_black: "black", hispanic: "hispanic", nh_asian: "asian", nh_native_american: "native", nh_other: "other" };

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
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

const num = (v) => { const x = Number(String(v).replace(/,/g, "")); return isFinite(x) ? x : 0; };
const orNull = (x) => (x > 0 ? x : null);

// One breakdown for one ballot type ("voted", "accept", "inperson", "request")
function party(r, p) {
  const o = { dem: num(r[`${p}_dem`]), rep: num(r[`${p}_rep`]), none: num(r[`${p}_none`]) };
  return o.dem + o.rep + o.none > 0 ? o : null;
}
function race(r, p) {
  const o = {};
  for (const [k, name] of Object.entries(RACE)) o[name] = num(r[`${p}_${k}`]);
  return Object.values(o).some((x) => x > 0) ? o : null;
}
function age(r, p) {
  const o = {};
  AGE_LABELS.forEach((lab, i) => { o[lab] = num(r[`${p}_age_${i + 1}`]); });
  return Object.values(o).some((x) => x > 0) ? o : null;
}
function gender(r, p) {
  const o = { female: num(r[`${p}_female`]), male: num(r[`${p}_male`]), unknown: num(r[`${p}_gender_unknown`]) };
  return o.female + o.male > 0 ? o : null;
}
function breakdowns(r, p) {
  return { party: party(r, p), race: race(r, p), age: age(r, p), gender: gender(r, p) };
}

function toISO(d) {
  const m = String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : (d || null);
}

async function main() {
  let text;
  try {
    const res = await fetch(URL_CSV, { headers: { "User-Agent": UA, Accept: "text/csv,*/*", Referer: ATTRIBUTION.source } });
    text = await res.text();
    if (!res.ok || !/state_abbv/.test(text.slice(0, 400))) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  } catch (e) {
    console.error(`early vote: fetch failed (${e.message}); keeping the last file`);
    process.exit(0);
  }

  const rows = parseCSV(text).filter((r) => /^[A-Z]{2}$/.test(r.state_abbv));
  const states = {};
  for (const r of rows) {
    const voted = num(r.voted_all), inperson = num(r.inperson_all), mail = num(r.accept_all), requested = num(r.request_all);
    const turn2022 = num(r.turn_2022);
    states[r.state_abbv] = {
      name: r.state,
      lastUpdate: toISO(r.last_update),
      updatedToday: /^(1|true|yes)$/i.test(r.updates_today || ""),
      turnout2022: orNull(turn2022),
      voted: voted,
      inPerson: orNull(inperson),
      mailReturned: orNull(mail),
      mailRequested: orNull(requested),
      pctOf2022: turn2022 > 0 && voted > 0 ? Math.round((voted / turn2022) * 1000) / 10 : null,
      mailReturnRate: requested > 0 && mail > 0 ? Math.round((mail / requested) * 1000) / 10 : null,
      voters: breakdowns(r, "voted"),
      mail: breakdowns(r, "accept"),
      inPersonBy: breakdowns(r, "inperson"),
      requests: breakdowns(r, "request"),
      dataSource: r.data_source && r.data_source !== "0" ? r.data_source : null,
      notes: r.notes && r.notes !== "0" ? r.notes : null,
    };
  }

  const all = Object.values(states);
  const sum = (k) => all.reduce((a, s) => a + (s[k] || 0), 0);
  const withParty = all.filter((s) => s.voters.party);
  const partySum = withParty.reduce((a, s) => ({ dem: a.dem + s.voters.party.dem, rep: a.rep + s.voters.party.rep, none: a.none + s.voters.party.none }), { dem: 0, rep: 0, none: 0 });
  const national = {
    voted: sum("voted"),
    inPerson: sum("inPerson"),
    mailReturned: sum("mailReturned"),
    mailRequested: sum("mailRequested"),
    turnout2022: sum("turnout2022"),
    statesReporting: all.filter((s) => s.voted > 0).length,
    partyStates: withParty.map((s) => Object.keys(states).find((k) => states[k] === s)),
    party: withParty.length ? partySum : null,
  };
  national.pctOf2022 = national.turnout2022 ? Math.round((national.voted / national.turnout2022) * 1000) / 10 : null;

  const out = { updated_at: new Date().toISOString(), attribution: ATTRIBUTION, ageLabels: AGE_LABELS, national, states };
  fs.writeFileSync(OUT, JSON.stringify(out));

  // Daily history: keep the latest numbers seen for each state on each day.
  let hist = { attribution: ATTRIBUTION, days: {} };
  try { hist = JSON.parse(fs.readFileSync(HIST, "utf8")); } catch {}
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const snap = {};
  for (const [k, s] of Object.entries(states)) {
    if (!s.voted) continue;
    snap[k] = [s.voted, s.inPerson || 0, s.mailReturned || 0];
    if (s.voters.party) snap[k].push(s.voters.party.dem, s.voters.party.rep, s.voters.party.none);
  }
  hist.days[today] = snap;
  hist.columns = ["voted", "inPerson", "mailReturned", "dem", "rep", "none"];
  hist.updated_at = out.updated_at;
  fs.writeFileSync(HIST, JSON.stringify(hist));

  console.log(`early vote: ${Object.keys(states).length} states, ${national.voted.toLocaleString()} ballots (${national.pctOf2022}% of 2022 turnout), party data in ${withParty.length} states`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
