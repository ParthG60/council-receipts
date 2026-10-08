"""Generate AI-native artifacts from site/data.json:
  - site/dossiers/{ons_code}.md   one plain-text dossier per council
  - site/llms.txt                 machine-readable index for LLM web agents

Idempotent. Run after build.py: python site/build_dossiers.py
"""
import json
import re
from pathlib import Path

SITE = Path(__file__).parent
DATA = json.loads((SITE / "data.json").read_text())
COUNCILS = DATA.get("councils", {})
N_COUNCILS = len(COUNCILS) or 283
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
    eng = DATA.get("qol_benchmark") or DATA.get("qol_england") or {}
    d = c.get("financial_distress") or {}
    b = c.get("borrowing") or {}
    be = DATA.get("borrowing_england") or {}
    L = []
    code = c.get("ons_code") or "unknown"
    L.append(f"# {name} — citizen briefing")
    L.append("")
    L.append(f"- ONS code: {code}")
    L.append(f"- Tier: {c.get('la_class_label') or c.get('tier') or 'n/a'}"
             + (f" (part of {c['parent_county']})" if c.get("parent_county") else ""))
    L.append(f"- Political control: {c.get('party_full') or c.get('party') or 'n/a'}")
    ctrl = c.get("control") or {}
    if ctrl.get("changed"):
        L.append(f"- Control history: {ctrl.get('current')} since {ctrl.get('since')}"
                 + (f" (previously {ctrl.get('previous')})" if ctrl.get("previous") else ""))
    if c.get("election"):
        e = c["election"]
        L.append(f"- Upcoming election: {e.get('title')} — polls {e.get('poll_date')}")
    L.append(f"- Population: {fmt_pop(c.get('population'))}")
    L.append("")

    L.append(f"## Outcomes vs median council (rank out of {N_COUNCILS}; #1 = best)")
    for label, val, rank, eng_val, src in [
        ("Life expectancy (years)", q.get("life_expectancy"), q.get("life_expectancy_rank"), eng.get("life_expectancy"), "ONS 2025"),
        ("GCSE Attainment 8 (points)", q.get("attainment8"), q.get("attainment8_rank"), eng.get("attainment8"), "DfE 2023/24"),
        ("Rent affordability (% of pay)", q.get("rent_affordability"), q.get("rent_affordability_rank"), eng.get("rent_affordability"), "ONS PIPR/ASHE"),
        ("Child poverty (%)", q.get("child_poverty_pct"), q.get("child_poverty_rank"), eng.get("child_poverty_pct"), "DWP"),
        ("Claimant rate (%)", q.get("claimant_rate_pct"), q.get("claimant_rate_rank"), eng.get("claimant_rate_pct"), "Nomis 2026"),
        ("Crime per 1,000 residents", q.get("crime_per_1000"), q.get("crime_rank"), eng.get("crime_per_1000"), "ONS CSP 2024"),
    ]:
        if val is None:
            continue
        parts = [f"{val}"]
        if rank is not None:
            parts.append(f"rank #{rank} of {N_COUNCILS}")
        if eng_val is not None:
            parts.append(f"median council {eng_val}")
        L.append(f"- {label}: {'; '.join(parts)} ({src})")
    L.append("- Note: crime per 1,000 residents is inflated in city/town centres by commuters, shoppers and nightlife (counted in offences, not residents).")
    L.append("")

    L.append("## Financial health (benchmarked)")
    if d.get("severity", 0) >= 2:
        L.append(f"- Distress: {d.get('distress_status')}")
        if d.get("is_efs") and d.get("efs_amount_gbp_m") is not None:
            L.append(f"- Exceptional Financial Support: £{d['efs_amount_gbp_m']}m")
    else:
        L.append("- Distress: no active Section 114 notice or EFS intervention")
    if b.get("per_resident") is not None:
        parts = [f"£{round(b['per_resident']):,} per resident"]
        if b.get("rank") is not None:
            parts.append(f"rank #{b['rank']} of {be.get('n', N_COUNCILS)} highest")
        if be.get("mean_per_resident") is not None:
            parts.append(f"England avg £{round(be['mean_per_resident']):,}")
        if be.get("median_per_resident") is not None:
            parts.append(f"England median £{round(be['median_per_resident']):,}")
        L.append(f"- Borrowing: {'; '.join(parts)}"
                 + (f" (total £{b['total_gbp_m']:.0f}m)" if b.get("total_gbp_m") is not None else ""))
        L.append("  (MHCLG Q1 2026/27; outstanding loans incl. PWLB/commercial, mixing General Fund and Housing Revenue Account debt — part is rent-serviced.)")
    L.append("")

    spends = money_rows(c)
    if spends:
        L.append("## Biggest service budgets (£ per resident)")
        for svc, per in spends:
            L.append(f"- {svc}: £{round(per):,}" if per is not None else f"- {svc}: n/a")
        L.append("")

    tvs = (c.get("talk_vs_spend") or {}).get("topics") or []
    if tvs:
        discretionary = {"Housing & Planning", "Transport & Highways", "Climate & Environment",
                         "Local Economy", "Health"}
        pool = [t for t in tvs if t.get("topic") in discretionary] or tvs
        gap = max(pool, key=lambda t: abs((t.get("spend_pct") or 0) - (t.get("discussion_pct") or 0)))
        L.append("## Committee scrutiny vs budget")
        L.append(f"- Biggest talk-vs-spend gap: {gap['topic']} takes {gap['spend_pct']:.0f}% of gross spend "
                 f"but {gap['discussion_pct']:.0f}% of committee debate.")
        L.append("  (Note: English councils spend most of their budgets on statutory adult/children's social care "
                 "and the ring-fenced schools grant, which committees do not set. The flag is drawn from "
                 "discretionary services; treat it as indicative.)")
        L.append("")

    contracts = c.get("contracts") or []
    if contracts:
        L.append("## Largest published contract awards (Contracts Finder, 2025–2026)")
        for r in contracts[:5]:
            val = r.get("value_gbp")
            val_s = f"£{val/1_000_000:.1f}m" if val else "n/a"
            n = int(r.get("n") or 0)
            line = (f"- {r.get('supplier')}: {val_s} across "
                    f"{'1 award' if n == 1 else str(n) + ' awards'}"
                    + (f" (latest {r.get('latest')})" if r.get("latest") else ""))
            if r.get("url"):
                line += f" — {r['url']}"
            L.append(line)
        L.append("")

    official = c.get("official_links") or []
    news = c.get("reading_links") or []
    if official or news:
        L.append("## Primary sources")
        L.append(f"- Full interactive profile: {SITE_URL}/?council={name.replace(' ', '%20')}#tab-council")
        for l in official:
            L.append(f"- {l['title']}: {l['url']}")
        for l in news:
            L.append(f"- {l['title']} ({l['source']}): {l['url']}")
        L.append("")

    L.append("## Ask")
    L.append("You are advising a local resident on this council. Using ONLY the verified figures and "
             "England benchmarks above:")
    L.append("1. Give three sharp, specific questions I can put to my councillor at their next surgery, "
             "grounded in the gap between this council and the England average or in its debt rank.")
    L.append("2. Identify the single biggest fiscal or governance risk visible in these figures, "
             "contrasting debt, budget concentration and outcomes against the benchmarks.")
    L.append("3. Summarise how this area compares with England overall, and flag where the "
             "commuter-inflation, discretionary-services or schools-grant caveats apply.")
    L.append("If a question needs data not provided here (such as usable reserves or inspection grades), "
             "say explicitly what is missing rather than guessing.")
    return "\n".join(L) + "\n"


count = 0
index_lines = ["# Council Receipts",
               "",
               f"Verified English local-government benchmarking data, {N_COUNCILS} councils.",
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
