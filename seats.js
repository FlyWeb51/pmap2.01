# Election Data Backend

Serves live FEC campaign finance + Census district demographics for
**every** House seat (435) and Senate race (50 states), with disk
caching so each seat is only fetched once until it's actually stale.

## Setup

```bash
npm install
export FEC_API_KEY="your_fec_key"
export CENSUS_API_KEY="your_census_key"
```

## Step 1 — Prewarm the cache (run once, then on a schedule)

```bash
npm run prewarm
```

This walks all 435 House districts + 50 Senate races, one seat at a
time, with a 1.2s delay between seats by default (tune with
`RATE_DELAY_MS`). On a real (non-DEMO) FEC key this comfortably fits
within an hour. Re-running it later only re-fetches seats whose cache
has expired (3 days for money, 180 days for demographics) — everything
else is served instantly from disk.

## Step 2 — Run the server

```bash
npm start
```

Then your frontend calls:

- `GET /api/race/CA/12` — full race, every filed candidate + money, cached
- `GET /api/race/TX/senate` — Senate race
- `GET /api/district/CA/12` — population, income, education, age, poverty, homeownership
- `GET /api/seats` — every seat with cache status (useful for a "data freshness" admin view)
- `POST /api/race/CA/12/refresh` — force a fresh pull, bypassing cache

## Notes

- At-large states (VT, WY, ND, SD, DE, AK) are tried as district `01`
  first, then `00` automatically if the first attempt is empty — FEC
  and Census aren't always consistent about which code they use.
- Senate seats not on the 2026 ballot will correctly return an empty
  candidate list — no hardcoded "who's up this cycle" data needed,
  since FEC's own `election_year` filter handles it.
- Swap the cron/scheduling mechanism of your choice (crontab, a cloud
  scheduler, etc.) to run `npm run prewarm` nightly so new filings show
  up without you touching anything.
- I can't run this myself from here — network access to
  `api.open.fec.gov` and `api.census.gov` isn't available in this
  sandbox, and the keys should stay on your server, not in chat.
