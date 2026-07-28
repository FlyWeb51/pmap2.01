const FEC_API_KEY = process.env.FEC_API_KEY;
const ELECTION_YEAR = process.env.ELECTION_YEAR || "2026";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fecGet(path, params, attempt = 0) {
    if (!FEC_API_KEY) throw new Error("Missing FEC_API_KEY env var");
    const url = new URL(`https://api.open.fec.gov/v1/${path}`);
    url.searchParams.set("api_key", FEC_API_KEY);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url);
    if (res.status === 429 && attempt < 3) {
          const waitMs = 20000 * (attempt + 1);
          process.stdout.write(`[429, waiting ${waitMs / 1000}s] `);
          await sleep(waitMs);
          return fecGet(path, params, attempt + 1);
    }
    if (!res.ok) throw new Error(`FEC ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
}

// Full race lookup using candidates/totals — ONE call per seat returns
// every filed candidate WITH financial totals. Replaces the old
// search-then-N-totals pattern that burned through the rate limit.
async function fetchRace(state, district) {
    const isSenate = String(district).toLowerCase() === "senate";
    const office = isSenate ? "S" : "H";

  const params = {
        state,
        office,
        election_year: ELECTION_YEAR,
        cycle: ELECTION_YEAR,
        election_full: "true",
        per_page: "100",
  };
    if (!isSenate) params.district = String(district).padStart(2, "0");

  let data = await fecGet("candidates/totals/", params);
    let results = data.results || [];

  if (!isSenate && results.length === 0 && params.district === "01") {
        data = await fecGet("candidates/totals/", { ...params, district: "00" });
        results = data.results || [];
  }

  const candidates = results.map((c) => ({
        candidate_id: c.candidate_id,
        name: c.name,
        party: c.party_full,
        incumbent_challenge: c.incumbent_challenge_full,
        status: c.candidate_status,
        raised: c.receipts ?? null,
        spent: c.disbursements ?? null,
        cash_on_hand: c.cash_on_hand_end_period ?? null,
        debt: c.debts_owed_by_committee ?? null,
        coverage_end_date: c.coverage_end_date ?? null,
  }));

  candidates.sort((a, b) => (b.raised ?? -1) - (a.raised ?? -1));

  return {
        race: isSenate ? `${state} — Senate` : `${state}-${params.district}`,
        election_year: ELECTION_YEAR,
        candidate_count: candidates.length,
        candidates,
  };
}

module.exports = { fetchRace };
