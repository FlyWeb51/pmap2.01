// GET /api/fcc-folder?callsign=KPHO   OR   ?url=<direct public files folder URL>
const { sendJson, sendError, handleOptions, getQuery } = require('./_util');

const FCC_SEARCH_BASE = 'https://publicfiles.fcc.gov/api/manager/search/facilities';

module.exports = async function handler(req, res) {
if (handleOptions(req, res)) return;

try {
const directUrl = getQuery(req, 'url');
const callsign = getQuery(req, 'callsign');

if (!directUrl && !callsign) {
return sendError(res, 400, 'Provide either callsign=<call sign> or url=<public files folder URL>');
}

let folderUrl = directUrl;

if (!folderUrl) {
const searchUrl = FCC_SEARCH_BASE + '?q=' + encodeURIComponent(callsign);
const searchResp = await fetch(searchUrl);
if (!searchResp.ok) {
return sendError(res, 502, 'FCC facility search failed (' + searchResp.status + ')');
}
const facilities = await searchResp.json();
const match = Array.isArray(facilities) ? facilities[0] : (facilities.results || [])[0];
if (!match || !match.folderUrl) {
return sendError(res, 404, 'No public files folder found for callsign ' + callsign);
}
folderUrl = match.folderUrl;
}

const pageResp = await fetch(folderUrl);
if (!pageResp.ok) {
return sendError(res, 502, 'Failed to load public files folder (' + pageResp.status + ')');
}
const html = await pageResp.text();

const linkRegex = /href="([^"]+)"/g;
const links = new Set();
let m;
while ((m = linkRegex.exec(html)) !== null) {
const href = m[1];
if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
links.add(href.startsWith('http') ? href : new URL(href, folderUrl).toString());
}
}

sendJson(res, 200, {
callsign: callsign || null,
folderUrl,
fileCount: links.size,
files: Array.from(links),
});
} catch (err) {
sendError(res, err.status || 500, err.message || 'Unexpected error');
}
};
