/**
 * scripts/smoke-test-data.js
 *
 * Fetches the data files the FRONTEND actually requests, from the DEPLOYED site,
 * and fails loudly if any are missing or the wrong shape.
 *
 * Runs against a URL, not the filesystem, on purpose. Every data bug this repo
 * has hit was invisible to a file check:
 *
 *   1. api/nominees.json and api/featured.json were committed correctly but
 *      404'd in the browser - Vercel treats /api as serverless functions and
 *      will not serve .json from there. Broken for months, silently.
 *   2. data/poll-average/*.json returned `average` as an OBJECT while the
 *      renderer expected an ARRAY of {candidate, percentage} -> "NaN%".
 *   3. data/polls/*.json used `pct`/`fieldDates` while the renderer read
 *      `percentage`/`endDate`, because update-data.yml regenerates those files
 *      from a different schema than the frontend was written against.
 *   4. A placeholder record ("Example Polling Co." / Jane Smith / John Doe)
 *      shipped to production because its reviewStatus was stale.
 *
 * None of those threw an error. They rendered nothing, or NaN, or fake names.
 * This script turns all four into a red build.
 *
 * Usage:  node scripts/smoke-test-data.js [baseUrl]
 * Default baseUrl: https://pmap2-01.vercel.app
 */

const BASE = (process.argv[2] || "https://pmap2-01.vercel.app").replace(/\/$/, "");

const failures = [];
const warnings = [];
let checked = 0;

function fail(path, msg) {
  failures.push(`${path}  ->  ${msg}`);
}
function warn(path, msg) {
  warnings.push(`${path}  ->  ${msg}`);
}

async function get(path, { required = true } = {}) {
  checked++;
  let res;
  try {
    res = await fetch(`${BASE}/${path}`, { headers: { Accept: "application/json" } });
  } catch (e) {
    fail(path, `network error: ${e.message}`);
    return null;
  }
  if (!res.ok) {
    if (required) fail(path, `HTTP ${res.status}`);
    return null;
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(path, `not valid JSON (first 60 chars: ${text.slice(0, 60).replace(/\s+/g, " ")})`);
    return null;
  }
}

const PLACEHOLDER = /example|placeholder|jane smith|john doe|lorem|dummy|test poll/i;

async function checkNominees() {
  const d = await get("data/nominees.json");
  if (!d) return;
  const seats = Object.keys(d).filter((k) => !k.startsWith("_"));
  if (!seats.length) return fail("data/nominees.json", "no seats");
  const bad = seats.filter((k) => !Array.isArray(d[k]));
  if (bad.length) fail("data/nominees.json", `non-array values: ${bad.slice(0, 5).join(", ")}`);
  console.log(`   nominees: ${seats.length} seats`);
}

async function checkFeatured() {
  const d = await get("data/featured.json");
  if (!d) return;
  const seats = Object.keys(d).filter((k) => !k.startsWith("_"));
  console.log(`   featured: ${seats.length} seats`);
}

async function checkGeneric() {
  const d = await get("data/generic-ballot.json");
  if (!d) return;
  const a = d.average || {};
  if (typeof a.dem !== "number" || typeof a.rep !== "number" || typeof a.margin !== "number")
    fail("data/generic-ballot.json", "average must have numeric dem/rep/margin");
  if (!Array.isArray(d.series) || !d.series.length)
    fail("data/generic-ballot.json", "series missing or empty");
  else {
    const p = d.series[0];
    if (!p.date || typeof p.dem !== "number")
      fail("data/generic-ballot.json", "series points need date + numeric dem");
  }
  console.log(`   generic ballot: D ${a.dem} / R ${a.rep}, ${(d.series || []).length} points`);
}

/** The exact shape loadPolls() consumes, after the schema-tolerant fix. */
async function checkPolls(raceId) {
  const d = await get(`data/polls/${raceId}.json`, { required: false });
  if (!d) return null;
  const polls = d.polls || d.data;
  if (!Array.isArray(polls)) return fail(`data/polls/${raceId}.json`, "polls is not an array");
  for (const p of polls) {
    if (PLACEHOLDER.test(`${p.pollster || ""} ${p.sourceUrl || ""}`))
      fail(`data/polls/${raceId}.json`, `placeholder pollster reaching production: "${p.pollster}"`);
    for (const r of p.results || []) {
      if (PLACEHOLDER.test(r.candidate || ""))
        fail(`data/polls/${raceId}.json`, `placeholder candidate: "${r.candidate}"`);
      const v = r.percentage !== undefined ? r.percentage : r.pct;
      if (typeof v !== "number" || Number.isNaN(v))
        fail(`data/polls/${raceId}.json`, `result "${r.candidate}" has no numeric percentage/pct -> renders NaN`);
    }
    if (!(p.endDate || p.completedDate || p.fieldDates))
      warn(`data/polls/${raceId}.json`, `poll "${p.pollster}" has no date field`);
  }
  return polls.length;
}

async function checkPollAverage(raceId) {
  const d = await get(`data/poll-average/${raceId}.json`, { required: false });
  if (!d) return;
  if (!Array.isArray(d.average))
    return fail(
      `data/poll-average/${raceId}.json`,
      "average must be an ARRAY of {candidate, percentage} - an object here is the NaN bug"
    );
  for (const a of d.average) {
    if (typeof a.percentage !== "number")
      fail(`data/poll-average/${raceId}.json`, `"${a.candidate}" percentage not numeric`);
  }
}

async function checkSeatFiles(code) {
  const [st, d] = code.split("-");
  await get(`data/fec/${st}-${d}.json`, { required: false });
  await get(`data/census/${st}-${d}.json`, { required: false });
}

async function main() {
  console.log(`Smoke-testing ${BASE}\n`);

  console.log("singletons:");
  await checkNominees();
  await checkFeatured();
  await checkGeneric();

  console.log("\nper-race:");
  const sample = ["AZ-02", "AZ-01", "OH-01", "CA-22", "PA-08", "TX-28", "NY-17", "ME-02"];
  let withPolls = 0;
  for (const code of sample) {
    const [st, dd] = code.split("-");
    const raceId = `${st}-H-${dd}-2026`;
    const n = await checkPolls(raceId);
    if (n) withPolls++;
    await checkPollAverage(raceId);
    await checkSeatFiles(code);
  }
  console.log(`   ${sample.length} seats sampled, ${withPolls} with polls`);

  console.log(`\n${checked} request(s) made.`);
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    warnings.forEach((w) => console.log(`   ! ${w}`));
  }
  if (failures.length) {
    console.log(`\n${failures.length} FAILURE(S):`);
    failures.forEach((f) => console.log(`   x ${f}`));
    process.exit(1);
  }
  console.log("\nAll data checks passed.");
}

main();
