"""Shared helpers for the site build scripts.

Single source of truth for the council registry so build.py and build_search.py
never drift. The registry key is the ONS LAD code; the corpus join key is the
Council Gateway council_id.

The Gateway ids for the original hack-day 15 come from data/councils.csv, and for
Leeds/Manchester/Camden/Bexley/Hillingdon/Somerset from data_fy5..7/councils.csv
(scorecard_imd.csv leaves their gateway_id blank).
"""
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
ENG_DIR = ROOT / "data_england"


def _all_gateway_names():
    """name -> gateway id, merged across every per-shard councils.csv."""
    name_to_id = {}
    for path in [DATA_DIR / "councils.csv"] + sorted(ROOT.glob("data_fy*/councils.csv")):
        if not path.exists():
            continue
        df = pd.read_csv(path)
        if "name" not in df.columns or "id" not in df.columns:
            continue
        for _, r in df.iterrows():
            name_to_id[str(r["name"]).strip()] = r["id"]
    return name_to_id


def load_registry():
    """ons_code -> {name, tier, council_id}. Master list from scorecard_imd.csv;
    council_id backfilled from the per-shard councils.csv files where blank."""
    imd = pd.read_csv(ENG_DIR / "scorecard_imd.csv")
    reg_rows = imd.drop_duplicates("ons_code")[["ons_code", "council", "tier", "gateway_id"]]
    name_to_id = _all_gateway_names()

    reg = {}
    missing = []
    for _, r in reg_rows.iterrows():
        code = r["ons_code"]
        gid = r["gateway_id"]
        if pd.notna(gid) and str(gid).strip() not in ("", "nan"):
            cid = int(float(gid))
        else:
            cid = name_to_id.get(str(r["council"]).strip())
            cid = int(cid) if cid is not None else None
            if cid is None:
                missing.append(r["council"])
        reg[code] = {"name": r["council"], "tier": r["tier"], "council_id": cid}
    if missing:
        print(f"  WARNING: {len(missing)} councils have no gateway id: {missing}")
    return reg
