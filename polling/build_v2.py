#!/usr/bin/env python3
"""
v2 rebuild. Ratings now come from the Election Center site's own embedded
snapshot (432 rated districts, 212 D-side / 220 R-side) instead of the first
uploaded CSV, whose party labels were scrambled (it called Aderholt a Democrat
and rated AL-07 Solid Republican).

Candidate names are taken from the head-to-head CSV only where they are not
"TBD", and only after realigning its columns (423 of 435 rows carry 16 fields
against a 17-field header, shifting everything from `Margin` rightward).
"""
import csv, json, pathlib, datetime, statistics, collections

ROOT = pathlib.Path(__file__).parent
UP   = pathlib.Path("/sessions/vibrant-happy-davinci/mnt/uploads")

MID = {"Solid D":20.0,"Likely D":10.0,"Lean D":4.0,"Tilt D":1.5,
       "Tilt R":-1.5,"Lean R":-4.0,"Likely R":-10.0,"Solid R":-20.0}
TOSSUP = 2.0

# ---- ratings (source of truth) -------------------------------------------
ratings = {}
for line in (ROOT/"site_ratings_parsed.txt").read_text().splitlines():
    d, r = line.split("\t"); ratings[d] = r

# ---- candidate names from the head-to-head CSV ---------------------------
names = {}
raw = list(csv.reader((UP/"2026_house_435_head_to_head.csv").open(encoding="utf-8-sig")))[1:]
for r in raw:
    dist = r[0].strip()
    st, num = dist.split("-", 1)
    key = f"{st}-{num.zfill(2)}" if num.isdigit() else dist
    dem, rep = r[2].strip(), r[3].strip()
    off = 11 if len(r) == 16 else 12          # realignment
    names[key] = {
        "dem": None if dem in ("TBD","") else dem,
        "rep": None if rep in ("TBD","") else rep,
        "csvRating": r[off].strip() if len(r) > off else None,
        "sourceUrl": r[off+1].strip() if len(r) > off+1 else None,
    }

# ---- real polls ----------------------------------------------------------
POLLS = {"AZ-02": {"pollster":"GBAO (D)","date":"2026-06-15","n":500,"population":"LV",
                   "dem":41.0,"rep":44.0,"margin":-3.0,"moe":4.4,"sponsor":"D",
                   "url":"https://pollingsource.com/house/AZ-02"}}

# Candidate names VERIFIED against primary sources. The head-to-head CSV's names
# are not trusted: it puts Tom O'Halleran (a Democrat) in the Republican column
# for AZ-02 and rates that seat Solid D, so its party assignments are unreliable
# in exactly the same way its ratings were. Rather than publish names that may be
# swapped, the name columns are left blank unless verified here.
VERIFIED = {
    "AZ-02": {"dem": "Jonathan Nez", "rep": "Eli Crane (i)"},
}

# ---- build races ---------------------------------------------------------
races = []
for dist in sorted(ratings):
    rating = ratings[dist]
    nm = names.get(dist, {})
    poll = POLLS.get(dist)
    st, num = dist.split("-", 1)
    races.append({
        "district": dist, "state": st, "num": num,
        "rating": rating,
        "margin": round(poll["margin"], 2) if poll else MID[rating],
        "evidence": "poll" if poll else "rating",
        "demCandidate": VERIFIED.get(dist, {}).get("dem"),
        "repCandidate": VERIFIED.get(dist, {}).get("rep"),
        "csvDem": nm.get("dem"), "csvRep": nm.get("rep"),
        "poll": poll,
        "sourceUrl": nm.get("sourceUrl") or None,
        "csvRatingDisagrees": bool(nm.get("csvRating")) and nm["csvRating"] != rating,
    })

marg = [r["margin"] for r in races]
safeD = sum(1 for m in marg if m >  TOSSUP)
safeR = sum(1 for m in marg if m < -TOSSUP)
toss  = len(marg) - safeD - safeR
byrat = collections.Counter(r["rating"] for r in races)
disagree = sum(1 for r in races if r["csvRatingDisagrees"])

# ---- generic ballot -----------------------------------------------------
gb = json.loads((ROOT.parent/"sitedata"/"generic-ballot.json").read_text())

summary = {
    "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "ratedSeats": len(races), "unratedSeats": 435 - len(races),
    "ratingCounts": dict(byrat),
    "dSide": byrat["Solid D"]+byrat["Likely D"]+byrat["Lean D"]+byrat["Tilt D"],
    "rSide": byrat["Tilt R"]+byrat["Lean R"]+byrat["Likely R"]+byrat["Solid R"],
    "safeD": safeD, "safeR": safeR, "tossups": toss, "tossupThreshold": TOSSUP,
    "dRangeLow": safeD, "dRangeHigh": safeD + toss,
    "median": round(statistics.median(marg), 2),
    "pollBackedSeats": sum(1 for r in races if r["evidence"] == "poll"),
    "csvDisagreements": disagree,
    "genericBallot": gb["average"], "genericPollCount": gb["meta"]["pollCount"],
    "genericRange": gb["meta"]["dateRange"],
}
assert safeD + safeR + toss == len(races)

(ROOT/"data"/"house_2026_v2.json").write_text(json.dumps(
    {"summary": summary, "races": races, "genericBallot": gb}, indent=2))

print("rated:", len(races), "| D-side", summary["dSide"], "R-side", summary["rSide"])
print("bands: safeD %d  tossup %d  safeR %d  -> D range %d-%d" % (safeD, toss, safeR, summary["dRangeLow"], summary["dRangeHigh"]))
print("median margin:", summary["median"])
print("verified names: %d districts" % sum(1 for r in races if r["demCandidate"]))
print("csv names withheld (untrusted): %d had a non-TBD name" % sum(
    1 for r in races if r.get("csvDem") or r.get("csvRep")))
print("head-to-head CSV rating disagreements vs site:", disagree, "of", len(races))
print("generic ballot: D %.2f R %.2f margin D%+.2f from %d polls (%s -> %s)" % (
    gb["average"]["dem"], gb["average"]["rep"], gb["average"]["margin"],
    gb["meta"]["pollCount"], gb["meta"]["dateRange"][0], gb["meta"]["dateRange"][1]))
