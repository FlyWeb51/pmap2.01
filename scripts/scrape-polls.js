/**
 * scripts/scrape-polls.js
 *
 * Multi-source polling ingestion, run every 12 hours by the workflow.
 * Single-file build (no lib/ subfolder) for simple manual deployment.
 *
 * Sources:
 *   - Wikipedia      (per-race wikitext tables; watch-list driven)
 *   - Ballotpedia    (same wikitext engine; generic ballot + approval)
 *   - PollingSource  (all 35 Senate races + ~100 competitive House races,
 *                      discovered live from their own hub pages)
 *   - Pollsmax       (per-race aggregate + latest-poll summary only)
 *
 * Schema: every poll carries sourceUrl (the ORIGINAL report, when the site
 * we scraped actually links to it -- null otherwise) and aggregatorUrl
 * (the page we found it on -- always present).
 *
 * Writes only to api/polls-inbox.json. Never touches api/polls-data.json.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WATCH_LIST_PATH = path.join(__dirname, "poll-watch-list.json");
const INBOX_PATH = path.join(ROOT, "api", "polls-inbox.json");
const APPROVED_PATH = path.join(ROOT, "api", "polls-data.json");

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const BALLOTPEDIA_API = "https://ballotpedia.org/wiki/api.php";

/* ==================== lib/html-table.js ==================== */
/**
 * scripts/lib/html-table.js
 *
 * Minimal, dependency-free HTML table extraction. GitHub Actions runners
 * are fine installing packages, but a regex-based extractor keeps this
 * scraper self-contained (no npm install step, nothing to break).
 *
 * Not a general HTML parser -- just enough to pull <table> structure,
 * per-cell text, and the first <a href> link in a cell (if any).
 */

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Returns { text, href } for a single <td>/<th> cell's inner HTML.
// href is the first external (non-relative) link found, or null.
function parseCell(innerHtml) {
  const linkMatch = innerHtml.match(/<a[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  const text = stripTags(innerHtml);
  if (!linkMatch) return { text, href: null };
  const href = linkMatch[1];
  // Only treat it as a real link if it looks absolute (http/https) --
  // relative links (e.g. "/pollsters/xyz") are the site's own internal
  // pages, not an original source, and callers decide what to do with those.
  return { text, href };
}

function extractRowCells(rowHtml, cellTag) {
  const re = new RegExp(`<${cellTag}[^>]*>([\\s\\S]*?)<\\/${cellTag}>`, "gi");
  const cells = [];
  let m;
  while ((m = re.exec(rowHtml))) cells.push(parseCell(m[1]));
  return cells;
}

/**
 * Extracts all <table>...</table> blocks and returns
 * [{ headerCells: [{text,href}], dataRows: [[{text,href},...], ...] }, ...]
 */
function extractHtmlTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const tableHtml = tm[1];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const rows = [];
    let rm;
    while ((rm = rowRe.exec(tableHtml))) rows.push(rm[1]);
    if (rows.length < 2) continue;

    let headerCells = extractRowCells(rows[0], "th");
    let dataStart = 1;
    if (headerCells.length === 0) {
      // Some tables use <td> even in the header row
      headerCells = extractRowCells(rows[0], "td");
    }
    if (headerCells.length === 0) continue;

    const dataRows = [];
    for (let i = dataStart; i < rows.length; i++) {
      const cells = extractRowCells(rows[i], "td");
      if (cells.length) dataRows.push(cells);
    }
    if (dataRows.length === 0) continue;

    tables.push({ headerCells, dataRows });
  }
  return tables;
}

/* ==================== lib/wikitext.js ==================== */
/**
 * scripts/lib/wikitext.js
 *
 * MediaWiki wikitext poll-table scraper. Generalized to work against any
 * MediaWiki site's api.php (Wikipedia, Ballotpedia -- same software, same
 * API shape), and fixed to CAPTURE citation/external-link URLs instead of
 * discarding them, so scraped polls can link to the original report
 * (a Rasmussen page, a YouGov PDF, etc.) rather than just the wiki page.
 */

const UA = "pmap2.01-poll-scraper/1.0 (educational election tracker; contact via repo issues)";

async function fetchWikitext(apiBaseUrl, page) {
  const url = `${apiBaseUrl}?action=parse&page=${encodeURIComponent(
    page
  )}&prop=wikitext&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Wikitext fetch failed for "${page}": ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Wiki API error for "${page}": ${data.error.info}`);
  return data.parse.wikitext;
}

// Extract the first external URL from a <ref>...</ref> block or a bare
// [URL text] external link, wherever it appears in the raw cell.
function extractCitationUrl(raw) {
  const refMatch = raw.match(/<ref[^>]*>([\s\S]*?)<\/ref>/i);
  if (refMatch) {
    const urlInRef = refMatch[1].match(/\[(https?:\/\/[^\s\]]+)/);
    if (urlInRef) return urlInRef[1];
  }
  // A bare external link not inside a ref, e.g. "[https://example.com/x.pdf Name]"
  const bareLink = raw.match(/\[(https?:\/\/[^\s\]]+)\s+[^\]]*\]/);
  if (bareLink) return bareLink[1];
  return null;
}

function cleanCellText(raw) {
  let s = raw;
  s = s.replace(/<ref[^>]*\/>/gi, "");
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  s = s.replace(/\{\{efn[^}]*\}\}/gi, "");
  s = s.replace(/\{\{n(?:owrap)?dash\}\}/gi, "\u2013");
  s = s.replace(/\{\{small\|([^}]*)\}\}/gi, "$1");
  s = s.replace(/\{\{nowrap\|([^}]*)\}\}/gi, "$1");
  s = s.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]*)\]/g, "$1"); // [url text] -> text
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

// A cell is now { text, href } to match the html-table.js shape.
function cleanCell(raw) {
  return { text: cleanCellText(raw), href: extractCitationUrl(raw) };
}

function splitRowCells(rowBlock) {
  return rowBlock
    .split(/\n\s*\|(?!\|)/)
    .flatMap((chunk) => chunk.split("||"))
    .map(cleanCell)
    .filter((c, i) => !(i === 0 && c.text === ""));
}

const CANDIDATE_HEADER_BLOCKLIST = new Set([
  "poll source", "source", "date(s) administered", "dates administered",
  "date range", "sample size", "margin of error", "moe", "other",
  "undecided", "other/undecided", "margin", "positive", "negative", "type",
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
      .filter((c) => c.text);
    if (headerCells.length < 4) continue;

    const lowerHeaders = headerCells.map((h) => h.text.toLowerCase());
    // Broadened match: accept "source" alone (Ballotpedia) as well as
    // "poll source" (Wikipedia's usual phrasing).
    const isPollTable =
      lowerHeaders.some((h) => h.includes("source")) &&
      lowerHeaders.some((h) => h.includes("sample"));
    if (!isPollTable) continue;

    const candidateCols = headerCells
      .map((h, i) => ({ h: h.text, i }))
      .filter(({ h }) => !CANDIDATE_HEADER_BLOCKLIST.has(h.toLowerCase()) && h.length > 0)
      .filter(({ h }) => {
        const l = h.toLowerCase();
        return !["source", "date", "sample size", "margin of error"].some((skip) =>
          l.includes(skip)
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

function parsePollsFromTable(table, raceId, pageUrl) {
  // Find columns by header text rather than assuming fixed positions --
  // some sites (Ballotpedia) prepend an extra "Type" column that would
  // otherwise shift everything by one.
  const headerTexts = table.headerCells.map((h) => h.text.toLowerCase());
  const sourceIdx = headerTexts.findIndex((h) => h.includes("source"));
  const dateIdx = headerTexts.findIndex((h) => h.includes("date"));
  const sampleIdx = headerTexts.findIndex((h) => h.includes("sample"));
  if (sourceIdx === -1) return [];

  const polls = [];
  for (const cells of table.dataRows) {
    if (cells.length <= sourceIdx) continue;
    const pollsterCell = cells[sourceIdx];
    const pollster = pollsterCell ? pollsterCell.text : "";
    const dates = dateIdx >= 0 && cells[dateIdx] ? cells[dateIdx].text : "";
    const sampleRaw = sampleIdx >= 0 && cells[sampleIdx] ? cells[sampleIdx].text : "";
    const sampleMatch = sampleRaw.match(/[\d,]{2,}/);
    const sampleSize = sampleMatch ? Number(sampleMatch[0].replace(/,/g, "")) : null;

    if (!pollster || pollster.length < 2) continue;
    if (/^(source of poll aggregation|hypothetical|aggregate polls)/i.test(pollster)) continue;

    const results = [];
    for (const { h, i } of table.candidateCols) {
      const cell = cells[i];
      if (!cell) continue;
      const pctMatch = cell.text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (!pctMatch) continue;
      results.push({ candidate: h, pct: Number(pctMatch[1]) });
    }
    if (results.length < 2) continue;

    const partisan = /\(R\)\s*$/.test(pollster) ? "R" : /\(D\)\s*$/.test(pollster) ? "D" : null;

    polls.push({
      raceId,
      pollster: pollster.replace(/\s*\([RD]\)\s*$/, "").trim(),
      partisanLean: partisan,
      fieldDates: dates,
      sampleSize,
      methodology: null,
      weight: partisan ? 0.6 : 1,
      reviewStatus: "pending",
      results,
      sourceUrl: pollsterCell.href || null, // the real fix: citation link, when present
      aggregatorUrl: pageUrl,
      scrapedAt: new Date().toISOString(),
    });
  }
  return polls;
}

function pollFingerprint(p) {
  return [p.raceId, p.pollster.toLowerCase(), p.fieldDates, p.sampleSize].join("|");
}

/* ==================== lib/source-pollingsource.js ==================== */
/**
 * scripts/lib/source-pollingsource.js
 *
 * PollingSource.com adapter. Two jobs:
 *   1. Discover the current race lists (all 35 Senate races, the ~100
 *      competitive House races PollingSource itself rates Toss-up..Likely)
 *      by reading their hub pages -- never hardcoded, so a new special
 *      election or a ratings change is picked up automatically.
 *   2. Parse the poll tables on the generic-ballot page and each race page.
 *
 * Honest limitation: PollingSource's pollster names only link to PollingSource's
 * *own* internal track-record pages (/pollsters/xyz), never to the original
 * poll report. So `sourceUrl` is always null here; we set `aggregatorUrl` to
 * the PollingSource race page instead, clearly distinct from a real original
 * source link (see schema in scrape-polls.js).
 */

const BASE = "https://pollingsource.com";

async function fetchHtml(path, attempt = 0) {
  const res = await fetch(BASE + path, { headers: { "User-Agent": UA } });
  if (res.status === 429 && attempt < 3) {
    const waitMs = 5000 * (attempt + 1);
    process.stdout.write(`[429, waiting ${waitMs / 1000}s] `);
    await new Promise((r) => setTimeout(r, waitMs));
    return fetchHtml(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`PollingSource fetch failed for "${path}": ${res.status}`);
  return res.text();
}

// Pull every /senate/XX link (2-letter state code) from the Senate hub page.
function discoverSenateStates(html) {
  const codes = new Set();
  const re = /\/senate\/([A-Z]{2})(?:["'\/?]|$)/g;
  let m;
  while ((m = re.exec(html))) codes.add(m[1]);
  return [...codes].sort();
}

// Pull every /house/ST-DD link from the House hub's "Competitive House Races" list.
function discoverCompetitiveHouseDistricts(html) {
  const codes = new Set();
  const re = /\/house\/([A-Z]{2}-\d{2})(?:["'\/?]|$)/g;
  let m;
  while ((m = re.exec(html))) codes.add(m[1]);
  return [...codes].sort();
}

// Extract candidate name + percent from a cell like "James Talarico 51.00%"
// or "Democrats 50.00%". Returns null if the cell doesn't match that shape
// (e.g. empty MoE cells, or a malformed row where the source itself left a
// literal "Dem %" placeholder -- skip those rather than guess).
function parseCandidatePct(cellText) {
  const m = cellText.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*%$/);
  if (!m) return null;
  const name = m[1].trim();
  if (/^(dem|rep)\s*$/i.test(name)) return null; // literal placeholder, not real data
  return { candidate: name, pct: Number(m[2]) };
}

function parsePollsterCell(cell) {
  // Strip "partisanÂ·D"/"partisanÂ·R" annotations and accuracy-rating suffixes.
  let text = cell.text.replace(/partisan[Â·:]?\s*[DR]\b/i, "").trim();
  text = text.replace(/Â±\d+(\.\d+)?\s*$/, "").trim();
  const partisanTag = cell.text.match(/partisan[Â·:]?\s*([DR])\b/i);

  // A joint pollster (e.g. "Beacon Research (D)/ Shaw & Co. Research (R)",
  // Fox News's real methodology) names BOTH a D-aligned and an R-aligned
  // firm working together -- that's balanced by design, not one-sided.
  // Only treat a trailing (D)/(R) as a partisan-lean signal when just one
  // tag appears; strip a *single* trailing tag either way for a clean name.
  const hasD = /\(D\)/.test(text);
  const hasR = /\(R\)/.test(text);
  const isJoint = hasD && hasR;
  const suffixTag = !isJoint ? text.match(/\s*\(([DR])\)\s*$/) : null;
  text = text.replace(/\s*\(([DR])\)\s*(?=\/|$)/g, "").trim();

  const partisanLean = isJoint ? null : partisanTag ? partisanTag[1].toUpperCase() : suffixTag ? suffixTag[1] : null;
  return { pollster: text, partisanLean };
}

/**
 * Parses a PollingSource poll table (same column shape for generic ballot,
 * Senate, and House pages: [State/District]?, Pollster, Date, Sample, MoE?, Dem, Rep).
 */
function parsePollTable(table, raceId) {
  const headers = table.headerCells.map((c) => c.text.toLowerCase());
  const pollsterIdx = headers.findIndex((h) => h.includes("pollster"));
  const dateIdx = headers.findIndex((h) => h === "date" || h.includes("date"));
  const sampleIdx = headers.findIndex((h) => h.includes("sample"));
  const demIdx = headers.findIndex((h) => h === "dem" || h.includes("democrat"));
  const repIdx = headers.findIndex((h) => h === "rep" || h.includes("republican"));
  if (pollsterIdx === -1 || dateIdx === -1 || demIdx === -1 || repIdx === -1) return [];

  const polls = [];
  for (const row of table.dataRows) {
    if (row.length <= Math.max(pollsterIdx, dateIdx, demIdx, repIdx)) continue;
    const { pollster, partisanLean } = parsePollsterCell(row[pollsterIdx]);
    if (!pollster) continue;
    const date = row[dateIdx].text.trim();
    const sampleRaw = sampleIdx >= 0 ? row[sampleIdx].text.trim() : "";
    const sampleMatch = sampleRaw.match(/[\d,]+/);
    const sampleSize = sampleMatch ? Number(sampleMatch[0].replace(/,/g, "")) : null;
    const popMatch = sampleRaw.match(/\b(LV|RV|A)\b/);

    const dem = parseCandidatePct(row[demIdx].text);
    const rep = parseCandidatePct(row[repIdx].text);
    if (!dem || !rep) continue; // skip malformed/placeholder rows rather than guess

    polls.push({
      raceId,
      pollster,
      partisanLean,
      fieldDates: date,
      sampleSize,
      population: popMatch ? popMatch[1] : null,
      weight: partisanLean ? 0.6 : 1,
      reviewStatus: "pending",
      results: [dem, rep],
      sourceUrl: null, // PollingSource never links the original report
      aggregatorUrl: `${BASE}/${raceId.includes("-") ? "house/" + raceId : "senate/" + raceId}`,
      scrapedAt: new Date().toISOString(),
    });
  }
  return polls;
}

async function psFetchGenericBallotPolls() {
  const html = await fetchHtml("/polls/generic-ballot");
  const tables = extractHtmlTables(html);
  const table = tables.find((t) =>
    t.headerCells.some((c) => c.text.toLowerCase().includes("pollster"))
  );
  if (!table) return [];
  const polls = parsePollTable(table, "generic-ballot");
  return polls.map((p) => ({ ...p, aggregatorUrl: `${BASE}/polls/generic-ballot` }));
}

async function psFetchSenateRacePolls(stateCode) {
  const html = await fetchHtml(`/senate/${stateCode}`);
  const tables = extractHtmlTables(html);
  const table = tables.find((t) =>
    t.headerCells.some((c) => c.text.toLowerCase().includes("pollster"))
  );
  if (!table) return [];
  return parsePollTable(table, stateCode);
}

async function psFetchHouseRacePolls(districtCode) {
  const html = await fetchHtml(`/house/${districtCode}`);
  const tables = extractHtmlTables(html);
  const table = tables.find((t) =>
    t.headerCells.some((c) => c.text.toLowerCase().includes("pollster"))
  );
  if (!table) return [];
  return parsePollTable(table, districtCode);
}

async function psDiscoverAllRaces() {
  const senateHtml = await fetchHtml("/senate");
  const houseHtml = await fetchHtml("/house.php");
  return {
    senateStates: discoverSenateStates(senateHtml),
    houseDistricts: discoverCompetitiveHouseDistricts(houseHtml),
  };
}

/* ==================== lib/source-pollsmax.js ==================== */
/**
 * scripts/lib/source-pollsmax.js
 *
 * Pollsmax.com adapter. Confirmed limitation (checked directly, not assumed):
 * their per-race pages give a polling AVERAGE plus the latest poll's
 * pollster name and date as plain text -- no link to the original report,
 * and no full poll-by-poll list (that lives behind client-side JS). So this
 * adapter contributes one summary "poll" per race representing their
 * latest, with sourceUrl always null and aggregatorUrl pointing at the
 * Pollsmax race page itself.
 */

const PM_BASE = "https://www.pollsmax.com";

async function pmFetchHtml(path, attempt = 0) {
  const res = await fetch(PM_BASE + path, { headers: { "User-Agent": UA } });
  if (res.status === 429 && attempt < 3) {
    const waitMs = 5000 * (attempt + 1);
    process.stdout.write(`[429, waiting ${waitMs / 1000}s] `);
    await new Promise((r) => setTimeout(r, waitMs));
    return pmFetchHtml(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`Pollsmax fetch failed for "${path}": ${res.status}`);
  return res.text();
}

function pmStripTags(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses the label/value block on a Pollsmax race page:
 *   Polling average
 *   44.7% D / 46.2% R
 *   ...
 *   Latest poll
 *   Fox News / Beacon Research â July 27, 2026
 */
function parseRacePage(html, raceId, raceUrl) {
  const text = pmStripTags(html);

  const avgMatch = text.match(
    /Polling average\s+([\d.]+)%\s*D\s*\/\s*([\d.]+)%\s*R/i
  );
  const latestMatch = text.match(/Latest poll\s+(.+?)\s*[\u2014-]\s*([A-Za-z]+ \d{1,2}, \d{4})/);

  if (!avgMatch && !latestMatch) return [];

  // We only produce one entry: it represents Pollsmax's own aggregate,
  // labeled as such, not a specific poll's raw topline -- because that's
  // genuinely all the free page gives us.
  const results = [];
  if (avgMatch) {
    results.push({ candidate: "Democrat (Pollsmax average)", pct: Number(avgMatch[1]) });
    results.push({ candidate: "Republican (Pollsmax average)", pct: Number(avgMatch[2]) });
  }
  if (!results.length) return [];

  return [
    {
      raceId,
      pollster: latestMatch ? `Pollsmax average (latest input: ${latestMatch[1].trim()})` : "Pollsmax average",
      partisanLean: null,
      fieldDates: latestMatch ? latestMatch[2] : null,
      sampleSize: null,
      weight: 1,
      reviewStatus: "pending",
      isAggregateOnly: true, // flag: this is a computed average, not a single poll's topline
      results,
      sourceUrl: null, // confirmed: Pollsmax doesn't link original reports on the free page
      aggregatorUrl: raceUrl,
      scrapedAt: new Date().toISOString(),
    },
  ];
}

async function pmFetchSenateRacePolls(stateSlug, stateCode) {
  const path = `/senate/${stateSlug}/`;
  const html = await pmFetchHtml(path);
  return parseRacePage(html, stateCode, PM_BASE + path);
}

/* ==================== orchestrator ==================== */
/**
 * scripts/scrape-polls.js
 *
 * Multi-source polling ingestion, run every 12 hours by the workflow.
 * Sources:
 *   - Wikipedia      (per-race wikitext tables; watch-list driven)
 *   - Ballotpedia     (same wikitext engine; generic ballot + approval)
 *   - PollingSource   (all 35 Senate races + ~100 competitive House races,
 *                       discovered live from their own hub pages -- not
 *                       hardcoded, so a new special election or a ratings
 *                       change is picked up automatically)
 *   - Pollsmax        (per-race aggregate + latest-poll summary only)
 *
 * Schema note: every poll now carries TWO url fields --
 *   sourceUrl      the ORIGINAL report (a pollster's own page/PDF), when
 *                  the site we scraped actually links to it. Null if not.
 *   aggregatorUrl  the page we found it on (a Wikipedia/Ballotpedia/
 *                  PollingSource/Pollsmax URL) -- always present, so
 *                  there's always something to click through to.
 *
 * Writes only to api/polls-inbox.json. Never touches api/polls-data.json --
 * that move (inbox -> approved) is a human decision, on purpose.
 */

async function scrapeWikitextSource(entry, known, inbox, counters) {
  const apiBase = entry.site === "ballotpedia" ? BALLOTPEDIA_API : WIKIPEDIA_API;
  const pageUrl =
    entry.site === "ballotpedia"
      ? `https://ballotpedia.org/${encodeURIComponent(entry.wikiPage.replace(/ /g, "_"))}`
      : `https://en.wikipedia.org/wiki/${encodeURIComponent(entry.wikiPage.replace(/ /g, "_"))}`;

  const raw = await fetchWikitext(apiBase, entry.wikiPage);
  const tables = extractPollTables(raw);
  let newCount = 0;
  for (const table of tables) {
    const polls = parsePollsFromTable(table, entry.raceId, pageUrl);
    for (const p of polls) {
      const fp = pollFingerprint(p);
      if (known.has(fp)) {
        counters.duplicates++;
        continue;
      }
      known.add(fp);
      inbox.push(p);
      newCount++;
      counters.found++;
    }
  }
  return { newCount, tableCount: tables.length };
}

function ingestPollList(polls, known, inbox, counters) {
  let newCount = 0;
  for (const p of polls) {
    const fp = pollFingerprint(p);
    if (known.has(fp)) {
      counters.duplicates++;
      continue;
    }
    known.add(fp);
    inbox.push(p);
    newCount++;
    counters.found++;
  }
  return newCount;
}

async function main() {
  let approved = [];
  try {
    approved = JSON.parse(fs.readFileSync(APPROVED_PATH, "utf8"));
  } catch {
    /* fine if it doesn't exist yet */
  }
  let inbox = [];
  try {
    inbox = JSON.parse(fs.readFileSync(INBOX_PATH, "utf8"));
  } catch {
    /* starts empty */
  }
  const known = new Set([...approved, ...inbox].map(pollFingerprint));
  const counters = { found: 0, duplicates: 0, errors: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 1. Wikipedia + Ballotpedia (watch-list driven) ----
  let watchList = [];
  try {
    watchList = JSON.parse(fs.readFileSync(WATCH_LIST_PATH, "utf8")).filter((w) => !w._comment);
  } catch {
    console.log("No poll-watch-list.json found -- skipping wikitext sources.");
  }
  for (const entry of watchList) {
    process.stdout.write(`[wikitext:${entry.site || "wikipedia"}] ${entry.raceId} (${entry.wikiPage}) ... `);
    try {
      const { newCount, tableCount } = await scrapeWikitextSource(entry, known, inbox, counters);
      console.log(`${newCount} new (${tableCount} tables scanned)`);
    } catch (e) {
      counters.errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await sleep(1000);
  }

  // ---- 2. PollingSource: generic ballot ----
  process.stdout.write("[pollingsource] generic-ballot ... ");
  try {
    const polls = await psFetchGenericBallotPolls();
    const n = ingestPollList(polls, known, inbox, counters);
    console.log(`${n} new (${polls.length} parsed)`);
  } catch (e) {
    counters.errors++;
    console.log(`ERROR: ${e.message}`);
  }
  await sleep(1000);

  // ---- 3. PollingSource: discover + scrape all Senate races ----
  let senateStates = [];
  let houseDistricts = [];
  try {
    const discovered = await psDiscoverAllRaces();
    senateStates = discovered.senateStates;
    houseDistricts = discovered.houseDistricts;
    console.log(
      `[pollingsource] discovered ${senateStates.length} Senate races, ${houseDistricts.length} competitive House races`
    );
  } catch (e) {
    counters.errors++;
    console.log(`[pollingsource] race discovery ERROR: ${e.message}`);
  }

  for (const state of senateStates) {
    process.stdout.write(`[pollingsource:senate] ${state} ... `);
    try {
      const polls = await psFetchSenateRacePolls(state);
      const n = ingestPollList(polls, known, inbox, counters);
      console.log(`${n} new (${polls.length} parsed)`);
    } catch (e) {
      counters.errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await sleep(800);
  }

  for (const district of houseDistricts) {
    process.stdout.write(`[pollingsource:house] ${district} ... `);
    try {
      const polls = await psFetchHouseRacePolls(district);
      const n = ingestPollList(polls, known, inbox, counters);
      console.log(`${n} new (${polls.length} parsed)`);
    } catch (e) {
      counters.errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await sleep(800);
  }

  // ---- 4. Pollsmax: per-state Senate pages ----
  const pollsmaxSenateStates = [
    ["alaska", "AK"], ["georgia", "GA"], ["iowa", "IA"], ["maine", "ME"],
    ["michigan", "MI"], ["nebraska", "NE"], ["new-hampshire", "NH"],
    ["north-carolina", "NC"], ["ohio", "OH"], ["texas", "TX"],
  ];
  for (const [slug, code] of pollsmaxSenateStates) {
    process.stdout.write(`[pollsmax:senate] ${code} ... `);
    try {
      const polls = await pmFetchSenateRacePolls(slug, code);
      const n = ingestPollList(polls, known, inbox, counters);
      console.log(`${n} new (${polls.length} parsed)`);
    } catch (e) {
      counters.errors++;
      console.log(`ERROR: ${e.message}`);
    }
    await sleep(800);
  }

  // ---- Write results ----
  fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true });
  fs.writeFileSync(INBOX_PATH, JSON.stringify(inbox, null, 2));

  console.log(
    `\nDone. ${counters.found} new pending poll(s), ${counters.duplicates} duplicate(s) skipped, ${counters.errors} error(s).`
  );
  console.log(`Review them in api/polls-inbox.json, then move approved ones into api/polls-data.json.`);
}

main().catch((e) => {
  // Belt-and-suspenders: nothing in this script should ever fail the whole
  // workflow run. Log clearly and exit 0 so data-build + commit still happen.
  console.error("Poll scraper failed unexpectedly:", e.message);
  console.error(e.stack);
});
