# Election Center — Master Guide build (v3)

Frontend + Vercel serverless backend for the 2026 election-study site.
FEC finance, Census ACS 2024 context, reviewed polls with a transparent
weighted average, and an FCC public-files crawler.

## Repository layout (exactly this)
index.html
package.json
README.md
api/
  _util.js  fec-race.js  fec-totals.js  fec-ie.js
  census-district.js  census-county.js  fcc-folder.js
  polls.js  poll-average.js  admin-poll-submissions.js  polls-data.json

## Environment variables (Vercel → Settings → Environment Variables)
FEC_API_KEY      from https://api.data.gov/signup/
CENSUS_API_KEY   from https://api.census.gov/data/key_signup.html
POLL_INGEST_TOKEN  any long random secret you make up
Redeploy after adding or changing any variable.

## Endpoints
/api/fec-race?state=AZ&district=01&office=H&cycle=2026
/api/fec-totals?cand=<id> or ?q=name&office=H&state=AZ
/api/fec-ie?candidate_id=<id>&cycle=2026
/api/census-district?state=AZ&cd=01
/api/census-county?state=AZ
/api/fcc-folder?callsign=KPHO  or ?url=<political-files folder URL>
/api/polls?race_id=AZ-H-01-2026
/api/poll-average?race_id=AZ-H-01-2026
POST /api/admin-poll-submissions  (Bearer POLL_INGEST_TOKEN)

## Poll schema (unified — one format everywhere)
See the example record in api/polls-data.json. reviewStatus must be
"approved" for a poll to appear publicly. raceId format: AZ-H-01-2026.
Add polls by editing api/polls-data.json on GitHub; Vercel redeploys.

## Notes
- fcc-folder uses the public HTML tree crawler, not the Manager JSON API,
  because Manager endpoints require an authenticated filer entityId.
- admin-poll-submissions validates and returns records but cannot persist
  them until a database (Supabase/Neon/Vercel Postgres) is connected.
- fec-race caps totals lookups at 20 candidates per race to protect the
  FEC rate limit and the serverless timeout.
