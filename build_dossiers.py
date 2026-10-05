"""Generate AI-native artifacts from site/data.json:
  - site/dossiers/{ons_code}.md   one plain-text dossier per council
  - site/llms.txt                 machine-readable index for LLM web agents

Idempotent. Run after build.py: python site/build_dossiers.py
"""
import json
from pathlib import Path

SITE = Path(__file__).parent
DATA = json.loads((SITE / "data.json").read_text())
COUNCILS = DATA.get("councils", {})
DOSS = SITE / "dossiers"
DOSS.mkdir(exist_ok=True)

SITE_URL = "https://parthgoyal.uk/council-receipts"


def fmt_pop(n):
    if n is None:
        return "n/a"
    return f"{n:,}"


def money_rows(c):
    rows = []
    for item in c.get("money") or []:
        if isinstance(item, dict) and item.get("service"):
            rows.append((item["service"], item.get("gbp_per_resident")))
    return sorted(rows, key=lambda r: -(r[1] or 0))[:6]


def dossier(name, c):
    q = c.get("qol") or {}
    d = c.get("financial_distress") or {}
    b = c.get("borrowing") or {}
    L = []
    code = c.get("ons_code") or "unknown"
    L.append(f"# {name} — council dossier")
    L.append("")
    L.append(f"- ONS code: {code}")
    L.append(f"- Tier: {c.get('la_class_label') or c.get('tier') or 'n/a'}"
             + (f" (part of {c['parent_county']})" if c.get("parent_county") else ""))
    L.append(f"- Political control: {c.get('party_full') or c.get('party') or 'n/a'}")
    L.append(f"- Population: {fmt_pop(c.get('population'))}")
    L.append("")
    L.append("## Outcomes (national rank out of 282; #1 = best)")
    for label, val, rank in [
        ("Life expectancy (years)", q.get("life_expectancy"), q.get("life_expectancy_rank")),
        ("GCSE Attainment 8 (points)", q.get("attainment8"), q.get("attainment8_rank")),
        ("Rent affordability (% of pay)", q.get("rent_affordability"), q.get("rent_affordability_rank")),
        ("Child poverty (%)", q.get("child_poverty_pct"), q.get("child_poverty_rank")),
        ("Claimant rate (%)", q.get("claimant_rate_pct"), q.get("claimant_rate_rank")),
        ("Crime per 1,000 residents", q.get("crime_per_1000"), q.get("crime_rank")),
    ]:
        if val is not None:
            L.append(f"- {label}: {val}" + (f" (rank #{rank})" if rank is not None else ""))
    L.append("")
    L.append("## Financial health")
    if d.get("severity", 0) >= 2:
        L.append(f"- Distress: {d.get('distress_status')}")
        if d.get("is_efs") and d.get("efs_amount_gbp_m") is not None:
            L.append(f"- Exceptional Financial Support: £{d['efs_amount_gbp_m']}m")
    else:
        L.append("- Distress: no active Section 114 notice or EFS intervention")
    if b.get("per_resident") is not None:
        L.append(f"- Borrowing per resident: £{round(b['per_resident']):,}"
                 + (f" (total £{b['total_gbp_m']:.0f}m)" if b.get("total_gbp_m") is not None else ""))
    L.append("")
    spends = money_rows(c)
    if spends:
        L.append("## Biggest service budgets (£ per resident)")
        for svc, per in spends:
            L.append(f"- {svc}: £{round(per):,}" if per is not None else f"- {svc}: n/a")
        L.append("")
    contracts = c.get("contracts") or []
    if contracts:
        L.append("## Largest published contract awards")
        for r in contracts[:5]:
            val = r.get("value_gbp")
            val_s = f"£{val/1_000_000:.1f}m" if val else "n/a"
            L.append(f"- {r.get('supplier')}: {val_s} across {r.get('n')} award(s)")
        L.append("")
    L.append("## Primary sources")
    L.append(f"- Full interactive profile: {SITE_URL}/?council={name.replace(' ', '%20')}#tab-council")
    L.append(f"- Council committee minutes: https://www.google.com/search?q={name.replace(' ', '+')}+council+committee+minutes")
    L.append(f"- Local crime statistics: https://www.police.uk/")
    L.append(f"- Town-hall scrutiny news: https://news.google.com/search?q={name.replace(' ', '+')}+council+scrutiny+budget")
    L.append("")
    L.append("## Suggested use")
    L.append("Ask an AI: \"Using only these verified figures, give me three sharp questions "
             "to put to my councillor, name the single biggest financial risk, and compare "
             "local services with the England average.\"")
    return "\n".join(L) + "\n"


count = 0
index_lines = ["# Council Receipts",
               "",
               "Verified English local-government benchmarking data, 282 councils.",
               f"Interactive: {SITE_URL}/",
               "",
               "## Plain-text dossiers",
               ""]
for name, c in sorted(COUNCILS.items()):
    code = c.get("ons_code")
    if not code:
        continue
    (DOSS / f"{code}.md").write_text(dossier(name, c), encoding="utf-8")
    index_lines.append(f"- [{name}]({SITE_URL}/dossiers/{code}.md)")
    count += 1

index_lines += ["", "## Data",
                f"- Interactive JSON: {SITE_URL}/data.json",
                "- Fields per council: population, political control, service budgets (£/resident), "
                "topic discussion shares, outcomes with national ranks, borrowing, financial distress, contracts."]
(SITE / "llms.txt").write_text("\n".join(index_lines) + "\n", encoding="utf-8")
print(f"wrote {count} dossiers + llms.txt")
