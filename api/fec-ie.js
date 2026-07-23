// GET /api/fec-ie?candidate_id=<id>&cycle=2026
const {
FEC_BASE,
sendJson,
sendError,
handleOptions,
fetchJson,
requireEnv,
getQuery,
} = require('./_util');

module.exports = async function handler(req, res) {
if (handleOptions(req, res)) return;

try {
const apiKey = requireEnv('FEC_API_KEY');
const candidateId = getQuery(req, 'candidate_id');
const cycle = getQuery(req, 'cycle', String(new Date().getFullYear()));

if (!candidateId) {
return sendError(res, 400, 'Missing required query param: candidate_id');
}

const params = new URLSearchParams({
api_key: apiKey,
candidate_id: candidateId,
cycle,
per_page: '50',
sort: '-expenditure_date',
});

const url = FEC_BASE + '/schedules/schedule_e/?' + params.toString();
const data = await fetchJson(url);

const expenditures = (data.results || []).map(function (e) {
return {
spender: e.committee ? e.committee.name : e.committee_name,
support_oppose: e.support_oppose_indicator,
amount: e.expenditure_amount,
date: e.expenditure_date,
description: e.expenditure_description,
};
});

const totalSupport = expenditures.filter(function (e) { return e.support_oppose === 'S'; }).reduce(function (sum, e) { return sum + (e.amount || 0); }, 0);
const totalOppose = expenditures.filter(function (e) { return e.support_oppose === 'O'; }).reduce(function (sum, e) { return sum + (e.amount || 0); }, 0);

sendJson(res, 200, {
candidate_id: candidateId,
cycle,
count: expenditures.length,
totals: { support: totalSupport, oppose: totalOppose },
expenditures,
});
} catch (err) {
sendError(res, err.status || 500, err.message || 'Unexpected error', { upstream: err.body });
}
};
