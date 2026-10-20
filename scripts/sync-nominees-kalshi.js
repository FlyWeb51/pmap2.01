/**
 * scripts/sync-nominees-kalshi.js
 *
 * Runs right after promote-nominees.js (same manual workflow). Fills the gap
 * the primary-results scraper leaves: candidates who were unopposed in their
 * primary (mostly incumbents: Ciscomani, Kiggans, Kean...) never show up as a
 * "winner", so their seat ends up with only the challenger listed.
 *
 * Kalshi's market for each race names the Democratic and Republican
 * candidates. A name is added only when its last name matches an actual FEC
 * filer for that same seat, so a market label can never invent a candidate.
 * Serious independents are added from FEC fundraising (25% of the top
 * fundraiser). Nothing is ever removed; hand-verified seats (_verified) are left alone.
 *
 * Writes api/nominees.json and data/nominees.json, and records every addition
 * under _kalshiAdded so it can be reviewed.
 */

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const API_OUT = path.join(ROOT, "api", "nominees.json");
const DATA_OUT = path.join(ROOT, "data", "nominees.json");
const KALSHI = path.join(ROOT, "data", "kalshi");
const FEC = path.join(ROOT, "data", "fec");

const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const lastName = (n) => {
  const parts = fold(n).replace(/[’'.]/g, "").replace(/\s+(JR|SR|II|III|IV)$/, "").trim().split(/\s+/);
  return parts[parts.length - 1] || "";
};

function main() {
  const noms = read(API_OUT) || read(DATA_OUT) || {};
  const verified = new Set(Array.isArray(noms._verified) ? noms._verified : []);
  const added = [];

  for (const f of fs.readdirSync(KALSHI)) {
    let seat = f.replace(/\.json$/, "");
    if (/^(all-|meta|national)/.test(seat) || seat.endsWith("-governor")) continue;
    const k = read(path.join(KALSHI, f));
    if (!k) continue;
    // FEC files use XX-00 for at-large seats; Kalshi files use XX-01
    let fecSeat = seat;
    if (!fs.existsSync(path.join(FEC, `${seat}.json`)) && /-01$/.test(seat)) fecSeat = seat.replace(/-01$/, "-00");
    const fec = read(path.join(FEC, `${fecSeat}.json`));
    if (!fec || !fec.candidates) continue;
    const key = noms[fecSeat] ? fecSeat : noms[seat] ? seat : fecSeat;
    if (verified.has(key)) continue;

    for (const side of ["democrat", "republican"]) {
      const name = k[side] && k[side].candidate;
      if (!name || /party/i.test(name)) continue;
      const ln = lastName(name);
      if (ln.length < 2) continue;
      const party = side === "democrat" ? ["DEM", "DFL"] : ["REP"];
      const filer = fec.candidates.find((c) => party.includes(c.party) && fold(c.name).split(",")[0].replace(/[’'.]/g, "").split(/\s+/).includes(ln));
      if (!filer) continue;
      const frag = fold(filer.name).split(",")[0].trim();
      const list = noms[key] || [];
      if (list.some((x) => fold(x) === frag || frag.includes(fold(x)) || fold(x).includes(frag))) continue;
      noms[key] = [...list, frag];
      added.push(`${key}:${frag} (${name})`);
    }
  }

  // Serious independents (Dan Osborn in Nebraska) have no D/R market side.
  // In races Kalshi prices as a two-way that isn't D vs R, add the IND filer(s)
  // who raised at least 25% of the race's top fundraiser.
  for (const f of fs.readdirSync(FEC)) {
    const seat = f.replace(/\.json$/, "");
    if (verified.has(seat)) continue;
    // Only races where Kalshi's D and R sides leave real room for someone else
    const k = read(path.join(KALSHI, `${seat}.json`)) || read(path.join(KALSHI, seat.replace(/-00$/, "-01") + ".json"));
    const thirdParty = k && (k.thirdParty || (k.democrat && k.republican && k.democrat.pct + k.republican.pct < 85));
    if (!thirdParty) continue;
    const fec = read(path.join(FEC, f));
    const cands = (fec && fec.candidates) || [];
    const top = Math.max(0, ...cands.map((c) => Number((c.totals || {}).receipts) || 0));
    if (top < 250000) continue;
    for (const c of cands) {
      if (c.party !== "IND") continue;
      if ((Number((c.totals || {}).receipts) || 0) < top * 0.25) continue;
      const frag = fold(c.name).split(",")[0].trim();
      const list = noms[seat] || [];
      if (list.some((x) => fold(x) === frag)) continue;
      noms[seat] = [...list, frag];
      added.push(`${seat}:${frag} (independent, FEC receipts)`);
    }
  }

  noms._kalshiAdded = added;
  noms._kalshiSynced = new Date().toISOString();
  const json = JSON.stringify(noms, null, 2);
  fs.writeFileSync(API_OUT, json);
  fs.writeFileSync(DATA_OUT, json);
  console.log(`nominees: added ${added.length} candidate(s) confirmed by Kalshi + FEC`);
  added.forEach((a) => console.log("  + " + a));
}

main();
