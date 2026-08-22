"""Bake data/*.csv (+ data_fy1..7/*.csv) into site/data.json for the static HTML site.

Usage: python site/build.py   (run from anywhere — paths resolve off this file).

v4: the 2026 YTD corpus (data/doc_topics.csv) is retired from the UI. "What they
talk about" and "talk vs spend" both now read the matched FY2024-25 corpus —
the union of data_fy1..7/doc_topics.csv. New councils land purely via new
data_fyN/ folders; nothing here needs editing when they do.

Every input beyond data/councils.csv + data_fy*/doc_topics.csv is optional. If
it's missing, the panel it feeds is left out of data.json and app.js skips it.
Safe to re-run any time (idempotent, no side effects besides overwriting data.json).
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "data"
SITE_DIR = Path(__file__).parent

sys.path.insert(0, str(ROOT))
from taxonomy import TOPICS as TOPIC_KEYWORDS  # noqa: E402

NOTICE_PATTERN = r"(?i)\border\b|notice|traffic|speed limit|parking|prohibition|public path"

TOPICS = list(TOPIC_KEYWORDS.keys())
_SAFE = px.colors.qualitative.Safe
TOPIC_COLORS = {t: _SAFE[i] for i, t in enumerate(TOPICS)}
NEUTRAL_GREY = _SAFE[10]
TAXONOMY_EXAMPLES = {t: ", ".join(kws[:5]) for t, kws in TOPIC_KEYWORDS.items()}

# lifted from finance.py — service -> topic mapping used to restrict talk-vs-spend
# to topics that actually have a budget line.
SERVICE_TO_TOPIC = {
    "Education services": "Children & Education",
    "Highways and transport services": "Transport & Highways",
    "Children Social Care": "Children & Education",
    "Adult Social Care": "Social Care",
    "Public Health": "Health",
    "Housing services (GFRA only)": "Housing & Planning",
    "Cultural and related services": "Local Economy",
    "Environmental and regulatory services": "Climate & Environment",
    "Planning and development services": "Housing & Planning",
    "Police services": None,
    "Fire and rescue services": None,
    "Central services": None,
    "Other services": None,
    "Total Service Expenditure": None,
}
MATCHED_SPEND_TOPICS = sorted({t for t in SERVICE_TO_TOPIC.values() if t is not None})

# lifted from app.py, extended with the 6 new councils per v4 brief.
PREVIOUS_CONTROL = {
    "Kent": ("REF", "May 2025", "CON"),
    "Lancashire": ("REF", "May 2025", "CON"),
    # previous=None: Sheffield was already NOC before May 2025 — "LAB-led" is a
    # refinement, not a material change, so no "previously X" line should render.
    "Sheffield": ("NOC (LAB-led)", "May 2025", None),
    "Bristol": ("GRN-led NOC", "May 2024", "GRN-led NOC"),
    "Bradford": ("LAB", "May 2022", "LAB"),
    "Bromley": ("CON", "long-standing", "CON"),
    "Bath and North East Somerset": ("LD", "May 2019", "LD"),
    "Mid Suffolk": ("GRN", "May 2023", "CON"),
    "Tower Hamlets": ("Aspire", "May 2022", "LAB"),
    "Manchester": ("LAB", "long-standing", "LAB"),
    "Camden": ("LAB", "long-standing", "LAB"),
    "Bexley": ("CON", "since 2006", "CON"),
    "Hillingdon": ("CON", "since 2006", "CON"),
    "Somerset": ("LD", "May 2022", "CON"),
    # Leeds went NOC at the May 2026 elections — Labour minority admin, previously
    # Labour majority. Rendered the same way Sheffield's "NOC (LAB-led)" is.
    "Leeds": ("NOC (LAB-led)", "May 2026", "LAB"),
}

# National-view party buckets — coordinator-specified groupings (collapses
# NOC/composite labels, not a literal read of councils.csv `party`).
PARTY_BUCKETS = {
    "Labour": ["Bradford", "Leeds", "Manchester", "Camden"],
    "Conservative": ["Bromley", "Bexley", "Hillingdon"],
    "Liberal Democrat": ["Bath and North East Somerset", "Somerset"],
    "Reform UK": ["Kent", "Lancashire"],
    "Green": ["Bristol", "Mid Suffolk"],
    "Independent/Other": ["Sheffield", "Tower Hamlets"],
}

PARTY_NAMES = {
    "REF": "Reform UK", "CON": "Conservative", "LAB": "Labour",
    "LD": "Liberal Democrat", "GRN": "Green", "NOC": "No Overall Control",
    "IND": "Independent", "Aspire": "Aspire (local party)",
}

# scorecard metrics live on the site. aroad_delay (traffic) is back per v5 — the
# scorecard.csv rows may not have landed for all 15 yet; build_scorecard_ranks()
# only produces a metric if it's actually present in the data, so this degrades
# to 4 metrics automatically until aroad_delay rows land, then picks up 5.
SCORECARD_METRICS = ["attainment8", "co2_per_capita", "rent_affordability", "crime_per_1000", "aroad_delay"]
METRIC_LABELS = {
    "attainment8": "GCSE Attainment 8",
    "co2_per_capita": "CO2 per capita",
    "rent_affordability": "Rent affordability",
    "crime_per_1000": "Crime per 1,000",
    "aroad_delay": "A-road delay (secs/vehicle-mile)",
}
# metric -> whether a lower value ranks better (co2, crime, rent burden, delay).
LOWER_IS_BETTER = {
    "co2_per_capita": True, "crime_per_1000": True, "rent_affordability": True,
    "attainment8": False, "aroad_delay": True,
}

AGE_BAND_ORDER = ["0-15", "16-29", "30-44", "45-64", "65+"]


def spell_party(code):
    if not isinstance(code, str) or not code:
        return code
    out = code
    for acronym, name in sorted(PARTY_NAMES.items(), key=lambda kv: -len(kv[0])):
        out = re.sub(rf"\b{re.escape(acronym)}\b", name, out)
    return out


def read_csv_optional(path, **kwargs):
    try:
        return pd.read_csv(path, **kwargs)
    except FileNotFoundError:
        return None


def read_shard_csv(path):
    """Read a shard CSV defensively — a harvest still in progress can leave a
    partially-written or momentarily-missing file. Skip that shard cleanly rather
    than crashing the whole build."""
    if not path.exists():
        return None
    try:
        df = pd.read_csv(path)
    except (pd.errors.EmptyDataError, pd.errors.ParserError, OSError, ValueError) as e:
        print(f"  skipping incomplete shard {path}: {e}")
        return None
    if df.empty:
        return None
    return df


def load_councils():
    """Union of data/councils.csv + any data_fy1../councils.csv, deduped by id —
    picks up new councils automatically as their harvest folders land."""
    frames = [pd.read_csv(DATA_DIR / "councils.csv")]
    for i in range(1, 8):
        df = read_shard_csv(ROOT / f"data_fy{i}" / "councils.csv")
        if df is not None:
            frames.append(df)
    councils = pd.concat(frames, ignore_index=True).drop_duplicates(subset="id", keep="first")
    return councils.reset_index(drop=True)


def load_fy_corpus():
    """Union of whichever data_fy1..7/doc_topics.csv have landed cleanly. None if
    none yet. This is now the ONLY discussion corpus used on the site (2026 YTD
    retired). A shard dir that exists but isn't fully written yet (still
    harvesting) is skipped rather than failing the build."""
    frames = []
    for i in range(1, 8):
        df = read_shard_csv(ROOT / f"data_fy{i}" / "doc_topics.csv")
        if df is None:
            continue
        if "committee" in df.columns:
            df = df[~df["committee"].str.contains(NOTICE_PATTERN, na=False)]
        frames.append(df)
    if not frames:
        return None
    fy = pd.concat(frames, ignore_index=True)
    for t in TOPICS:
        if t not in fy.columns:
            fy[t] = 0
    return fy


def load_core():
    finance = read_csv_optional(DATA_DIR / "finance.csv")
    finance_topics = read_csv_optional(DATA_DIR / "finance_topics.csv")
    profile = read_csv_optional(DATA_DIR / "profile.csv")
    demographics = read_csv_optional(DATA_DIR / "demographics.csv")
    elections = read_csv_optional(DATA_DIR / "elections.csv")
    scorecard = read_csv_optional(DATA_DIR / "scorecard.csv")
    age_bands = read_csv_optional(DATA_DIR / "age_bands.csv")
    reading_links = read_csv_optional(DATA_DIR / "reading_links.csv")
    if scorecard is not None:
        scorecard = scorecard[scorecard["metric"].isin(SCORECARD_METRICS)].copy()
    return finance, finance_topics, profile, demographics, elections, scorecard, age_bands, reading_links


def topic_share_pct(df, restrict_to=None):
    cols = restrict_to if restrict_to else TOPICS
    cols = [c for c in cols if c in df.columns]
    if not cols:
        return None
    sums = df[cols].sum()
    total = sums.sum()
    if total <= 0:
        return None
    return (sums / total * 100).to_dict()


def build_money(finance, demographics, council_name):
    if finance is None or demographics is None:
        return None
    pop_row = demographics[demographics["council"] == council_name]
    cf = finance[finance["council"] == council_name]
    if pop_row.empty or cf.empty:
        return None
    pop = pop_row["population"].iloc[0]
    rows = cf.copy()
    rows["gbp_per_resident"] = rows["spend_gbp_thousands"] * 1000 / pop
    rows = rows.sort_values("gbp_per_resident", ascending=False)
    return [
        {"service": r["service"], "gbp_per_resident": round(r["gbp_per_resident"], 1)}
        for _, r in rows.iterrows()
    ]


def build_money_median(finance, demographics, council_names):
    if finance is None or demographics is None:
        return None, 0
    per_resident = []
    for cname in council_names:
        m = build_money(finance, demographics, cname)
        if m:
            per_resident.append(pd.DataFrame(m).assign(council=cname))
    if not per_resident:
        return None, 0
    all_money = pd.concat(per_resident, ignore_index=True)
    n = all_money["council"].nunique()
    median = all_money.groupby("service")["gbp_per_resident"].median().round(1)
    return median.to_dict(), n


def build_money_share(finance_topics, council_name):
    """Topic-level spend share for the money panel's "% share" toggle view —
    council's own share of spend by topic vs the England-average share, both
    already computed in finance_topics.csv (incl. its 'England average' row)."""
    if finance_topics is None:
        return None
    c = finance_topics[finance_topics["council"] == council_name]
    if c.empty:
        return None
    eng = finance_topics[finance_topics["council"] == "England average"]
    eng_map = eng.set_index("topic")["spend_share_pct"].to_dict()
    rows = c.sort_values("spend_share_pct", ascending=False)
    return [
        {"topic": r["topic"], "council_pct": round(r["spend_share_pct"], 1), "england_pct": round(eng_map.get(r["topic"], 0.0), 1)}
        for _, r in rows.iterrows()
    ]


def build_talk_vs_spend(fy_corpus, finance_topics, council_id, council_name):
    if fy_corpus is None or finance_topics is None:
        return None
    c_fy = fy_corpus[fy_corpus["council_id"] == council_id] if "council_id" in fy_corpus.columns else fy_corpus[fy_corpus.get("council") == council_name]
    if c_fy.empty:
        return None
    c_finance = finance_topics[
        (finance_topics["council"] == council_name) & (finance_topics["topic"].isin(MATCHED_SPEND_TOPICS))
    ]
    if c_finance.empty:
        return None
    matched = [t for t in MATCHED_SPEND_TOPICS if t in c_finance["topic"].values]
    discussion = topic_share_pct(c_fy, restrict_to=matched)
    if discussion is None:
        return None
    spend = c_finance.set_index("topic")["spend_share_pct"].to_dict()
    topics_out = [
        {"topic": t, "discussion_pct": round(discussion.get(t, 0.0), 1), "spend_pct": round(spend.get(t, 0.0), 1)}
        for t in matched
    ]
    note = None
    prev = PREVIOUS_CONTROL.get(council_name)
    if prev and prev[2] is not None and prev[0] != prev[2]:
        note = "spend committed under the previous administration"
    return {"topics": topics_out, "note": note}


def build_scorecard_ranks(scorecard):
    """metric -> {council: {value, rank, n}} plus england value per metric."""
    out = {}
    england = {}
    if scorecard is None:
        return out, england
    for metric, grp in scorecard.groupby("metric"):
        ranked = grp[grp["council"] != "England"].copy()
        lower_better = LOWER_IS_BETTER.get(metric, False)
        ranked["rank"] = ranked["value"].rank(ascending=lower_better, method="min")
        n = len(ranked)
        out[metric] = {
            r["council"]: {"value": r["value"], "rank": int(r["rank"]), "n": n, "proxy": bool(r.get("proxy", False)) if pd.notna(r.get("proxy", False)) else False,
                           "year": r.get("year"), "source": r.get("source")}
            for _, r in ranked.iterrows()
        }
        eng = grp[grp["council"] == "England"]
        england[metric] = eng["value"].iloc[0] if not eng.empty else None
    return out, england


def build_league_table(scorecard_ranks, england_vals, councils):
    metrics = [m for m in SCORECARD_METRICS if m in scorecard_ranks]
    rows = []
    for _, crow in councils.iterrows():
        cname = crow["name"]
        row = {"council": cname, "party": spell_party(crow["party"])}
        for m in metrics:
            hit = scorecard_ranks.get(m, {}).get(cname)
            row[m] = hit["value"] if hit else None
            row[f"{m}_rank"] = hit["rank"] if hit else None
            row[f"{m}_n"] = hit["n"] if hit else None
        rows.append(row)
    return {"metrics": metrics, "metric_labels": METRIC_LABELS, "england": england_vals, "rows": rows}


def build_party_groups(share_lookup, councils_in_data, label_key="spend_share"):
    """share_lookup: {council_name: {topic: pct}}. Returns per-bucket equal-weighted
    mean over whichever bucket members are actually present in share_lookup."""
    groups = []
    for party, names in PARTY_BUCKETS.items():
        present = [n for n in names if n in share_lookup]
        if not present:
            continue
        series = [pd.Series(share_lookup[n]) for n in present]
        mean_share = pd.concat(series, axis=1).mean(axis=1).round(1).to_dict()
        groups.append({"party": party, "n": len(present), "councils": present, label_key: mean_share})
    return groups


def main():
    councils = load_councils()
    fy_corpus = load_fy_corpus()
    finance, finance_topics, profile, demographics, elections, scorecard, age_bands, reading_links = load_core()

    council_names = sorted(councils["name"])

    # -- FY-corpus topic shares per council, and the equal-weighted corpus avg ---
    council_shares = {}
    for cname in council_names:
        cid = councils.loc[councils["name"] == cname, "id"].iloc[0]
        if fy_corpus is not None:
            c_fy = fy_corpus[fy_corpus["council_id"] == cid]
            s = topic_share_pct(c_fy)
            if s:
                council_shares[cname] = s
    corpus_avg = (
        pd.concat([pd.Series(s) for s in council_shares.values()], axis=1).mean(axis=1).round(1).to_dict()
        if council_shares else {}
    )

    money_median, money_median_n = build_money_median(finance, demographics, council_names)

    # -- age bands: pyramid (needs `sex` col) or paired-bars fallback ------------
    age_bands_mode = None
    age_bands_by_council = {}
    age_pyramid_england = None
    age_bands_england = None
    if age_bands is not None and "sex" in age_bands.columns:
        age_bands_mode = "pyramid"
        for cname in list(council_names) + ["England"]:
            a = age_bands[age_bands["council"] == cname]
            if a.empty:
                continue
            pyramid = {}
            for band in AGE_BAND_ORDER:
                b = a[a["band"] == band]
                if b.empty:
                    continue
                pyramid[band] = {
                    "male": b.loc[b["sex"] == "male", "pct"].sum(),
                    "female": b.loc[b["sex"] == "female", "pct"].sum(),
                }
            if pyramid:
                if cname == "England":
                    age_pyramid_england = pyramid
                else:
                    age_bands_by_council[cname] = pyramid
    elif age_bands is not None:
        age_bands_mode = "paired"
        eng = age_bands[age_bands["council"] == "England"]
        if not eng.empty:
            age_bands_england = eng.set_index("band")["pct"].to_dict()
        for cname in council_names:
            a = age_bands[age_bands["council"] == cname]
            if not a.empty:
                age_bands_by_council[cname] = a.set_index("band")["pct"].to_dict()

    scorecard_ranks, england_vals = build_scorecard_ranks(scorecard)
    league_table = build_league_table(scorecard_ranks, england_vals, councils)

    party_groups_spend = build_party_groups(
        {c: finance_topics[finance_topics["council"] == c].set_index("topic")["spend_share_pct"].to_dict()
         for c in council_names if finance_topics is not None and not finance_topics[finance_topics["council"] == c].empty},
        council_names, "spend_share",
    ) if finance_topics is not None else None
    party_groups_discussion = build_party_groups(council_shares, council_names, "discussion_share")

    out_councils = {}
    for _, crow in councils.iterrows():
        cid, cname = crow["id"], crow["name"]

        prev = PREVIOUS_CONTROL.get(cname)
        control = None
        if prev:
            current, since, previous = prev
            control = {
                "current": spell_party(current), "since": since,
                "previous": spell_party(previous),
                "changed": previous is not None and current != previous,
            }

        elec = None
        if elections is not None:
            e = elections[elections["council"] == cname].sort_values("poll_date")
            if not e.empty:
                elec = {"title": e.iloc[0]["title"], "poll_date": e.iloc[0]["poll_date"]}

        population = None
        if demographics is not None:
            d = demographics[demographics["council"] == cname]
            if not d.empty:
                population = int(d["population"].iloc[0])

        ethnicity = None
        if profile is not None:
            p = profile[profile["council"] == cname]
            if not p.empty:
                p = p.iloc[0]
                if pd.notna(p.get("white_pct")):
                    ethnicity = {
                        "White": p.get("white_pct"), "Asian": p.get("asian_pct"),
                        "Black": p.get("black_pct"), "Mixed": p.get("mixed_pct"),
                        "Other": p.get("other_pct"),
                    }
        ethnicity_england = None
        if profile is not None:
            pe = profile[profile["council"] == "England"]
            if not pe.empty:
                pe = pe.iloc[0]
                if pd.notna(pe.get("white_pct")):
                    ethnicity_england = {
                        "White": pe.get("white_pct"), "Asian": pe.get("asian_pct"),
                        "Black": pe.get("black_pct"), "Mixed": pe.get("mixed_pct"),
                        "Other": pe.get("other_pct"),
                    }

        money = build_money(finance, demographics, cname)
        money_share = build_money_share(finance_topics, cname)
        tvs = build_talk_vs_spend(fy_corpus, finance_topics, cid, cname)

        sc_row = []
        for m in SCORECARD_METRICS:
            hit = scorecard_ranks.get(m, {}).get(cname)
            if hit:
                sc_row.append({
                    "metric": m, "label": METRIC_LABELS[m], "value": hit["value"],
                    "rank": hit["rank"], "n": hit["n"], "proxy": hit["proxy"],
                    "year": hit["year"], "source": hit["source"],
                    "england_value": england_vals.get(m),
                    "lower_is_better": LOWER_IS_BETTER.get(m, False),
                })

        links = []
        if reading_links is not None:
            rl = reading_links[reading_links["council"] == cname].head(3)
            links = rl[["title", "url", "source"]].to_dict("records")

        out_councils[cname] = {
            "id": int(cid),
            "party": crow["party"],
            "party_full": spell_party(crow["party"]),
            "control": control,
            "election": elec,
            "population": population,
            "ethnicity": ethnicity,
            "ethnicity_england": ethnicity_england,
            "topic_share": {k: round(v, 1) for k, v in council_shares.get(cname, {}).items()} or None,
            "age_bands": age_bands_by_council.get(cname),
            "money": money,
            "money_share": money_share,
            "talk_vs_spend": tvs,
            "scorecard": sc_row,
            "reading_links": links,
        }

    data = {
        "topics": TOPICS,
        "topic_colors": TOPIC_COLORS,
        "neutral_grey": NEUTRAL_GREY,
        "taxonomy_examples": TAXONOMY_EXAMPLES,
        "corpus_avg_topic_share": corpus_avg,
        "money_median_per_resident": money_median,
        "money_median_n": money_median_n,
        "age_bands_mode": age_bands_mode,
        "age_bands_order": AGE_BAND_ORDER,
        "age_bands_england": age_bands_england,
        "age_pyramid_england": age_pyramid_england,
        "party_groups_spend": party_groups_spend,
        "party_groups_discussion": party_groups_discussion,
        "league_table": league_table,
        "councils": out_councils,
    }

    def clean(obj):
        if isinstance(obj, dict):
            return {k: clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [clean(v) for v in obj]
        if isinstance(obj, (np.integer, np.floating)):
            obj = obj.item()
        if isinstance(obj, float) and pd.isna(obj):
            return None
        try:
            if pd.isna(obj):
                return None
        except (TypeError, ValueError):
            pass
        return obj

    data = clean(data)

    out_path = SITE_DIR / "data.json"
    out_path.write_text(json.dumps(data, indent=None, default=str), encoding="utf-8")

    panel_counts = {
        "councils": len(out_councils),
        "fy_corpus_loaded": fy_corpus is not None,
        "with_topic_share": sum(1 for c in out_councils.values() if c["topic_share"]),
        "with_population": sum(1 for c in out_councils.values() if c["population"] is not None),
        "with_ethnicity": sum(1 for c in out_councils.values() if c["ethnicity"]),
        "with_age_bands": sum(1 for c in out_councils.values() if c["age_bands"]),
        "age_bands_mode": age_bands_mode,
        "with_money": sum(1 for c in out_councils.values() if c["money"]),
        "with_money_share": sum(1 for c in out_councils.values() if c["money_share"]),
        "with_talk_vs_spend": sum(1 for c in out_councils.values() if c["talk_vs_spend"]),
        "with_scorecard": sum(1 for c in out_councils.values() if c["scorecard"]),
        "with_reading_links": sum(1 for c in out_councils.values() if c["reading_links"]),
        "party_groups_spend": len(party_groups_spend) if party_groups_spend else 0,
        "party_groups_discussion": len(party_groups_discussion) if party_groups_discussion else 0,
        "league_table_metrics": len(league_table["metrics"]),
    }
    print(f"wrote {out_path} -- {panel_counts}")


if __name__ == "__main__":
    main()
