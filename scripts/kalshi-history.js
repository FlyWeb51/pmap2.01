/**
 * scripts/kalshi-history.js
 *
 * Appends the current Kalshi prices to a daily history file so the site can
 * show price moves (24h / 7d change) and price charts.
 *
 *   data/kalshi/history/YYYY-MM-DD.json   (UTC day)
 *   {
 *     "date": "2026-10-20",
 *     "t": [29341234, ...],          // unix minutes, one per snapshot
 *     "s": { "S:TX": [61.5, ...],    // Democratic (or field) chance, 0-100
 *            "H:PA-07": [...], "G:GA": [...], "N:house": [...], "N:senate": [...] }
 *   }
 *
 * One snapshot per hour at most, so a day file stays small (~40 KB).
 * Runs after scrape-kalshi.js in the Kalshi workflow.
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const K = path.join(ROOT, "data", "kalshi");
const OUT = path.join(K, "history");
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(K, f), "utf8")); } catch { return null; } };

// Same rule the site uses: Democratic share, or "everyone but the Republican"
// in independent-vs-Republican races (Nebraska).
function dShare(e) {
  if (!e) return null;
  const d = e.democrat, r = e.republican;
  const third = (e.thirdParty && r) || (d && r && d.pct + r.pct < 85);
  if (third) return r ? 100 - r.pct : null;
  if (d && d.share != null) return d.share;
  if (d && r) return (d.pct / (d.pct + r.pct)) * 100;
  if (d) return d.pct;
  if (r) return 100 - (r.share ?? r.pct);
  return null;
}
const ctl = (o) => { const x = o && (o.outcomes || []).find((y) => /democ/i.test(y.label)); return x ? x.pct : null; };

function snapshot() {
  const s = {};
  for (const [st, e] of Object.entries(read("all-senate.json") || {})) s[`S:${st}`] = dShare(e);
  for (const [k, e] of Object.entries(read("all-house.json") || {})) s[`H:${k}`] = dShare(e);
  for (const [st, e] of Object.entries(read("all-governor.json") || {})) s[`G:${st}`] = dShare(e);
  const nat = read("national.json") || {};
  s["N:house"] = ctl(nat.house);
  s["N:senate"] = ctl(nat.senate);
  for (const k of Object.keys(s)) s[k] = s[k] == null || !isFinite(s[k]) ? null : Math.round(s[k] * 10) / 10;
  return s;
}

function append(when, snap) {
  const day = when.toISOString().slice(0, 10);
  const file = path.join(OUT, `${day}.json`);
  let h = { date: day, t: [], s: {} };
  try { h = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const t = Math.floor(when.getTime() / 60000);
  if (h.t.length && t - h.t[h.t.length - 1] < 50) return false; // hourly
  const n = h.t.length;
  h.t.push(t);
  for (const k of new Set([...Object.keys(h.s), ...Object.keys(snap)])) {
    if (!h.s[k]) h.s[k] = new Array(n).fill(null);
    h.s[k].push(snap[k] ?? null);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(h));
  return true;
}

if (require.main === module) {
  const meta = read("meta.json");
  const when = meta && meta.updated_at ? new Date(meta.updated_at) : new Date();
  const ok = append(when, snapshot());
  // keep 45 days
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  if (fs.existsSync(OUT)) for (const f of fs.readdirSync(OUT)) if (f.slice(0, 10) < cutoff) fs.rmSync(path.join(OUT, f));
  console.log(ok ? `kalshi history: snapshot added for ${when.toISOString()}` : "kalshi history: last snapshot under an hour old, skipped");
}

module.exports = { snapshot, append, dShare };
