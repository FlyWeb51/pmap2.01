const FEC_API_KEY = process.env.FEC_API_KEY;
const ELECTION_YEAR = process.env.ELECTION_YEAR || "2026";

async function fecGet(path, params) {
  if (!FEC_API_KEY) throw new Error("Missing FEC_API_KEY env var");
  const url = new URL(`https://api.open.fec.gov/v1/${path}`);
  url.searchParams.set("api_key", FEC_API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FEC ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Full race lookup: every filed candidate for a state + district
 * (or "senate"), with their committee money totals.
 */
async function fetchRace(state, district) {
  const isSenate = String(district).toLowerCase() === "senate";
  const office = isSenate ? "S" : "H";

  const params = {
    state,
    office,
    election_year: ELECTION_YEAR,
    per_page: "100",
  };
  if (!isSenate) params.district = String(district).padStart(2, "0");

  let search = await fecGet("candidates/search/", params);
  let candidates = search.results || [];

  // At-large fallback: some FEC records use "00" instead of "01"
  if (!isSenate && candidates.length === 0 && params.district === "01") {
    const retryParams = { ...params, district: "00" };
    search = await fecGet("candidates/search/", retryParams);
    candidates = search.results || [];
  }

  const withTotals = await Promise.all(
    candidates.map(async (c) => {
      let totals = null;
      try {
        const t = await fecGet(`candidate/${c.candidate_id}/totals/`, {
          cycle: ELECTION_YEAR,
        });
        totals = t.results?.[0] || null;
      } catch (e) {
        totals = { error: e.message };
      }
      return {
        candidate_id: c.candidate_id,
        name: c.name,
        party: c.party_full,
        incumbent_challenge: c.incumbent_challenge_full,
        status: c.candidate_status,
        raised: totals?.receipts ?? null,
        spent: totals?.disbursements ?? null,
        cash_on_hand: totals?.cash_on_hand_end_period ?? null,
        debt: totals?.debts_owed_by_committee ?? null,
        coverage_end_date: totals?.coverage_end_date ?? null,
      };
    })
  );

  withTotals.sort((a, b) => (b.raised ?? -1) - (a.raised ?? -1));

  return {
    race: isSenate ? `${state} — Senate` : `${state}-${params.district}`,
    election_year: ELECTION_YEAR,
    candidate_count: withTotals.length,
    candidates: withTotals,
  };
}

module.exports = { fetchRace };
