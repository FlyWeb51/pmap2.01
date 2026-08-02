/**
 * scripts/fetch-nominees.js
 *
 * Answers "who is actually running in each race?" so the site stops showing a
 * scrambled field of primary losers once primaries are over.
 *
 * Every run, this:
 *   1. Fetches one page per state: pollingsource.com/primaries/<ST>
 *      (50 requests total, not 435 - the state page lists every district)
 *   2. Parses each district's primary result tables, where the winner of each
 *      party primary carries a check mark after their vote percentage
 *   3. Converts winners to uppercase, accent-stripped SURNAME fragments, which
 *      is the form api/nominees.json uses to match FEC candidate records
 *   4. Records the primary date and whether it has happened yet
 *   5. Writes everything to api/nominees-inbox.json
 *
 * IMPORTANT: this NEVER writes api/nominees.json directly. Same safety valve as
 * scrape-polls.js - nothing reaches the live site until a human reviews the
 * inbox and moves entries across. Surname fragments are deliberately fuzzy
 * (LEE matches a lot of people), so the review step is doing real work.
 *
 * Env: none required.
 * Run: node scripts/fetch-nominees.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INBOX_PATH = path.join(ROOT, "api", "nominees-inbox.json");
const LIVE_PATH = path.join(ROOT, "api", "nominees.json");

const UA =
  "pmap2.01-nominee-fetcher/1.0 (educational election tracker; contact via repo issues)";

const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

/** Strip tags/entities down to plain text, preserving the check marks. */
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#10003;|&check;|&#x2713;/g, "✓")
    .replace(/[ \t]+/g, " ");
}

/** "Marlene Galan-Woods" -> "GALAN-WOODS"; matches how FEC stores surnames. */
function surnameFragment(name) {
  const clean = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")     // drop accents
    .replace(/\s*\*\s*/g, "")            // incumbent marker
    .replace(/\s*\([A-Za-z]{1,3}\)\s*/g, "") // party tag
    .replace(/\b(Jr|Sr|II|III|IV)\.?\b/gi, "")
    .trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return parts[parts.length - 1].toUpperCase();
}

/**
 * Within one district's slice of text, find winners. Source renders results as
 *   Democratic  Jonathan Nez 53,354 100.0% ✓   Marlene Galan-Woods 22,320 33.6%
 * so a winner is a name followed by votes, a percentage, then a check.
 */
function parseWinners(slice) {
  const winners = [];
  const re =
    /([A-Z][A-Za-z'À-ɏ.\-]+(?:\s+[A-Z][A-Za-z'À-ɏ.\-]+){0,3})\s+[\d,]{2,}\s+\d{1,3}(?:\.\d+)?%\s*✓/g;
  let m;
  while ((m = re.exec(slice)) !== null) {
    const frag = surnameFragment(m[1]);
    if (frag && !winners.includes(frag)) winners.push(frag);
  }
  return winners;
}

/**
 * The state page labels nominees explicitly:
 *   "James Talarico Nominee $68,555,930 raised"
 * That is far more reliable than inferring from the primary-results check
 * marks, and it is the only place Senate nominees appear at all. Texas is the
 * case that forced this: Ken Paxton beat Cornyn in a runoff, so every source
 * that keys off the incumbent still shows Cornyn.
 */
function parseNomineeSection(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return {};
  /* Section runs to the next TOP-LEVEL heading. Note indexOf("## ") is wrong
     here: "### Democrat" contains "## " starting at index 1, so a plain search
     truncates the section after two lines. Match a line start with exactly two
     hashes instead. */
  const rest = text.slice(start + heading.length);
  const nextTop = rest.search(/\n##[^#]/);
  const end = nextTop === -1 ? text.length : start + heading.length + nextTop;
  const body = text.slice(start, end);

  const out = {};
  let party = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const head = line.match(/^###\s+(Democrat|Republican|Independent|L|G)\b/i);
    if (head) { party = head[1][0].toUpperCase(); continue; }
    if (!party || (party !== "D" && party !== "R")) continue;
    if (!/\bNominee\b/.test(line)) continue;
    // strip the label and anything after it (money, "Incumbent", etc.)
    const name = line.split(/\bNominee\b/)[0]
      .replace(/\bIncumbent\b/gi, "")
      .replace(/\$[\d,]+.*$/, "")
      .trim();
    const frag = surnameFragment(name);
    if (frag && !(out[party] || []).includes(frag)) {
      (out[party] = out[party] || []).push(frag);
    }
  }
  return out;
}

function parseState(st, html) {
  const text = toText(html);

  // Primary date + whether it has happened
  const dateMatch = text.match(/([A-Z][a-z]{2}\s+\d{1,2}\s+2026)\s+(Completed|\d+\s+days? away)/);
  const primaryDate = dateMatch ? dateMatch[1] : null;
  const completed = dateMatch ? /Completed/i.test(dateMatch[2]) : null;

  // Split on district headers like "AZ-02 District 2"
  const districtRe = new RegExp(`\\b(${st}-(?:\\d{2}|AL))\\b\\s+District`, "g");
  const marks = [];
  let m;
  while ((m = districtRe.exec(text)) !== null) marks.push({ code: m[1], at: m.index });

  const seats = {};
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    const slice = text.slice(mark.at, end);
    const winners = parseWinners(slice);
    if (winners.length) seats[mark.code] = winners;
  });

  // Senate seats are not districts - they live under their own heading.
  const senNom = parseNomineeSection(text, "U.S. Senate");
  const senate = [];
  ["D", "R"].forEach((p) => (senNom[p] || []).forEach((n) => senate.push(n)));

  return { primaryDate, completed, seats, districtsSeen: marks.length, senate };
}

async function main() {
  const inbox = {
    _help:
      "Auto-fetched nominee candidates awaiting human review. Move verified entries into api/nominees.json. Surname fragments are fuzzy on purpose - check that each one matches exactly one candidate in that seat's FEC field before promoting it.",
    _generated: new Date().toISOString(),
    _source: "https://pollingsource.com/primaries/<ST>",
    states: {},
    seats: {},
  };

  let live = {};
  try {
    live = JSON.parse(fs.readFileSync(LIVE_PATH, "utf8"));
  } catch {}

  let totalSeats = 0;
  let errors = 0;

  for (const st of STATES) {
    process.stdout.write(`${st} ... `);
    try {
      const res = await fetch(`https://pollingsource.com/primaries/${st}`, {
        headers: { "User-Agent": UA },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const { primaryDate, completed, seats, districtsSeen, senate } = parseState(st, html);
      if (senate && senate.length) {
        inbox.seats[`${st}-senate`] = {
          nominees: senate,
          primaryDate,
          completed,
          alreadyLive: Array.isArray(live[`${st}-senate`]) ? live[`${st}-senate`] : null,
          changed: JSON.stringify(live[`${st}-senate`] || null) !== JSON.stringify(senate),
        };
      }

      inbox.states[st] = { primaryDate, completed, districtsSeen, seatsParsed: Object.keys(seats).length };

      for (const [code, winners] of Object.entries(seats)) {
        const existing = live[code];
        inbox.seats[code] = {
          nominees: winners,
          primaryDate,
          completed,
          alreadyLive: Array.isArray(existing) ? existing : null,
          changed: Array.isArray(existing)
            ? JSON.stringify(existing) !== JSON.stringify(winners)
            : true,
        };
        totalSeats++;
      }
      console.log(
        `${Object.keys(seats).length}/${districtsSeen} seats` +
          (completed === false ? " (primary not held yet)" : "")
      );
    } catch (e) {
      errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // be a good citizen
  }

  fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });
  fs.writeFileSync(INBOX_PATH, JSON.stringify(inbox, null, 2));

  const changed = Object.entries(inbox.seats).filter(([, v]) => v.changed);
  console.log(`\nDone. ${totalSeats} seat(s) parsed, ${errors} state error(s).`);
  console.log(`${changed.length} seat(s) differ from api/nominees.json:`);
  changed.slice(0, 40).forEach(([code, v]) =>
    console.log(`   ${code}: ${v.nominees.join(", ")}${v.alreadyLive ? "   (was: " + v.alreadyLive.join(", ") + ")" : ""}`)
  );
  if (changed.length > 40) console.log(`   ...and ${changed.length - 40} more`);
  console.log(`\nReview api/nominees-inbox.json, then copy verified seats into api/nominees.json.`);
}

main();
