// Shared helpers for the election-center serverless API functions.

const FEC_BASE = 'https://api.open.fec.gov/v1';
const CENSUS_BASE = 'https://api.census.gov/data';

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, status, data) {
    setCors(res);
    res.status(status).json(data);
}

function sendError(res, status, message, extra) {
    sendJson(res, status, Object.assign({ error: message }, extra || {}));
}

function handleOptions(req, res) {
    if (req.method === 'OPTIONS') {
          setCors(res);
          res.status(204).end();
          return true;
    }
    return false;
}

async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    const text = await resp.text();
    let body;
    try {
          body = text ? JSON.parse(text) : {};
    } catch (e) {
          body = { raw: text };
    }
    if (!resp.ok) {
          const err = new Error('Upstream request failed (' + resp.status + ')');
          err.status = resp.status;
          err.body = body;
          throw err;
    }
    return body;
}

function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
          const err = new Error('Missing required environment variable: ' + name);
          err.status = 500;
          throw err;
    }
    return value;
}

function getQuery(req, name, fallback) {
    const value = req.query ? req.query[name] : undefined;
    return value === undefined || value === '' ? fallback : value;
}

module.exports = {
    FEC_BASE,
    CENSUS_BASE,
    setCors,
    sendJson,
    sendError,
    handleOptions,
    fetchJson,
    requireEnv,
    getQuery,
};
