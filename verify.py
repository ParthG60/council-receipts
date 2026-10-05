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

    check(len(councils) == 282, f"282 councils in registry (got {len(councils)})")
    check(all(ONS_RE.match(c.get("ons_code", "")) for c in councils.values()),
          "every council has a valid ONS LAD code")

    def count(field, truthy=True):
        return sum(1 for c in councils.values() if (bool(c.get(field)) if truthy else c.get(field) is not None))

    check(count("borrowing") == 282, f"borrowing data for all 282 (got {count('borrowing')})")
    check(count("money") >= 275, f"finance data for >=275 councils (got {count('money')})")
    check(count("topic_share") >= 230, f"topic share for >=230 councils (got {count('topic_share')})")
    cw = data.get("corpus_window")
    check(bool(cw) and cw.get("label") and cw.get("docs", 0) > 0,
          "discussion corpus window + doc count present")
    check(data.get("league_table", {}).get("rows") and len(data["league_table"]["rows"]) == 282,
          "league table has 282 rows")

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
