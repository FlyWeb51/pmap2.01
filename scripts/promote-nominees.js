/**
 * scripts/promote-nominees.js
 *
 * Moves everything from api/nominees-inbox.json into the live nominee files.
 *
 * Writes BOTH:
 *   api/nominees.json   - editable source of record
 *   data/nominees.json  - the copy the browser actually fetches, because Vercel
 *                         treats /api as serverless functions and will not serve
 *                         .json from there (this silently 404'd for months)
 *
 * Promotion is bulk and unreviewed by choice. To keep that from being invisible,
 * every seat the fetcher is less sure about is listed under "_review" in the
 * output, so when a wrong name shows up on the site there is a short list to
 * check rather than 285 entries to re-derive:
 *
 *   oneNominee      only one party's winner parsed - either genuinely
 *                   uncontested, or the other party's result was missed
 *   threePlusNames  more than two winners - usually minor-party primaries
 *                   (MT, NE), occasionally an over-match
 *   commonSurname   surname appears in 3+ seats nationally, so the fragment
 *                   may grab the wrong filer in a crowded FEC field
 *
 * Hand-verified entries in api/nominees.json win over scraped ones.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INBOX = path.join(ROOT, "api", "nominees-inbox.json");
const API_OUT = path.join(ROOT, "api", "nominees.json");
const DATA_OUT = path.join(ROOT, "data", "nominees.json");

const HELP =
  "Mark nominees here after each primary. Key = seat code matching the data files (AZ-05, TX-senate, VT-00). Value = list of name fragments as they appear in FEC data, e.g. KEENAN matches KEENAN, DANIEL. The site badges them, sorts them first, and tucks the rest behind Show All.";

function main() {
  const inbox = JSON.parse(fs.readFileSync(INBOX, "utf8"));
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(API_OUT, "utf8"));
  } catch {}

  // Seats a human verified by hand keep priority over anything scraped.
  const verified = new Set(
    Object.keys(prev._verified && Array.isArray(prev._verified) ? {} : {}).concat(
      Array.isArray(prev._verified) ? prev._verified : []
    )
  );

  const seats = inbox.seats || {};
  const counts = {};
  Object.values(seats).forEach((v) =>
    (v.nominees || []).forEach((n) => (counts[n] = (counts[n] || 0) + 1))
  );

  const out = { _help: HELP };
  out._generated = new Date().toISOString();
  out._source =
    "Bulk-promoted from api/nominees-inbox.json (PollingSource certified primary results). Unreviewed - see _review for the seats most likely to be wrong.";

  const review = { oneNominee: [], threePlusNames: [], commonSurname: [], notHeldYet: [] };

  const states = inbox.states || {};
  Object.entries(states).forEach(([st, v]) => {
    if (v.completed === false) review.notHeldYet.push(st + " (" + String(v.primaryDate).replace(/\s+/g, " ").trim() + ")");
  });

  let promoted = 0,
    kept = 0;
  for (const [code, v] of Object.entries(seats)) {
    const names = v.nominees || [];
    if (!names.length) continue;

    if (verified.has(code) && Array.isArray(prev[code])) {
      out[code] = prev[code];
      kept++;
    } else {
      out[code] = names;
      promoted++;
    }

    if (names.length === 1) review.oneNominee.push(code + ":" + names[0]);
    if (names.length > 2) review.threePlusNames.push(code + ":" + names.join("/"));
    const risky = names.filter((n) => counts[n] >= 3);
    if (risky.length) review.commonSurname.push(code + ":" + risky.join("/"));
  }

  // Carry forward any seat that existed before but the fetcher did not see.
  for (const [k, v] of Object.entries(prev)) {
    if (k.startsWith("_")) continue;
    if (!(k in out)) {
      out[k] = v;
      kept++;
    }
  }

  out._review = review;

  const json = JSON.stringify(out, null, 2);
  fs.mkdirSync(path.dirname(DATA_OUT), { recursive: true });
  fs.writeFileSync(API_OUT, json);
  fs.writeFileSync(DATA_OUT, json);

  const seatCount = Object.keys(out).filter((k) => !k.startsWith("_")).length;
  console.log(`Promoted ${promoted} seat(s), kept ${kept} existing.`);
  console.log(`nominees.json now covers ${seatCount} seat(s).`);
  console.log(`Flagged for review:`);
  console.log(`   one nominee only : ${review.oneNominee.length}`);
  console.log(`   three-plus names : ${review.threePlusNames.length}`);
  console.log(`   common surname   : ${review.commonSurname.length}`);
  console.log(`   primaries pending: ${review.notHeldYet.length} state(s)`);
  console.log(`Wrote api/nominees.json and data/nominees.json`);
}

main();
