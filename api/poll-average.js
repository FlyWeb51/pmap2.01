// GET /api/poll-average?race_id=AZ-H-01-2026
const fs = require('fs');
const path = require('path');
const { sendJson, sendError, handleOptions, getQuery } = require('./_util');

function loadPolls() {
const dataPath = path.join(__dirname, 'polls-data.json');
const raw = fs.readFileSync(dataPath, 'utf8');
return JSON.parse(raw);
}

module.exports = async function handler(req, res) {
if (handleOptions(req, res)) return;

try {
const raceId = getQuery(req, 'race_id');
if (!raceId) {
return sendError(res, 400, 'Missing required query param: race_id');
}

const all = loadPolls();
const polls = all.filter(function (p) { return p.reviewStatus === 'approved' && p.raceId === raceId; });

if (polls.length === 0) {
return sendJson(res, 200, { raceId, count: 0, average: null, candidates: {} });
}

const totals = {};
let weightSum = 0;

for (const poll of polls) {
const weight = poll.weight || poll.sampleSize || 1;
weightSum += weight;
for (const result of poll.results || []) {
const key = result.candidate;
totals[key] = (totals[key] || 0) + result.pct * weight;
}
}

const averaged = {};
Object.keys(totals).forEach(function (key) {
averaged[key] = Math.round((totals[key] / weightSum) * 10) / 10;
});

sendJson(res, 200, {
raceId,
count: polls.length,
weightBasis: weightSum,
average: averaged,
});
} catch (err) {
sendError(res, err.status || 500, err.message || 'Unexpected error');
}
};
