# How the averages are calculated

*2026 U.S. House — all 435 districts. Last rebuilt from source: see `generated` in `data/house_2026.json`.*

---

## Read this first

**This is not a polling average in the FiveThirtyEight sense, and it should not be presented as one.**

Of the 435 districts in the source file, **43 carry a specific numeric margin**. The other **392 carry a placeholder margin derived from the race rating**, not from any poll. Individual U.S. House districts are barely polled — in a typical cycle fewer than 60 of 435 get a single public district-level poll, and safe seats get none at all. Any product claiming a real polling average in all 435 districts is inventing 380+ of them.

So this dataset is honest about the distinction and tags every row with an `evidence` field:

| `evidence` | Meaning | Count |
|---|---|---|
| `poll` | A specific numeric margin was supplied for this district | 43 |
| `rating` | Margin inferred from the race rating band only | 392 |

Every chart and table on the site shades or flags `rating` rows so the two never get silently blended into one number.

---

## Step 1 — Margin convention

Every margin is stored as a **single signed number in percentage points**:

```
margin = (Democratic share) − (Republican share)

positive  →  Democratic advantage      D +3.5  →  +3.5
negative  →  Republican advantage      R +8.0  →  −8.0
zero      →  exact tie
```

Storing one signed number instead of two vote shares means margins can be averaged, sorted, and charted directly, and a diverging bar chart falls straight out of the sign.

## Step 2 — Parsing the source strings

The source file writes margins as text. The parser handles four shapes:

| Source text | Parsed | Note |
|---|---|---|
| `D +2.0%` | `+2.0` | Straightforward |
| `R +4.0%` | `−4.0` | Sign flipped for R |
| `Even / D +0.5%` | `+0.5` | Text after the slash wins |
| `D +15.0%+` | `+20.0` | Trailing `+` means "at least" — see below |

The trailing-`+` case matters. `D +15.0%+` is not a measurement, it is the *floor of a rating band*. Treating it as a literal 15.0 would drag every average toward 15 and make safe seats look artificially close. These rows are flagged `evidence: "rating"` and replaced with the band midpoint below.

## Step 3 — Rating → margin midpoints

For rating-only districts, the rating band is mapped to the midpoint of the margin range that band historically implies:

| Rating | Assumed margin |
|---|---|
| Solid Democratic | +20.0 |
| Likely Democratic | +10.0 |
| Lean Democratic | +4.0 |
| Tilt Democratic | +1.5 |
| Tossup | 0.0 |
| Tilt Republican | −1.5 |
| Lean Republican | −4.0 |
| Likely Republican | −10.0 |
| Solid Republican | −20.0 |

These are **assumptions, not observations.** They are declared in one place (`RATING_MIDPOINT` in `build_dataset.py`, mirrored into `meta.ratingMidpoints` in the JSON) so anyone who disagrees can change one table and rebuild rather than hunting through the code.

## Step 4 — Confidence weighting

A district backed by an actual number should count more than one backed by a rating guess. Each row gets a weight:

```
poll-backed row    weight = 1.00
rating-only row    weight = 0.35
```

The **weighted national average** is then:

```
weighted mean = Σ(margin × weight) / Σ(weight)
```

This is why the site reports two national numbers side by side:

- **Simple mean (+1.03)** — every district counts equally, guesses included.
- **Weighted mean (+1.18)** — real numbers pull harder than inferred ones.

They are close here, which is itself informative: the rating-derived seats are roughly balanced (205 Solid D vs 187 Solid R), so downweighting them barely moves the national figure. If those two numbers ever diverge sharply, the inferred data is doing too much work and the result should not be trusted.

The 0.35 weight is a judgement call, not a derived constant. It is set to make one poll-backed district worth roughly three rating-only ones.

## Step 5 — Seat projection

Districts are sorted into three bands rather than two, because **a 0.4-point lead is not a win**:

```
margin >  +2.0   →  Democratic-favored     222 seats
margin <  −2.0   →  Republican-favored     191 seats
|margin| ≤ 2.0   →  too close to call       22 seats
                                           ─────────
                                            435 ✓
```

The ±2.0 threshold is roughly the error band of a single competent district poll. Reporting a point estimate inside that band implies precision the data does not have.

This produces a **range, not a number**: Democrats land between **222 and 244 seats** depending on how the 22 tossups break. 218 is the majority. Both ends of that range clear 218, which is the actual headline — but the range is wide enough that the margin of control is genuinely unsettled.

**What this projection is not:** it is not a simulation. It does not model correlated polling error (when polls miss, they miss in the same direction nearly everywhere), turnout, candidate quality, or national swing between now and Election Day. A real forecast runs thousands of correlated simulations. This is a seat count under the assumption that every stated margin is exactly right — a floor for how uncertain things are, not a ceiling.

## Step 6 — Subgroup averages

Three narrower averages are computed, each an unweighted mean over its subset:

- **Poll-backed mean (+2.0)** — the 43 districts with real numbers. The most defensible figure on the page, though heavily biased toward competitive seats, since those are the ones anyone bothers to poll.
- **Battleground mean (+1.5)** — the 44 seats flagged `Key Battleground`. Closest thing here to a national competitive-seat environment.
- **Median (+3.0)** — the middle district. Sits above the mean because the safe-seat distribution is lopsided (205 Solid D vs 187 Solid R), and the median is insensitive to how lopsided the far tails are.

---

## Known limitations

1. **392 of 435 margins are inferred, not measured.** This is the dominant limitation and it is not fixable with better math — it requires more polling that does not exist.
2. **Ratings are not margins.** Cook, Sabato, and similar raters weigh fundamentals, candidate quality, and money, not just horse-race numbers. Converting a rating to a point margin discards that reasoning.
3. **No dates.** The source file carries no fielding dates, so no recency weighting is applied and no trend line can be drawn. The time-series chart is built and wired, but it stays empty until dated polls are ingested.
4. **No pollster quality adjustment.** No house-effect correction, no partisan-sponsor discount, no sample-size weighting — the source data carries none of those fields.
5. **Candidate names are placeholders in safe seats.** Rows outside the battlegrounds read `Democratic Candidate (AL-01)` rather than a real name.
6. **Single snapshot.** One rebuild reflects one moment. Nothing here tracks movement.

## What would upgrade this to a real average

The schema is already designed for it — each district would take a list of polls instead of one number:

```json
{
  "district": "AZ-01",
  "polls": [
    { "pollster": "...", "start": "2026-07-10", "end": "2026-07-14",
      "n": 600, "population": "LV", "sponsor": null, "margin": 1.4 }
  ]
}
```

With dated polls in hand, the average becomes a weighted mean over polls within a district:

```
weight = recency × √(sample size) × population × independence

recency      exponential decay, ~30-day half-life
sample size  √n, capped so a 3,000-person poll ≈ 2× a 750-person poll
population   LV 1.0 · RV 0.9 · A 0.7
independence independent 1.0 · campaign-sponsored 0.5
```

That matches the poll schema already specified for the Election Center backend (`raceId` format `AZ-H-01-2026`, `reviewStatus: "approved"` gating), so ingested polls will flow into this page without a schema change. Until then, the honest label for this page is **"rating-derived margin estimates,"** which is what it says.

---

## Reproducing this

```bash
python3 build_dataset.py    # reads data/house_2026_raw.csv → writes data/house_2026.json
```

No dependencies beyond the Python standard library. The script asserts that the three seat bands sum to 435 and fails loudly if they do not. Every constant used in the calculation is defined at the top of the file and copied into `meta` in the output JSON, so the numbers on the page can always be traced back to the assumptions that produced them.

## Sources

All source links are preserved per row in `sourceUrl` and are clickable in the district table.

- [Cook Political Report — House race ratings](https://www.cookpolitical.com/ratings/house-race-ratings) — 408 rows
- [Sabato's Crystal Ball — 2026 House](https://centerforpolitics.org/crystalball/2026-house/) — 11 rows
- [Ballotpedia — U.S. House elections](https://ballotpedia.org/United_States_House_of_Representatives_elections) — 11 rows
- [WHYY — 2026 Pennsylvania House races](https://whyy.org/articles/2026-elections-united-states-house-pennsylvania/) — 4 rows
- [Swing Left — House](https://swingleft.org/house) — 1 row
