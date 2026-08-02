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
# Ingested from the 538-format export by ingest_538.py. 68 districts now carry
# genuine general-election polling; previously exactly one did.
ING = pathlib.Path("/sessions/vibrant-happy-davinci/mnt/outputs/ingest/data")
POLLS = {}
if (ING / "poll-index.json").exists():
    _idx = json.loads((ING / "poll-index.json").read_text())
    for raceId, meta in _idx.get("house", {}).items():
        detail = json.loads((ING / "polls" / f"{raceId}.json").read_text())
        latest = detail["polls"][0]
        d = next((r["percentage"] for r in latest["results"] if r["candidate"].endswith("(D)")), None)
        r_ = next((r["percentage"] for r in latest["results"] if r["candidate"].endswith("(R)")), None)
        POLLS[meta["code"]] = {
            "pollster": latest["pollster"], "date": latest["endDate"],
            "n": latest.get("sampleSize"), "population": latest.get("population"),
            "dem": d, "rep": r_, "margin": meta["margin"],
            "pollCount": meta["polls"], "latest": meta["latest"],
            "url": latest.get("sourceUrl"),
            "sponsor": ("D" if "(D)" in latest["pollster"] else "R" if "(R)" in latest["pollster"] else None),
        }

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
    })

marg = [r["margin"] for r in races]
safeD = sum(1 for m in marg if m >  TOSSUP)
safeR = sum(1 for m in marg if m < -TOSSUP)
toss  = len(marg) - safeD - safeR
byrat = collections.Counter(r["rating"] for r in races)
# The published correction is about the FIRST uploaded CSV, so it must be measured
# against that file - not the later head-to-head one. Conflating them understated
# the error as 124 when the real figure is 205.
def _norm(t):
    t = t.lower().replace("democratic", "d").replace("republican", "r")
    return t.replace("toss up", "tossup").replace("-", "").replace(" ", "")

first = {}
with (UP / "2026_All_435_House_Seats_Polling_Data - Untitled.csv").open(encoding="utf-8-sig") as f:
    for row in csv.DictReader(f):
        code = row["District Code"].strip()
        st_, num_ = code.split("-", 1)
        key = f"{st_}-{num_.zfill(2)}" if num_.isdigit() else code
        first[key] = row["Consensus Race Rating"].strip()
shared  = [r for r in races if r["district"] in first]
disagree = sum(1 for r in shared if _norm(first[r["district"]]) != _norm(r["rating"]))

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
    "totalPollsIngested": sum(p.get("pollCount",1) for p in POLLS.values()),
    "firstCsvDisagreements": disagree,
    "firstCsvCompared": len(shared),
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
print("FIRST CSV disagreements vs site ratings:", disagree, "of", len(shared))
print("generic ballot: D %.2f R %.2f margin D%+.2f from %d polls (%s -> %s)" % (
    gb["average"]["dem"], gb["average"]["rep"], gb["average"]["margin"],
    gb["meta"]["pollCount"], gb["meta"]["dateRange"][0], gb["meta"]["dateRange"][1]))
