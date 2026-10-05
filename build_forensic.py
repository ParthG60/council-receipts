"""Build the Housing & Crime forensic dataset for the terminal.

Reads executed-council decisions (data_england/c*/decisions.csv), classifies them
into forensic categories, joins ONS crime/rent pressure + MHCLG spend from the
main site's data.json, and writes site/housing-crime/data.json:
  { matrix: [...], councils: {ons: {...dossier...}}, meta: {...} }

Run: python site/build_forensic.py
"""
import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent.parent
SITE = Path(__file__).parent
sys.path.insert(0, str(SITE))
from common import load_registry  # noqa: E402

ID2ONS = {}
ONS2NAME = {}
for ons, rec in load_registry().items():
    if rec.get("council_id") is not None:
        ID2ONS[rec["council_id"]] = ons
        ONS2NAME[ons] = rec["name"]

DATA = json.loads((SITE / "data.json").read_text())
COUNCILS = DATA["councils"]

# ---------------------------------------------------------------- taxonomy ---
CATEGORIES = {
    "housing_ta": re.compile(
        r"temporary accommodation|homeless|bed and breakfast|\bb&b\b|nightly|"
        r"exempt accommodation|rough sleep|housing benefit|hotel|out-of-borough|"
        r"out of borough|housing first|ta placement", re.I),
    "planning_s106": re.compile(
        r"\bs106\b|section 106|viability|affordable housing|local plan|"
        r"community infrastructure levy|\bcil\b|planning permission|"
        r"development site|green belt|housing supply", re.I),
    "enforcement_asb": re.compile(
        r"anti-social behaviour|antisocial behaviour|\bpspo\b|public spaces protection|"
        r"\bcctv\b|enforcement notice|\bhmo\b|selective licensing|civil penalty|"
        r"security patrol|warden|knife crime|crime and disorder", re.I),
    "contracts": re.compile(
        r"procurement|contract award|direct award|contract procedure rule|"
        r"exemption|single tender|waiver|framework agreement|tender", re.I),
}
VALUE_RE = re.compile(r"£\s?([\d,]+(?:\.\d+)?)\s?(million|m|bn|k)?", re.I)


def parse_value(text):
    """First plausible GBP value in text -> float pounds, else None."""
    if not text:
        return None
    best = None
    for m in VALUE_RE.finditer(text):
        try:
            n = float(m.group(1).replace(",", ""))
        except ValueError:
            continue
        unit = (m.group(2) or "").lower()
        if unit in ("m", "million"):
            n *= 1_000_000
        elif unit == "bn":
            n *= 1_000_000_000
        elif unit == "k":
            n *= 1_000
        elif n < 1000:
            continue  # bare small number, likely not a contract value
        if n >= 1000:
            best = n if best is None else max(best, n)
    return best


def classify(text):
    return [cat for cat, pat in CATEGORIES.items() if pat.search(text)]


def clean(text, n=320):
    return re.sub(r"\s+", " ", text or "").strip()[:n]


# ------------------------------------------------------------ load decisions ---
decisions = []
files = sorted((ROOT / "data_england").glob("c*/decisions.csv"))
for f in files:
    cid = int(re.sub(r"\D", "", f.parent.name) or 0)
    ons = ID2ONS.get(cid)
    if not ons:
        continue
    try:
        with open(f, newline="", encoding="utf-8") as fh:
            for row in csv.DictReader(fh):
                text = " ".join([
                    row.get("topline") or "", row.get("purpose") or "",
                    row.get("content") or "", row.get("decision_maker") or "",
                ])
                cats = classify(text)
                if not cats:
                    continue
                decisions.append({
                    "ons_code": ons,
                    "date": (row.get("date") or "")[:10],
                    "decision_maker": clean(row.get("decision_maker"), 80),
                    "topline": clean(row.get("topline") or row.get("purpose"), 320),
                    "snippet": clean(row.get("content"), 400),
                    "url": row.get("url") or "",
                    "is_key": str(row.get("is_key")).lower() == "true",
                    "categories": cats,
                    "value_gbp": parse_value(text),
                })
    except Exception as e:
        print(f"  skip {f}: {e}")

print(f"classified {len(decisions)} housing/crime decisions across "
      f"{len({d['ons_code'] for d in decisions})} councils")

# --------------------------------------------------------- per-council dossier ---
by_ons = defaultdict(list)
for d in decisions:
    by_ons[d["ons_code"]].append(d)


def spend(c, service_contains):
    for item in c.get("money") or []:
        if service_contains.lower() in (item.get("service") or "").lower():
            return item.get("gbp_per_resident")
    return None


def discussion(c, topic_substr):
    ts = c.get("topic_share") or {}
    for t, v in ts.items():
        if topic_substr.lower() in t.lower():
            return v
    return None


LEAD_RULES = [
    ("Emergency accommodation procurement", "housing_ta",
     "Multiple temporary-accommodation decisions. Check single-tender waivers, "
     "nightly-paid B&B rates, and how many families are placed out of borough."),
    ("S106 viability concession leakage", "planning_s106",
     "Planning decisions citing viability or affordable housing. Request the "
     "developers' financial viability assessments and compare granted quotas to the Local Plan."),
    ("Punitive enforcement vs prevention", "enforcement_asb",
     "ASB/PSPO/CCTV decisions. Compare spending on enforcement and surveillance "
     "against youth and community-safety prevention budgets."),
    ("Commercial dependency", "contracts",
     "Procurement waivers and direct awards. Map the largest suppliers and "
     "check for repeated single-tender extensions."),
]

councils_out = {}
for ons, name in ONS2NAME.items():
    c = COUNCILS.get(name) or {}
    if not c:
        continue
    q = c.get("qol") or {}
    decs = sorted(by_ons.get(ons, []), key=lambda d: d["date"], reverse=True)
    counts = {cat: sum(1 for d in decs if cat in d["categories"]) for cat in CATEGORIES}
    leads = []
    for label, cat, advice in LEAD_RULES:
        if counts.get(cat, 0) >= 3:
            leads.append({"label": label, "category": cat, "advice": advice})
    councils_out[ons] = {
        "name": name,
        "ons_code": ons,
        "party": c.get("party_full") or c.get("party"),
        "population": c.get("population"),
        "pressure": {
            "rent_affordability": q.get("rent_affordability"),
            "rent_affordability_rank": q.get("rent_affordability_rank"),
            "crime_per_1000": q.get("crime_per_1000"),
            "crime_rank": q.get("crime_rank"),
            "child_poverty_pct": q.get("child_poverty_pct"),
            "child_poverty_rank": q.get("child_poverty_rank"),
        },
        "spend": {
            "housing": spend(c, "Housing services"),
            "planning": spend(c, "Planning and development"),
            "env_regulatory": spend(c, "Environmental and regulatory"),
            "discussion_housing": discussion(c, "Housing"),
            "discussion_safety": discussion(c, "Community Safety"),
        },
        "borrowing_per_resident": (c.get("borrowing") or {}).get("per_resident"),
        "decision_counts": counts,
        "total_decisions": len(decs),
        "leads": leads,
        "decisions": decs[:40],
    }

matrix = [{
    "ons_code": ons,
    "name": d["name"],
    "rent": d["pressure"]["rent_affordability"],
    "crime": d["pressure"]["crime_per_1000"],
    "housing_spend": d["spend"]["housing"],
    "flagged": d["total_decisions"],
} for ons, d in councils_out.items()
    if d["pressure"]["rent_affordability"] is not None and d["pressure"]["crime_per_1000"] is not None]

out = {
    "meta": {
        "built": "build_forensic.py",
        "councils": len(councils_out),
        "decisions": len(decisions),
        "categories": {k: sum(1 for d in decisions if k in d["categories"]) for k in CATEGORIES},
    },
    "matrix": matrix,
    "councils": councils_out,
}
dest = SITE / "housing-crime"
dest.mkdir(exist_ok=True)
(dest / "data.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
print(f"wrote {dest/'data.json'}  ({out['meta']})")

# ---------------------------------------------- plain-text dossiers + llms ---
DOSS = dest / "dossiers"
DOSS.mkdir(exist_ok=True)
BASE = "https://parthgoyal.uk/council-receipts/housing-crime"
index = ["# Housing & Crime Forensic Terminal — plain-text dossiers", ""]
for ons, d in sorted(councils_out.items(), key=lambda kv: kv[1]["name"]):
    p, s = d["pressure"], d["spend"]
    L = [f"# {d['name']} ({ons}) — housing & crime dossier", ""]
    L.append(f"Control: {d.get('party') or 'n/a'} | Population: {d.get('population') or 'n/a'}")
    L.append(f"Rent burden: {p['rent_affordability']}% (rank #{p['rent_affordability_rank']}/282)")
    L.append(f"Crime: {p['crime_per_1000']}/1k (rank #{p['crime_rank']}/282)")
    L.append(f"Housing spend: £{round(s['housing'])}/head" if s.get("housing") is not None else "Housing spend: n/a")
    L.append(f"Safety spend: £{round(s['env_regulatory'])}/head" if s.get("env_regulatory") is not None else "Safety spend: n/a")
    L.append(f"Borrowing: £{round(d['borrowing_per_resident'])}/head" if d.get("borrowing_per_resident") is not None else "Borrowing: n/a")
    L.append("")
    L.append("Decision counts: " + ", ".join(f"{k}={v}" for k, v in d["decision_counts"].items()))
    if d["leads"]:
        L.append("")
        L.append("Investigative leads:")
        L += [f"- {l['label']}: {l['advice']}" for l in d["leads"]]
    if d["decisions"]:
        L.append("")
        L.append("Recent flagged decisions:")
        for dec in d["decisions"][:15]:
            val = f" £{dec['value_gbp']:,.0f}" if dec.get("value_gbp") else ""
            L.append(f"- [{dec['date']}] ({', '.join(dec['categories'])}){val} {dec['topline']}" + (f" {dec['url']}" if dec.get("url") else ""))
    (DOSS / f"{ons}.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    index.append(f"- [{d['name']}]({BASE}/dossiers/{ons}.md)")

(dest / "dossiers" / "index.txt").write_text("\n".join(index) + "\n", encoding="utf-8")
llms = ["# Housing & Crime Forensic Terminal", "",
        "Forensic tool following the paper trail on English councils' housing and crime spending.",
        f"Interactive: {BASE}/", "",
        "## Data",
        f"- Full dataset: {BASE}/data.json",
        f"- Plain-text dossiers index: {BASE}/dossiers/index.txt",
        "- MCP tools: list_councils, get_council_dossier, search_decisions, generate_foi",
        "- Categories: housing_ta, planning_s106, enforcement_asb, contracts",
        "- Fields: pressure (rent, crime, ranks), spend (housing, planning, env_regulatory),",
        "  decision_counts, leads, decisions[{date,decision_maker,topline,snippet,url,value_gbp,categories}].", ""]
(dest / "llms.txt").write_text("\n".join(llms) + "\n", encoding="utf-8")
print(f"wrote {len(councils_out)} forensic dossiers + llms.txt")

