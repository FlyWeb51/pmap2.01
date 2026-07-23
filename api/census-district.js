/ GET /api/census-district?state=AZ&cd=01
const { CENSUS_BASE, sendJson, sendError, handleOptions, fetchJson, getQuery } = require('./_util');

const STATE_FIPS = {
AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10',
FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20',
KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28',
MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36',
NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45',
SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54',
WI: '55', WY: '56', DC: '11', PR: '72',
};

const VARIABLES = {
B01003_001E: 'population',
B19013_001E: 'median_household_income',
B15003_022E: 'bachelors_degree_count',
B23025_005E: 'unemployed_count',
};

module.exports = async function handler(req, res) {
if (handleOptions(req, res)) return;

try {
const state = getQuery(req, 'state');
const cd = getQuery(req, 'cd');

if (!state || !cd) {
return sendError(res, 400, 'Missing required query params: state and cd');
}

const fips = STATE_FIPS[state.toUpperCase()];
if (!fips) {
return sendError(res, 400, 'Unknown state abbreviation: ' + state);
}

const apiKey = process.env.CENSUS_API_KEY;
const varList = Object.keys(VARIABLES).join(',');
const params = new URLSearchParams({
get: 'NAME,' + varList,
for: 'congressional district:' + String(cd).padStart(2, '0'),
in: 'state:' + fips,
});
if (apiKey) params.set('key', apiKey);

const url = CENSUS_BASE + '/2022/acs/acs5?' + params.toString();
const rows = await fetchJson(url);

const header = rows[0];
const values = rows[1];
const record = {};
header.forEach(function (col, i) {
const label = VARIABLES[col] || col;
record[label] = values[i];
});

sendJson(res, 200, { state, district: cd, data: record });
} catch (err) {
sendError(res, err.status || 500, err.message || 'Unexpected error', { upstream: err.body });
}
};
