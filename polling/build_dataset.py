#!/usr/bin/env python3
"""
Normalize the 2026 House seat CSV into a clean JSON dataset.

Input : data/house_2026_raw.csv  (435 rows, one per district)
Output: data/house_2026.json     (normalized, numeric margins)

Margin convention: signed number in percentage points.
    positive = Democratic advantage
    negative = Republican advantage
"""
import csv, json, re, statistics, datetime, pathlib

ROOT = pathlib.Path(__file__).parent
SRC  = ROOT / "data" / "house_2026_raw.csv"
OUT  = ROOT / "data" / "house_2026.json"

# Rating -> assumed margin midpoint (percentage points, D-positive).
# Used only when a race has no numeric poll margin of its own.
RATING_MIDPOINT = {
    "Solid Democratic":  20.0,
    "Likely Democratic": 10.0,
    "Lean Democratic":    4.0,
    "Tilt Democratic":    1.5,
    "Tossup":             0.0,
    "Tilt Republican":   -1.5,
    "Lean Republican":   -4.0,
    "Likely Republican":-10.0,
    "Solid Republican": -20.0,
}

# Confidence weight by evidence quality. Feeds the weighted averages.
CONFIDENCE = {"poll": 1.0, "rating": 0.35}


def parse_margin(text):
    """
    Turn a margin string into (signed_float, kind).

    Handles: 'D +2.0%', 'R +15.0%+', 'Even / D +0.5%', 'D +1.5%'
    kind is 'numeric' if a real number was present, else None.
    """
    if not text:
        return None, None
    t = text.strip()
    # 'Even / D +0.5%' -> take the part after the slash
    if "/" in t:
        t = t.split("/")[-1].strip()
    if re.fullmatch(r"(?i)even", t):
        return 0.0, "numeric"
    m = re.search(r"(?i)\b([DR])\s*\+?\s*([0-9]+(?:\.[0-9]+)?)", t)
    if not m:
        return None, None
    party, value = m.group(1).upper(), float(m.group(2))
    signed = value if party == "D" else -value
    capped = t.rstrip().endswith("+")      # '15.0%+' means "at least"
    return signed, ("floor" if capped else "numeric")


def load():
    rows = []
    with SRC.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            code = (r.get("District Code") or "").strip()
            if not code:
                continue
            rating = (r.get("Consensus Race Rating") or "").strip()
            raw_margin = (r.get("Latest Poll / Rating Margin") or "").strip()
            margin, kind = parse_margin(raw_margin)

            # A margin counts as poll-grade evidence only when it is a specific
            # number that is NOT just the rating band's floor value.
            is_floor = kind == "floor"
            band = RATING_MIDPOINT.get(rating)
            evidence = "rating"
            if margin is not None and not is_floor and abs(margin) < 15.0:
                evidence = "poll"

            if evidence == "rating":
                margin = band if band is not None else margin

            rows.append({
                "district":     code,
                "state":        (r.get("State") or "").strip(),
                "districtNum":  int(r["District #"]) if (r.get("District #") or "").strip().isdigit() else None,
                "incumbent":    (r.get("Incumbent Representative") or "").strip(),
                "demCandidate": (r.get("Democratic Candidate / Nominee") or "").strip(),
                "repCandidate": (r.get("Republican Candidate / Nominee") or "").strip(),
                "rating":       rating,
                "rawMargin":    raw_margin,
                "margin":       round(margin, 2) if margin is not None else None,
                "evidence":     evidence,
                "weight":       CONFIDENCE[evidence],
                "battleground": (r.get("Key Battleground") or "").strip().lower() == "yes",
                "sourceUrl":    (r.get("Source Link") or "").strip(),
                "notes":        (r.get("Race Notes") or "").strip(),
            })
    return rows


def weighted_mean(values, weights):
    tw = sum(weights)
    return sum(v * w for v, w in zip(values, weights)) / tw if tw else None


def summarize(rows):
    m  = [r["margin"] for r in rows if r["margin"] is not None]
    w  = [r["weight"] for r in rows if r["margin"] is not None]
    polls = [r for r in rows if r["evidence"] == "poll"]
    bg    = [r for r in rows if r["battleground"] and r["margin"] is not None]

    lean_d = sum(1 for r in rows if (r["margin"] or 0) > 0)
    lean_r = sum(1 for r in rows if (r["margin"] or 0) < 0)
    tied   = sum(1 for r in rows if r["margin"] == 0)

    # Anything inside +/- 2.0 points is inside normal polling error: call it
    # undecided rather than awarding it to a party.
    TOSSUP = 2.0
    safe_d = sum(1 for r in rows if (r["margin"] or 0) >  TOSSUP)
    safe_r = sum(1 for r in rows if (r["margin"] or 0) < -TOSSUP)
    toss   = len(rows) - safe_d - safe_r

    return {
        "generated":         datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "seats":             len(rows),
        "simpleMean":        round(statistics.fmean(m), 2),
        "weightedMean":      round(weighted_mean(m, w), 2),
        "median":            round(statistics.median(m), 2),
        "pollBackedSeats":   len(polls),
        "ratingOnlySeats":   len(rows) - len(polls),
        "pollBackedMean":    round(statistics.fmean([r["margin"] for r in polls]), 2) if polls else None,
        "battlegroundSeats": len(bg),
        "battlegroundMean":  round(statistics.fmean([r["margin"] for r in bg]), 2) if bg else None,
        "projectedD":        lean_d,
        "projectedR":        lean_r,
        "exactTies":         tied,
        "tossupThreshold":   TOSSUP,
        "safeD":             safe_d,
        "safeR":             safe_r,
        "tossups":           toss,
        "dRangeLow":         safe_d,
        "dRangeHigh":        safe_d + toss,
        "seatsToMajority":   218,
    }


def main():
    rows = load()
    rows.sort(key=lambda r: (r["state"], r["districtNum"] or 0))
    payload = {
        "meta": {
            "title": "2026 U.S. House — All 435 Seats",
            "marginConvention": "Signed percentage points. Positive = Democratic advantage, negative = Republican advantage.",
            "ratingMidpoints": RATING_MIDPOINT,
            "confidenceWeights": CONFIDENCE,
            "sourceFile": "data/house_2026_raw.csv",
        },
        "summary": summarize(rows),
        "races": rows,
    }
    OUT.write_text(json.dumps(payload, indent=2))
    s = payload["summary"]
    print(f"seats={s['seats']} poll-backed={s['pollBackedSeats']} rating-only={s['ratingOnlySeats']}")
    print(f"simple={s['simpleMean']} weighted={s['weightedMean']} median={s['median']}")
    print(f"projected D={s['projectedD']} R={s['projectedR']} ties={s['exactTies']}")
    print(f"safe D={s['safeD']} safe R={s['safeR']} tossups={s['tossups']} -> D range {s['dRangeLow']}-{s['dRangeHigh']}")
    assert s['safeD'] + s['safeR'] + s['tossups'] == 435, "seat bands must sum to 435"


if __name__ == "__main__":
    main()
