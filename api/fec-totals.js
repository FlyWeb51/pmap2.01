// GET /api/fec-totals?cand=<candidate_id>  OR  ?q=<name>&office=H&state=AZ
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
const candidateId = getQuery(req, 'cand');
const query = getQuery(req, 'q');
const office = getQuery(req, 'office');
const state = getQuery(req, 'state');

let candidateIds = [];

if (candidateId) {
candidateIds = [candidateId];
} else if (query) {
const searchParams = new URLSearchParams({
api_key: apiKey,
q: query,
per_page: '20',
});
if (office) searchParams.set('office', office);
if (state) searchParams.set('state', state);

const searchUrl = FEC_BASE + '/candidates/search/?' + searchParams.toString();
const searchData = await fetchJson(searchUrl);
candidateIds = (searchData.results || []).slice(0, 20).map(function (c) { return c.candidate_id; });
} else {
return sendError(res, 400, 'Provide either cand=<candidate_id> or q=<name>');
}

const totals = [];
for (const id of candidateIds) {
const params = new URLSearchParams({ api_key: apiKey, per_page: '5', sort: '-cycle' });
const url = FEC_BASE + '/candidate/' + encodeURIComponent(id) + '/totals/?' + params.toString();
try {
const data = await fetchJson(url);
totals.push({ candidate_id: id, cycles: data.results || [] });
} catch (innerErr) {
totals.push({ candidate_id: id, error: innerErr.message });
}
}

sendJson(res, 200, { count: totals.length, totals });
} catch (err) {
sendError(res, err.status || 500, err.message || 'Unexpected error', { upstream: err.body });
}
};
