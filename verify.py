"""Preflight integrity checks for the baked site data.

Runs after site/build.py + site/build_search.py. Exits non-zero (with a readable
report) if any invariant fails, so a broken build never gets deployed.

Usage: python site/verify.py
"""
import json
import re
import sys
from pathlib import Path

SITE = Path(__file__).parent
ROOT = SITE.parent
ONS_RE = re.compile(r"^E\d{8}$")

FAILURES = []
WARNINGS = []


def check(cond, msg):
    if cond:
        print(f"  ok   {msg}")
    else:
        FAILURES.append(msg)
        print(f"  FAIL {msg}")


def warn(cond, msg):
    if not cond:
        WARNINGS.append(msg)
        print(f"  warn {msg}")


def main():
    print("Verifying site/data.json ...")
    data = json.loads((SITE / "data.json").read_text())
    councils = data.get("councils", {})

    check(len(councils) >= 283, f">=283 councils in registry (got {len(councils)})")
    check(all(ONS_RE.match(c.get("ons_code", "")) for c in councils.values()),
          "every council has a valid ONS LAD code")

    def count(field, truthy=True):
        return sum(1 for c in councils.values() if (bool(c.get(field)) if truthy else c.get(field) is not None))

    n_reg = len(councils)
    check(count("borrowing") == n_reg, f"borrowing data for all {n_reg} (got {count('borrowing')})")
    check(count("money") >= 275, f"finance data for >=275 councils (got {count('money')})")
    check(count("topic_share") >= 230, f"topic share for >=230 councils (got {count('topic_share')})")
    cw = data.get("corpus_window")
    check(bool(cw) and cw.get("label") and cw.get("docs", 0) > 0,
          "discussion corpus window + doc count present")
    check(data.get("league_table", {}).get("rows") and len(data["league_table"]["rows"]) == n_reg,
          f"league table has {n_reg} rows")

    # contract awards must be recency-windowed (2025+) and deep-link to /Notice/{id}
    contract_rows = [r for c in councils.values() for r in (c.get("contracts") or [])]
    check(all((r.get("latest") or "9999") >= "2025-01-01" for r in contract_rows),
          "all contract awards dated 2025 or later")
    check(all("/Notice/" in (r.get("url") or "") for r in contract_rows),
          "contract links point at human /Notice/{id} pages")
    check(all(re.fullmatch(r"https://www\.contractsfinder\.service\.gov\.uk/Notice/[0-9a-fA-F-]{36}",
                            r.get("url") or "")
              for r in contract_rows),
          "every contract link is a well-formed /Notice/{uuid}")

    # no stale elections: every advertised poll must be today or later
    today = __import__("datetime").date.today().isoformat()
    upstream = __import__("csv").DictReader(
        open(ROOT / "data" / "elections.csv", encoding="utf-8")) if (ROOT / "data" / "elections.csv").exists() else []
    check(all((r.get("poll_date") or "") >= today for r in upstream),
          "no already-closed election in data/elections.csv")

    # the static methodology page must not drift from the baked peer benchmarks
    html = (SITE / "index.html").read_text()
    qeng = data.get("qol_benchmark") or data.get("qol_england") or {}
    for sid, key, dp in [
        ("method-eng-le", "life_expectancy", 1), ("method-eng-att8", "attainment8", 1),
        ("method-eng-rent", "rent_affordability", 1), ("method-eng-aq", "air_quality_pm25_pct", 2),
        ("method-eng-cp", "child_poverty_pct", 1), ("method-eng-claim", "claimant_rate_pct", 1),
        ("method-eng-crime", "crime_per_1000", 1),
    ]:
        m = re.search(r'id="' + sid + r'">([^<]+)<', html)
        val = qeng.get(key)
        check(m is not None and val is not None and m.group(1).strip() == f"{float(val):.{dp}f}",
              f"methodology England value {sid} matches data ({m.group(1).strip() if m else 'missing'})")

    # party_by_tier present and populated for the comparison tiers
    pbt = data.get("party_by_tier") or {}
    for tk in ("single", "district", "county"):
        grp = pbt.get(tk, {}).get("spend") or []
        check(len(grp) > 0, f"party_by_tier[{tk}] spend groups present")

    # sanity: no negative populations, no negative debt
    bad_pop = [n for n, c in councils.items() if c.get("population") is not None and c["population"] < 0]
    check(not bad_pop, "no negative populations")
    bad_debt = [n for n, c in councils.items() if c.get("borrowing") and c["borrowing"].get("total_gbp_m", 0) < 0]
    check(not bad_debt, "no negative borrowing totals")

    # six formerly-missing councils must now carry discussion data
    for nm in ["Leeds", "Manchester", "Camden", "Bexley", "Hillingdon", "Somerset"]:
        c = councils.get(nm)
        check(c is not None and bool(c.get("topic_share")), f"{nm} has topic discussion data")

    print("Verifying search indexes ...")
    idx_dir = SITE / "search_index"
    n_files = len(list(idx_dir.glob("*.json"))) if idx_dir.exists() else 0
    check(n_files >= 220, f"per-council search indexes present (got {n_files})")
    gi = SITE / "search_index_global.json"
    check(gi.exists(), "global cross-council search index present")
    if gi.exists():
        size_mb = gi.stat().st_size / 1_000_000
        tokens = len(json.loads(gi.read_text()))
        check(tokens > 10000, f"global index has substantial tokens (got {tokens})")
        warn(size_mb < 12, f"global index size is {size_mb:.1f} MB (large; consider trimming)")

    print()
    if FAILURES:
        print(f"VERIFY FAILED — {len(FAILURES)} invariant(s) broken:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print(f"VERIFY PASSED ({len(WARNINGS)} warning(s))")


if __name__ == "__main__":
    main()
