/**
 * scripts/patch-frontend.js
 * Idempotent frontend patch applied by the workflow:
 *  - api/featured.json support (manual "main field" per race, no badge)
 *  - always feature FEC-flagged incumbents
 *  - money threshold 15% -> 10%
 * Safe to run every time: exits cleanly once the patch is present.
 */
const fs = require("fs");
const path = require("path");
const p = path.join(__dirname, "..", "index.html");
let h = fs.readFileSync(p, "utf8");
if (h.includes("getFeatured")) { console.log("frontend already patched"); process.exit(0); }

const A1 = 'function candCard(c,isNom){';
const A2 = '  const nomSet = cands.filter(isNom);\n  if (nomSet.length) {\n    main = cands.filter(c => isNom(c));\n    rest = cands.filter(c => !isNom(c));\n  } else {';
const A3 = '    for (const c of cands) if (total > 0 && money(c) / total >= 0.15) featured.add(c);';
for (const [name, a] of [["A1", A1], ["A2", A2], ["A3", A3]]) {
  if (h.split(a).length !== 2) { console.error("anchor fail: " + name); process.exit(1); }
}

h = h.replace(A1, 'let FEATURED=null;\nasync function getFeatured(){\n  if(FEATURED) return FEATURED;\n  try{ const r=await fetch("api/featured.json",{cache:"no-store"}); FEATURED=r.ok?await r.json():{}; }\n  catch(e){ FEATURED={}; }\n  return FEATURED;\n}\n' + A1);

h = h.replace(A2, '  const feats = (await getFeatured())[raceKey] || [];\n  const isFeat = c => feats.some(n => c.name.toUpperCase().includes(String(n).toUpperCase()));\n  const nomSet = cands.filter(isNom);\n  if (nomSet.length) {\n    main = cands.filter(c => isNom(c));\n    rest = cands.filter(c => !isNom(c));\n  } else if (feats.length) {\n    main = cands.filter(c => isFeat(c) || c.incumbent_challenge === "Incumbent");\n    rest = cands.filter(c => !main.includes(c));\n  } else {');

h = h.replace(A3, '    for (const c of cands) if (total > 0 && money(c) / total >= 0.10) featured.add(c);\n    for (const c of cands) if (c.incumbent_challenge === "Incumbent") featured.add(c);');

fs.writeFileSync(p, h);
console.log("index.html patched: featured.json + incumbent rule + 10% threshold");
