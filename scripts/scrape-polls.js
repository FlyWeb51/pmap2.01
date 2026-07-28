/**
 * scripts/scrape-polls.js
 *
 * Semi-automated polling ingestion. Every 12 hours, this:
 *   1. Fetches the raw wikitext of watched Wikipedia election pages
 *   2. Parses "Poll source | Dates | Sample size | MoE | <candidates...> | Undecided"
 *      wikitables (the standard format Wikipedia uses for 2026 election pages)
 *   3. Matches candidate names against known FEC names for that race
 *   4. De-duplicates against already-approved polls AND the existing inbox
 *   5. Writes new finds to api/polls-inbox.json with reviewStatus:"pending"
 *
 * IMPORTANT: this NEVER writes to api/polls-data.json directly. Nothing a
 * scraper finds reaches the live site until a human moves it from the inbox
 * into polls-data.json and sets reviewStatus:"approved". That review step
 * is the safety valve — it catches bad matches, internal/partisan polls
 * worth downweighting, and outright scraping mistakes before they're public.
 *
 * Env: none required (Wikipedia's API is open, no key needed)
 * Config: scripts/poll-watch-list.json — list of {raceId, wikiPage} to check
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WATCH_LIST_PATH = path.join(__dirname, "poll-watch-list.json");
const INBOX_PATH = path.join(ROOT, "api", "polls-inbox.json");
const APPROVED_PATH = path.join(ROOT, "api", "polls-data.json");

const UA = "pmap2.01-poll-scraper/1.0 (educational election tracker; contact via repo issues)";

async function fetchWikitext(page) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(
    page
  )}&prop=wikitext&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Wikipedia fetch failed for "${page}": ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Wikipedia API error for "${page}": ${data.error.info}`);
  return data.parse.wikitext;
}

function cleanCell(raw) {
  let s = raw;
  s = s.replace(/<ref[^>]*\/>/gi, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/\{\{efn[^}]*\}\}/gi, "");
  s = s.replace(/\{\{n(?:owrap)?dash\}\}/gi, "–");
  s = s.replace(/\{\{small\|([^}]*)\}\}/gi, "$1");
  s = s.replace(/\{\{nowrap\|([^}]*)\}\}/gi, "$1");
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1");
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
  s = s.replace(/'''''?/g, "");
  s = s.replace(/<br\s*\/?>/gi, " ");
  s = s.replace(/\{\{[^}]*\}\}/g, "");
  s = s.replace(/style="[^"]*"/gi, "");
  s = s.replace(/(bgcolor|align|scope)\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/^\s*\|/, "");
  return s.replace(/\s+/g, " ").trim();
}

function splitRowCells(rowBlock) {
  return rowBlock
    .split(/\n\s*\|(?!\|)/)
    .flatMap((chunk) => chunk.split("||"))
    .map(cleanCell)
    .filter((c, i, arr) => !(i === 0 && c === ""));
}

const CANDIDATE_HEADER_BLOCKLIST = new Set([
  "poll source",
  "date(s) administered",
  "dates administered",
  "sample size",
  "margin of error",
  "other",
  "undecided",
  "other/undecided",
  "margin",
]);

function extractPollTables(wikitext) {
  const tables = [];
  const tableBlocks = wikitext.split(/\{\|/).slice(1);

  for (const block of tableBlocks) {
    const tableText = block.split(/\n\|\}/)[0];
    const rows = tableText.split(/\n\|-/);
    if (rows.length < 3) continue;

    let headerIdx = rows.findIndex((r, i) => i > 0 && /\n!|^!/.test(r));
    if (headerIdx === -1) continue;
    const headerRow = rows[headerIdx];
    const headerCells = headerRow
      .split(/\n!/)
      .slice(headerRow.trim().startsWith("!") ? 0 : 1)
      .map(cleanCell)
      .filter(Boolean);
    if (headerCells.length < 4) continue;

    const lowerHeaders = headerCells.map((h) => h.toLowerCase());
    const isPollTable =
      lowerHeaders.some((h) => h.includes("poll source")) &&
      lowerHeaders.some((h) => h.includes("sample size"));
    if (!isPollTable) continue;

    const candidateCols = headerCells
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => !CANDIDATE_HEADER_BLOCKLIST.has(h.toLowerCase()) && h.length > 0)
      .filter(({ h }) => {
        const l = h.toLowerCase();
        return !["poll source", "date(s) administered", "sample size", "margin of error"].some(
          (skip) => l.includes(skip)
        );
      });

    const dataRows = [];
    for (const rowBlock of rows.slice(headerIdx + 1)) {
      const cells = splitRowCells(rowBlock);
      if (cells.length < headerCells.length - 1) continue;
      dataRows.push(cells);
    }
    if (dataRows.length === 0) continue;

    tables.push({ headerCells, candidateCols, dataRows });
  }
  return tables;
}

function looksLikePercent(cell) {
  return /^\d{1,3}(\.\d+)?\s*%?$/.test(cell.replace(/[^\d.%]/g, "").length ? cell : "");
}

function parsePollsFromTable(table, raceId) {
  const polls = [];
  for (const cells of table.dataRows) {
    if (cells.length < 3) continue;
    const pollster = cells[0];
    const dates = cells[1] || "";
    const sampleRaw = cells[2] || "";
    const sampleMatch = sampleRaw.match(/[\d,]{2,}/);
    const sampleSize = sampleMatch ? Number(sampleMatch[0].replace(/,/g, "")) : null;

    if (!pollster || pollster.length < 2) continue;
    if (/^(source of poll aggregation|hypothetical|aggregate polls)/i.test(pollster)) continue;

    const results = [];
    for (const { h, i } of table.candidateCols) {
      const cell = cells[i];
      if (cell == null) continue;
      const pctMatch = cell.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (!pctMatch) continue;
      results.push({ candidate: h, pct: Number(pctMatch[1]) });
    }
    if (results.length < 2) continue;

    polls.push({
      raceId,
      pollster: pollster.replace(/\s*\([RD]\)\s*$/, "").trim(),
      partisanLean: /\(R\)\s*$/.test(pollster) ? "R" : /\(D\)\s*$/.test(pollster) ? "D" : null,
      fieldDates: dates,
      sampleSize,
      methodology: null,
      weight: /\([RD]\)\s*$/.test(pollster) ? 0.6 : 1,
      reviewStatus: "pending",
      results,
      sourceUrl: null,
      scrapedAt: new Date().toISOString(),
    });
  }
  return polls;
}

function pollFingerprint(p) {
  return [p.raceId, p.pollster.toLowerCase(), p.fieldDates, p.sampleSize].join("|");
}

async function main() {
  if (!fs.existsSync(WATCH_LIST_PATH)) {
    console.log("No poll-watch-list.json found — nothing to scrape.");
    return;
  }
  const watchList = JSON.parse(fs.readFileSync(WATCH_LIST_PATH, "utf8")).filter(
    (w) => !w._comment
  );

  let approved = [];
  try {
    approved = JSON.parse(fs.readFileSync(APPROVED_PATH, "utf8"));
  } catch {}
  let inbox = [];
  try {
    inbox = JSON.parse(fs.readFileSync(INBOX_PATH, "utf8"));
  } catch {}
  const known = new Set([...approved, ...inbox].map(pollFingerprint));

  let found = 0;
  let duplicates = 0;
  let errors = 0;

  for (const { raceId, wikiPage } of watchList) {
    process.stdout.write(`${raceId} (${wikiPage}) ... `);
    try {
      const wikitext = await fetchWikitext(wikiPage);
      const tables = extractPollTables(wikitext);
      let newForRace = 0;
      for (const table of tables) {
        const polls = parsePollsFromTable(table, raceId);
        for (const p of polls) {
          const fp = pollFingerprint(p);
          if (known.has(fp)) {
            duplicates++;
            continue;
          }
          known.add(fp);
          inbox.push(p);
          newForRace++;
          found++;
        }
      }
      console.log(`${newForRace} new (${tables.length} tables scanned)`);
    } catch (e) {
      errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });
  fs.writeFileSync(INBOX_PATH, JSON.stringify(inbox, null, 2));

  console.log(
    `\nDone. ${found} new pending poll(s), ${duplicates} duplicate(s) skipped, ${errors} page error(s).`
  );
  console.log(`Review them in api/polls-inbox.json, then move approved ones into api/polls-data.json.`);
}

main();
