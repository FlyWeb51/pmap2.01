/**
 * scripts/extract-crosstabs.js
 *
 * Results by group (White, Black, Hispanic, men, women, age, college, party)
 * for new polls. For each recent poll with a source link, fetches the release
 * (web page or PDF), sends it to Claude, and saves the group numbers.
 *
 * Safety checks before anything is saved:
 *  - the model must report the poll's topline for this race, and it has to
 *    match the topline we already have within 2 points (wrong race or wrong
 *    question = rejected);
 *  - every group needs plausible numbers (0-100, D + R no more than 101).
 *
 * Writes:
 *   data/crosstabs/<raceId>.json  { raceId, polls: [ { pollster, end, pop, n, url, dName, rName, groups: [ {cat, group, d, r, n} ], model, at } ] }
 *   data/crosstabs/_seen.json     which polls were already tried (so each one costs once)
 *
 * Needs ANTHROPIC_API_KEY (GitHub secret). Without it, does nothing.
 * Env: CROSSTAB_MODEL (default claude-haiku-5-5), CROSSTAB_MAX (polls per run, default 40),
 *      CROSSTAB_DAYS (how far back to look, default 75).
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const POLLS = path.join(ROOT, "data", "polls");
const OUT = path.join(ROOT, "data", "crosstabs");
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CROSSTAB_MODEL || "claude-haiku-5-5";
const MAX = +(process.env.CROSSTAB_MAX || 40);
const DAYS = +(process.env.CROSSTAB_DAYS || 75);
const UA = "Mozilla/5.0 (compatible; pmap2.01-election-tracker/1.0; +https://github.com/FlyWeb51/pmap2.01)";

const CATS = ["race", "sex", "age", "education", "party", "ideology", "area", "other"];
const STATE = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };

const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const keyOf = (raceId, p) => `${raceId}|${p.pollster}|${p.endDate}|${p.population || ""}`;
const num = (v) => (v == null || v === "" || !isFinite(+v) ? null : +v);

function raceLabel(raceId) {
  const [st, t, d] = raceId.split("-");
  if (raceId === "generic-ballot") return "the national generic congressional ballot (Democrat vs Republican for the U.S. House)";
  const name = STATE[st] || st;
  return t === "S" ? `the ${name} U.S. Senate race` : t === "G" ? `the ${name} governor race` : t === "H" ? `${name}'s ${+d === 0 ? "at-large" : `${+d}${["th", "st", "nd", "rd"][(+d % 100 > 10 && +d % 100 < 14) || +d % 10 > 3 ? 0 : +d % 10]}`} congressional district race` : raceId;
}

/* ---------- fetching the release ---------- */
async function fetchSource(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/pdf,*/*" }, redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const type = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (type.includes("pdf") || buf.slice(0, 4).toString() === "%PDF") return { kind: "pdf", data: buf };
  const html = buf.toString("utf8");
  return { kind: "html", html, url: r.url || url };
}
function htmlToText(html) {
  const { DOMParser } = require("linkedom");
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, svg, nav, footer, header, iframe").forEach((n) => n.remove());
  // keep tables readable: cells separated by " | ", rows by new lines
  doc.querySelectorAll("tr").forEach((tr) => { const cells = [...tr.children].map((c) => c.textContent.replace(/\s+/g, " ").trim()); tr.textContent = "\n" + cells.join(" | ") + "\n"; });
  const t = (doc.body ? doc.body.textContent : doc.textContent || "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return t;
}
// a crosstab PDF linked from the release page, if there is one
function crosstabPdfLink(html, base) {
  const re = /<a[^>]+href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m, best = null;
  while ((m = re.exec(html))) {
    const href = m[1], text = m[2].replace(/<[^>]+>/g, " ");
    const score = /cross ?tab|crosstab|tabs|tabulation/i.test(href + " " + text) ? 2 : /topline|results|full|methodology|poll/i.test(href + " " + text) ? 1 : 0;
    if (score && (!best || score > best.score)) { try { best = { url: new URL(href, base).href, score }; } catch {} }
  }
  return best && best.url;
}

/* ---------- the model call ---------- */
const TOOL = {
  name: "record_crosstabs",
  description: "Record this poll's results by demographic group for the one race asked about.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "true only if the document shows results for this race broken out by at least two demographic groups" },
      topline_dem: { type: "number", description: "overall % for the Democratic (or independent, if no Democrat) candidate in this race's head-to-head, all respondents in the main sample" },
      topline_rep: { type: "number", description: "overall % for the Republican candidate in the same question" },
      dem_candidate: { type: "string" }, rep_candidate: { type: "string" },
      population: { type: "string", description: "LV, RV or A for the sample these crosstabs use" },
      groups: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: CATS },
            group: { type: "string", description: "Use these names when they apply: White, Black, Hispanic, Asian; Men, Women; age bands written like 18-29, 30-44, 45-64, 65+ exactly as the pollster's bands; College degree, No college degree, White college, White no college; Democrats, Republicans, Independents; Liberal, Moderate, Conservative; Urban, Suburban, Rural. Otherwise the pollster's own label." },
            dem: { type: "number" }, rep: { type: "number" },
            n: { type: "number", description: "unweighted sample size for the group, if shown" },
          },
          required: ["category", "group", "dem", "rep"],
        },
      },
      note: { type: "string", description: "one short line if something is unusual (e.g. crosstabs are for a different sample)" },
    },
    required: ["found"],
  },
};
async function askClaude(source, race, poll, dName, rName) {
  const intro = `This is the public release for a poll by ${poll.pollster} (fieldwork ending ${poll.endDate}). Find the head-to-head question for ${race}` +
    (dName || rName ? ` (${[dName, rName].filter(Boolean).join(" vs ")})` : "") +
    `, and record its results by demographic group (crosstabs). Use the numbers exactly as printed, as percentages. Only the main head-to-head question for this one race; ignore other races and other questions. If the document has no group breakdown for this race, set found to false. Always report the overall topline you used.`;
  const content = source.kind === "pdf"
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: source.data.toString("base64") } }, { type: "text", text: intro }]
    : [{ type: "text", text: `${intro}\n\n--- RELEASE TEXT (${source.url}) ---\n${source.text}` }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name }, messages: [{ role: "user", content }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const use = (j.content || []).find((c) => c.type === "tool_use");
  return { out: use ? use.input : null, usage: j.usage || {} };
}

/* ---------- checks ---------- */
function validate(out, d, r) {
  if (!out || !out.found) return { ok: false, why: "no crosstabs for this race" };
  const td = num(out.topline_dem), tr = num(out.topline_rep);
  if (td == null || tr == null) return { ok: false, why: "no topline reported" };
  if (d != null && r != null && (Math.abs(td - d) > 2 || Math.abs(tr - r) > 2)) return { ok: false, why: `topline ${td}-${tr} doesn't match the poll's ${d}-${r}` };
  const groups = (out.groups || []).map((g) => ({ cat: CATS.includes(g.category) ? g.category : "other", group: String(g.group || "").trim().slice(0, 40), d: num(g.dem), r: num(g.rep), n: num(g.n) }))
    .filter((g) => g.group && g.d != null && g.r != null && g.d >= 0 && g.r >= 0 && g.d <= 100 && g.r <= 100 && g.d + g.r <= 101);
  const seen = new Set(), uniq = groups.filter((g) => { const k = g.cat + "|" + g.group.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  if (uniq.length < 2) return { ok: false, why: "fewer than two usable groups" };
  return { ok: true, groups: uniq };
}

/* ---------- main ---------- */
async function main() {
  if (!KEY) { console.log("crosstabs: no ANTHROPIC_API_KEY secret, skipping"); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const seenFile = path.join(OUT, "_seen.json"), seen = read(seenFile, {});
  const cutoff = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);
  const todo = [];
  for (const f of fs.readdirSync(POLLS)) {
    if (!f.endsWith(".json") || f === "index.json") continue;
    const d = read(path.join(POLLS, f), null); if (!d || !d.polls) continue;
    const raceId = d.raceId || f.replace(/\.json$/, "");
    for (const p of d.polls) {
      const url = p.sourceUrl;
      if (!url || !/^https?:/.test(url) || /(^|\.)(x|twitter)\.com\//.test(url) || (p.endDate || "") < cutoff || p.otherMatchup) continue;
      const k = keyOf(raceId, p), s = seen[k];
      if (s && (s.status !== "error" || (s.tries || 0) >= 2)) continue;
      todo.push({ raceId, p, k });
    }
  }
  todo.sort((a, b) => (a.p.endDate < b.p.endDate ? 1 : -1));
  const batch = todo.slice(0, MAX);
  console.log(`crosstabs: ${todo.length} polls not tried yet, doing ${batch.length} this run with ${MODEL}`);
  const pages = new Map();
  let saved = 0, none = 0, errors = 0, tokens = 0;
  for (const { raceId, p, k } of batch) {
    const D = (p.results || []).find((x) => x.party === "D") || (p.results || []).find((x) => x.party === "I");
    const R = (p.results || []).find((x) => x.party === "R");
    const dv = D ? num(D.pct ?? D.percentage) : null, rv = R ? num(R.pct ?? R.percentage) : null;
    const clean = (c) => (c ? String(c.candidate).replace(/\s*\([A-Z]+\)\s*$/, "").trim() : null);
    try {
      if (!pages.has(p.sourceUrl)) {
        let src = await fetchSource(p.sourceUrl);
        if (src.kind === "html") {
          const pdf = crosstabPdfLink(src.html, src.url);
          if (pdf) { try { const ps = await fetchSource(pdf); if (ps.kind === "pdf" && ps.data.length < 20e6) src = ps; } catch {} }
          if (src.kind === "html") src = { kind: "html", url: src.url, text: htmlToText(src.html).slice(0, 120000) };
        }
        if (src.kind === "pdf" && src.data.length > 20e6) throw new Error("PDF too large");
        pages.set(p.sourceUrl, src);
      }
      const src = pages.get(p.sourceUrl);
      if (src.kind === "html" && src.text.length < 300) { seen[k] = { status: "none", why: "page has no readable text (built by script?)", at: new Date().toISOString() }; none++; continue; }
      const { out, usage } = await askClaude(src, raceLabel(raceId), p, clean(D), clean(R));
      tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
      const v = validate(out, dv, rv);
      if (!v.ok) { seen[k] = { status: "none", why: v.why, at: new Date().toISOString() }; none++; console.log(`  ${raceId} ${p.pollster} ${p.endDate}: ${v.why}`); continue; }
      const file = path.join(OUT, `${raceId}.json`), cur = read(file, { raceId, polls: [] });
      cur.polls = cur.polls.filter((x) => !(x.pollster === p.pollster && x.end === p.endDate && (x.pop || "") === (p.population || "")));
      cur.polls.push({ pollster: p.pollster, end: p.endDate, pop: p.population || out.population || null, n: p.sampleSize || null, url: p.sourceUrl, partisan: p.partisan || null, dName: clean(D) || out.dem_candidate || null, rName: clean(R) || out.rep_candidate || null, topline: { d: dv, r: rv }, groups: v.groups, note: out.note || null, model: MODEL, at: new Date().toISOString() });
      cur.polls.sort((a, b) => (a.end < b.end ? 1 : -1));
      cur.updated = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(cur));
      seen[k] = { status: "ok", groups: v.groups.length, at: new Date().toISOString() }; saved++;
      console.log(`  ${raceId} ${p.pollster} ${p.endDate}: ${v.groups.length} groups`);
    } catch (e) {
      seen[k] = { status: "error", why: e.message.slice(0, 160), tries: ((seen[k] && seen[k].tries) || 0) + 1, at: new Date().toISOString() }; errors++;
      console.log(`  ${raceId} ${p.pollster} ${p.endDate}: ${e.message.slice(0, 160)}`);
    }
  }
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  // small index so pages know which races have crosstabs
  const index = {};
  for (const f of fs.readdirSync(OUT)) if (f.endsWith(".json") && !f.startsWith("_")) { const d = read(path.join(OUT, f), null); if (d && d.polls && d.polls.length) index[d.raceId] = d.polls.length; }
  fs.writeFileSync(path.join(OUT, "_index.json"), JSON.stringify({ updated: new Date().toISOString(), races: index }));
  console.log(`crosstabs: saved ${saved}, no usable crosstabs ${none}, errors ${errors}, about ${tokens.toLocaleString()} tokens`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { validate, raceLabel, htmlToText, crosstabPdfLink };
