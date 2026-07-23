// GET /api/polls?race_id=AZ-H-01-2026
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
const all = loadPolls();

let polls = all.filter(function (p) { return p.reviewStatus === 'approved'; });
if (raceId) {
polls = polls.filter(function (p) { return p.raceId === raceId; });
}

sendJson(res, 200, { raceId: raceId || null, count: polls.length, polls });
} catch (err) {
sendError(res, err.status || 500, err.message || 'Unexpected error');
}
};
