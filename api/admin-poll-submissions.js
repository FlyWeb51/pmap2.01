// POST /api/admin-poll-submissions   (Authorization: Bearer <POLL_INGEST_TOKEN>)
const { sendJson, sendError, handleOptions, requireEnv } = require('./_util');

const REQUIRED_FIELDS = ['raceId', 'pollster', 'fieldDates', 'sampleSize', 'results'];

function validatePoll(body) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      errors.push('Missing required field: ' + field);
    }
  }
  if (body.raceId && !/^[A-Z]{2}-[A-Z]-\d{2}-\d{4}$/.test(body.raceId)) {
    errors.push('raceId must match format like AZ-H-01-2026');
  }
  if (body.results && !Array.isArray(body.results)) {
    errors.push('results must be an array of { candidate, pct }');
  }
  return errors;
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;

  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed, use POST');
  }

  try {
    const token = requireEnv('POLL_INGEST_TOKEN');
    const authHeader = req.headers.authorization || '';
    const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!provided || provided !== token) {
    return sendError(res, 401, 'Unauthorized: invalid or missing bearer token');
  }

  const body = req.body || {};
    const errors = validatePoll(body);
    if (errors.length > 0) {
      return sendError(res, 422, 'Validation failed', { errors });
    }

  const record = Object.assign({}, body, {
    reviewStatus: body.reviewStatus === 'approved' ? 'approved' : 'pending',
    receivedAt: new Date().toISOString(),
  });

  sendJson(res, 200, {
    status: 'validated',
    note: 'Record validated but not persisted \u2014 connect a database (Supabase/Neon/Vercel Postgres) to store submissions.',
    record,
  });
  } catch (err) {
    sendError(res, err.status || 500, err.message || 'Unexpected error');
  }
};
