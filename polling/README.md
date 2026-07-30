# 2026 U.S. House — Polling Margins & Averages

Interactive margin/average view for all 435 U.S. House districts, built for Election Center.

**Live page:** `index.html` (self-contained — data is embedded, no server or API key needed)

## What's here

```
index.html                  standalone page: 4 charts + sortable data table
build_dataset.py            CSV → normalized JSON (stdlib only, no deps)
page_template.html          template with __DATA__ placeholder
data/house_2026_raw.csv     source data, unmodified
data/house_2026.json        normalized output with numeric margins
docs/METHODOLOGY.md         how every number on the page is calculated
```

## Honest label on the data

Only **43 of 435** districts carry a real numeric margin. The other **392 are inferred from the race rating**, because individual House districts are barely polled — in a typical cycle fewer than 60 get a single public poll, and safe seats get none.

Every row is tagged `evidence: "poll"` or `evidence: "rating"`, estimated rows render faded in every chart, and the two are never blended into a single unlabeled number. This is a **rating-derived margin estimate**, not a polling average in the FiveThirtyEight sense, and the page says so at the top.

## Headline numbers

| | |
|---|---|
| National average (confidence-weighted) | **D +1.18** |
| Poll-backed average (43 seats) | D +2.00 |
| Battleground average (44 seats) | D +1.50 |
| D-favored / R-favored / too close | 222 / 191 / 22 |
| Projected Democratic range | **222–244** (218 = majority) |

Seats inside ±2.0 points are counted as undecided rather than awarded — that band is inside normal polling error.

## The four charts

1. **Margin by district** — diverging bars, D right / R left, sorted closest-first. Filter to competitive, battlegrounds, poll-backed, or all 435.
2. **Seat projection** — every district sorted by margin with a cumulative D-seat line; marks exactly which district is the 218th seat (currently OH-13 at D +3.0). Plus a seat-balance bar with the 218 tick.
3. **Average over time** — wired for dated polls with a 30-day-half-life weighted rolling average. Renders an empty state with the required schema until dated polls are ingested, then activates with no code change.
4. **Distribution of margins** — histogram across ten competitiveness bands, solid = poll-backed, faded = estimated.

Plus a full 435-row table, sortable on every column, with the source link preserved per row.

## Rebuilding

```bash
python3 build_dataset.py     # data/house_2026_raw.csv → data/house_2026.json
```

Then re-inline the data into the page:

```bash
python3 - <<'EOF'
import json, pathlib
data = json.loads(pathlib.Path("data/house_2026.json").read_text())
tpl  = pathlib.Path("page_template.html").read_text()
pathlib.Path("index.html").write_text(tpl.replace("__DATA__", json.dumps(data, separators=(",", ":"))))
EOF
```

`build_dataset.py` asserts the three seat bands sum to 435 and fails loudly if they don't.

## Wiring this to the backend

The trend chart reads a `polls` array per race using the same schema already specified for the Election Center poll ingest (`raceId` format `AZ-H-01-2026`, `reviewStatus: "approved"` gating). Approved polls landing in that store can be written straight into `data/house_2026.json` and the time-series view lights up on its own.

## Limitations

Not a forecast. No simulation, no correlated polling error, no turnout model, no candidate-quality or house-effect adjustment. Full list in [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md).

## Sources

- [Cook Political Report — House ratings](https://www.cookpolitical.com/ratings/house-race-ratings) (408 rows)
- [Sabato's Crystal Ball — 2026 House](https://centerforpolitics.org/crystalball/2026-house/) (11)
- [Ballotpedia](https://ballotpedia.org/United_States_House_of_Representatives_elections) (11)
- [WHYY — 2026 PA races](https://whyy.org/articles/2026-elections-united-states-house-pennsylvania/) (4)
- [Swing Left](https://swingleft.org/house) (1)
