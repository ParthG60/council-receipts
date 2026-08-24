"""Bake the all-England corpus + reference data into site/data.json.

v5 (all-England): the site now covers every English council in the Council Gateway
(282 = 267 harvested into data_england/c<id>/ + the original 15 in data_fy1..7/).
The universal join key is the ONS LAD code. data_england/scorecard_imd.csv is the
master registry (one row per council per IMD domain; distinct ons_code = the 282).

Sources, all joined on ons_code unless noted:
  - discussion corpus : data_fy1..7/doc_topics.csv + data_england/c*/doc_topics.csv
                        (joined council_id -> ons_code; duplicate gateway ids for
                        the same ons_code are summed)
  - finance (£/res)   : data_england/finance_all.csv  + population_all.csv  (all 282)
  - deprivation       : data_england/scorecard_imd.csv (IoD2025, 8 domains)
  - control / party   : data_england/control_all.csv   (Open Council Data UK, 2026)
  - ethnicity/age%    : data_england/profile_all.csv (267) + data/profile.csv (15 + England)
  - age pyramid       : data/age_bands.csv        (original 15 + England only)
  - reading links     : data/reading_links.csv    (original 15 only)
  - election banner    : data/elections.csv        (original 15 only)

Every panel degrades: a council with no input for a panel is simply omitted from it.
Reads only; writes only site/data.json. Idempotent. Run: python site/build.py
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
ENG_DIR = ROOT / "data_england"
SITE_DIR = Path(__file__).parent

sys.path.insert(0, str(ROOT))
from taxonomy import TOPICS as TOPIC_KEYWORDS  # noqa: E402

NOTICE_PATTERN = r"(?i)\border\b|notice|traffic|speed limit|parking|prohibition|public path"

TOPICS = list(TOPIC_KEYWORDS.keys())
_SAFE = px.colors.qualitative.Safe
TOPIC_COLORS = {t: _SAFE[i] for i, t in enumerate(TOPICS)}
NEUTRAL_GREY = _SAFE[10]
TAXONOMY_EXAMPLES = {t: ", ".join(kws[:5]) for t, kws in TOPIC_KEYWORDS.items()}

# service -> topic mapping used to restrict talk-vs-spend to topics with a budget line.
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
}
MATCHED_SPEND_TOPICS = sorted(set(SERVICE_TO_TOPIC.values()))

# IoD2025 deprivation domains (scorecard_imd.csv) and their reader-facing labels.
DOMAINS = ["IMD", "Income", "Employment", "Education", "Health", "Crime", "Barriers", "Living"]
DOMAIN_LABELS = {
    "IMD": "Overall deprivation",
    "Income": "Income",
    "Employment": "Employment",
    "Education": "Education & skills",
    "Health": "Health & disability",
    "Crime": "Crime",
    "Barriers": "Barriers to housing & services",
    "Living": "Living environment",
}
# fixed National-view bucket order (matches control_all.py buckets, excludes Independent/Other)
BUCKET_ORDER = ["Labour", "Conservative", "Liberal Democrat", "Reform UK", "Green"]

AGE_BAND_ORDER = ["0-15", "16-29", "30-44", "45-64", "65+"]

# the original 15 (harvested into data_fy*): name -> ons_code. Their gateway_id is
# blank in scorecard_imd.csv, so their corpus council_id comes from data/councils.csv.
ORIGINAL_15 = {
    "Bradford": "E08000032", "Bristol": "E06000023", "Sheffield": "E08000019",
    "Kent": "E10000016", "Bromley": "E09000006", "Bath and North East Somerset": "E06000022",
    "Mid Suffolk": "E07000203", "Tower Hamlets": "E09000030", "Lancashire": "E10000017",
    "Leeds": "E08000035", "Manchester": "E08000003", "Camden": "E09000007",
    "Bexley": "E09000004", "Hillingdon": "E09000017", "Somerset": "E06000066",
}


def read_csv_optional(path, **kwargs):
    try:
        return pd.read_csv(path, **kwargs)
    except FileNotFoundError:
        return None


def read_shard_csv(path):
    if not path.exists():
        return None
    try:
        df = pd.read_csv(path)
    except (pd.errors.EmptyDataError, pd.errors.ParserError, OSError, ValueError) as e:
        print(f"  skipping incomplete shard {path}: {e}")
        return None
    return None if df.empty else df


# ------------------------------------------------------------------ registry ---
def load_registry():
    """Master council list from scorecard_imd.csv (distinct ons_code) -> dict
    ons_code -> {name, tier, council_id}. council_id (gateway id, for the corpus
    join) comes from scorecard_imd for the 267 and from data/councils.csv for the 15."""
    imd = pd.read_csv(ENG_DIR / "scorecard_imd.csv")
    reg_rows = imd.drop_duplicates("ons_code")[["ons_code", "council", "tier", "gateway_id"]]

    old = pd.read_csv(DATA_DIR / "councils.csv")
    name_to_id = dict(zip(old["name"], old["id"]))

    reg = {}
    for _, r in reg_rows.iterrows():
        code = r["ons_code"]
        gid = r["gateway_id"]
        if pd.notna(gid) and str(gid).strip() not in ("", "nan"):
            cid = int(float(gid))
        else:  # original 15 -> data/councils.csv id
            cid = name_to_id.get(r["council"])
            cid = int(cid) if cid is not None else None
        reg[code] = {"name": r["council"], "tier": r["tier"], "council_id": cid}
    return reg


# -------------------------------------------------------------------- corpus ---
def load_corpus_by_ons(id2ons):
    """Union every doc_topics shard, map council_id -> ons_code, drop unmapped
    rows, sum topic hits per ons_code. Returns {ons_code: {topic: pct}}."""
    frames = []
    for i in range(1, 8):
        df = read_shard_csv(ROOT / f"data_fy{i}" / "doc_topics.csv")
        if df is not None:
            frames.append(df)
    for d in sorted(ENG_DIR.glob("c*/doc_topics.csv")):
        df = read_shard_csv(d)
        if df is not None:
            frames.append(df)
    if not frames:
        return {}
    corpus = pd.concat(frames, ignore_index=True)
    if "committee" in corpus.columns:
        corpus = corpus[~corpus["committee"].str.contains(NOTICE_PATTERN, na=False)]
    for t in TOPICS:
        if t not in corpus.columns:
            corpus[t] = 0
    corpus["ons_code"] = corpus["council_id"].map(id2ons)
    corpus = corpus[corpus["ons_code"].notna()]
    sums = corpus.groupby("ons_code")[TOPICS].sum()
    shares = {}
    for code, row in sums.iterrows():
        total = row.sum()
        if total > 0:
            shares[code] = (row / total * 100).round(1).to_dict()
    return shares


# ------------------------------------------------------------------- finance ---
def load_finance_by_ons():
    """{ons_code: {service: spend_gbp_thousands}} from finance_all.csv (all 282)."""
    fa = pd.read_csv(ENG_DIR / "finance_all.csv")
    # suppressed values ('[x]') and any non-numeric -> dropped (drop-don't-fake)
    fa["spend_gbp_thousands"] = pd.to_numeric(fa["spend_gbp_thousands"], errors="coerce")
    fa = fa[fa["spend_gbp_thousands"].notna()]
    out = {}
    for code, grp in fa.groupby("ons_code"):
        out[code] = dict(zip(grp["service"], grp["spend_gbp_thousands"]))
    return out


def money_per_resident(services, pop):
    if not services or not pop:
        return None
    rows = [{"service": s, "gbp_per_resident": round(v * 1000 / pop, 1)} for s, v in services.items()]
    rows.sort(key=lambda r: -r["gbp_per_resident"])
    return rows


def finance_topic_shares(services):
    """Council's spend share across the 7 matched topics, from its service spend."""
    if not services:
        return None
    by_topic = {}
    for svc, spend in services.items():
        topic = SERVICE_TO_TOPIC.get(svc)
        if topic:
            by_topic[topic] = by_topic.get(topic, 0) + spend
    total = sum(by_topic.values())
    if total <= 0:
        return None
    return {t: round(by_topic[t] / total * 100, 1) for t in by_topic}


# ---------------------------------------------------------------- deprivation ---
def load_scorecard(reg):
    """{ons_code: [8 domain dicts]} from scorecard_imd.csv, in DOMAIN order."""
    imd = pd.read_csv(ENG_DIR / "scorecard_imd.csv")
    out = {}
    for code, grp in imd.groupby("ons_code"):
        g = grp.set_index("domain")
        row = []
        for dom in DOMAINS:
            if dom not in g.index:
                continue
            d = g.loc[dom]
            row.append({
                "domain": dom, "label": DOMAIN_LABELS[dom],
                "rank": int(d["rank"]), "pool_n": int(d["pool_n"]), "tier": d["tier"],
                "decile": int(d["decile"]), "score": float(d["score"]), "prop10": float(d["prop10"]),
            })
        out[code] = row
    return out


# -------------------------------------------------------------------- control ---
def load_control():
    """{ons_code: {current, since, since_year, previous, changed, bucket}}."""
    df = read_csv_optional(ENG_DIR / "control_all.csv")
    if df is None:
        return {}
    out = {}
    for _, r in df.iterrows():
        yr = int(r["since_year"])
        since = "2016 or earlier" if yr <= 2016 else str(yr)
        changed = bool(r["changed"])
        out[r["ons_code"]] = {
            "current": r["control_label"], "since": since, "since_year": yr,
            "previous": r["previous_label"] if changed and r["previous_label"] else None,
            "changed": changed, "bucket": r["bucket"],
        }
    return out


# ----------------------------------------------------------------- aggregates ---
def party_groups(share_lookup, bucket_of, label_key):
    """Equal-weighted mean share per control bucket over members present in share_lookup."""
    groups = []
    for bucket in BUCKET_ORDER:
        members = [n for n in share_lookup if bucket_of.get(n) == bucket]
        if not members:
            continue
        series = [pd.Series(share_lookup[n]) for n in members]
        mean_share = pd.concat(series, axis=1).mean(axis=1).round(1).to_dict()
        groups.append({"party": bucket, "n": len(members), "councils": sorted(members), label_key: mean_share})
    return groups


def main():
    reg = load_registry()
    id2ons = {r["council_id"]: code for code, r in reg.items() if r["council_id"] is not None}

    corpus_shares = load_corpus_by_ons(id2ons)                 # ons -> {topic: pct}
    finance_by_ons = load_finance_by_ons()                     # ons -> {service: spend_k}
    scorecard = load_scorecard(reg)                            # ons -> [8 domains]
    control = load_control()                                   # ons -> {...}

    pop_df = read_csv_optional(ENG_DIR / "population_all.csv")
    population = dict(zip(pop_df["ons_code"], pop_df["population"])) if pop_df is not None else {}

    # ethnicity/age%: profile_all (267, by ons) + data/profile.csv (15 + England, by name)
    profile_all = read_csv_optional(ENG_DIR / "profile_all.csv")
    profile_old = read_csv_optional(DATA_DIR / "profile.csv")
    eth_by_ons = {}
    if profile_all is not None:
        for _, p in profile_all.iterrows():
            if pd.notna(p.get("white_pct")):
                eth_by_ons[p["ons_code"]] = {"White": p["white_pct"], "Asian": p["asian_pct"],
                                             "Black": p["black_pct"], "Mixed": p["mixed_pct"], "Other": p["other_pct"]}
    eth_by_name = {}
    ethnicity_england = None
    if profile_old is not None:
        for _, p in profile_old.iterrows():
            if pd.notna(p.get("white_pct")):
                e = {"White": p["white_pct"], "Asian": p["asian_pct"], "Black": p["black_pct"],
                     "Mixed": p["mixed_pct"], "Other": p["other_pct"]}
                if p["council"] == "England":
                    ethnicity_england = e
                else:
                    eth_by_name[p["council"]] = e

    elections = read_csv_optional(DATA_DIR / "elections.csv")
    reading_links = read_csv_optional(DATA_DIR / "reading_links.csv")
    age_bands = read_csv_optional(ENG_DIR / "age_bands_all.csv")
    if age_bands is None:
        age_bands = read_csv_optional(DATA_DIR / "age_bands.csv")

    # ---- Quality of Life (QoL) & Financial Distress datasets ----------------
    qol_df = read_csv_optional(ENG_DIR / "qol_all.csv")
    qol_by_code = {}
    qol_england = {}
    if qol_df is not None:
        eng_row = qol_df[qol_df["ons_code"] == "E92000001"]
        if not eng_row.empty:
            er = eng_row.iloc[0]
            qol_england = {
                "life_expectancy": er["life_expectancy"],
                "rent_affordability": er["rent_affordability"],
                "air_quality_pm25_pct": er["air_quality_pm25_pct"],
                "child_poverty_pct": er["child_poverty_pct"],
                "claimant_rate_pct": er["claimant_rate_pct"],
                "crime_per_1000": er["crime_per_1000"],
            }
        for _, qr in qol_df.iterrows():
            code = qr["ons_code"]
            if code == "E92000001":
                continue
            qol_by_code[code] = {
                "life_expectancy": qr["life_expectancy"],
                "rent_affordability": qr["rent_affordability"],
                "air_quality_pm25_pct": qr["air_quality_pm25_pct"],
                "child_poverty_pct": qr["child_poverty_pct"],
                "claimant_rate_pct": qr["claimant_rate_pct"],
                "crime_per_1000": qr["crime_per_1000"],
                "overall_imd": {
                    "score": qr["imd_score"],
                    "decile": int(qr["imd_decile"]) if pd.notna(qr["imd_decile"]) else None,
                    "rank": int(qr["imd_rank"]) if pd.notna(qr["imd_rank"]) else None,
                    "pool_n": int(qr["imd_pool_n"]) if pd.notna(qr["imd_pool_n"]) else None,
                    "tier": qr["imd_tier"],
                    "national_rank": int(qr["imd_national_rank"]) if pd.notna(qr["imd_national_rank"]) else None,
                } if pd.notna(qr["imd_score"]) else None
            }

    distress_df = read_csv_optional(ENG_DIR / "financial_distress.csv")
    distress_by_code = {}
    distress_watchlist = []
    if distress_df is not None:
        for _, dr in distress_df.iterrows():
            code = dr["ons_code"]
            d_rec = {
                "is_s114": bool(dr["is_s114"]),
                "s114_year": int(dr["s114_year"]) if pd.notna(dr["s114_year"]) else None,
                "s114_details": dr["s114_details"] if pd.notna(dr["s114_details"]) else "",
                "is_efs": bool(dr["is_efs"]),
                "efs_amount_gbp_m": float(dr["efs_amount_gbp_m"]) if pd.notna(dr["efs_amount_gbp_m"]) else None,
                "efs_details": dr["efs_details"] if pd.notna(dr["efs_details"]) else "",
                "is_audit_delayed": bool(dr["is_audit_delayed"]),
                "distress_status": dr["distress_status"],
                "severity": int(dr["severity"]),
            }
            distress_by_code[code] = d_rec
            if d_rec["severity"] > 0:
                distress_watchlist.append({
                    "council": dr["council"],
                    "ons_code": code,
                    "status": dr["distress_status"],
                    "severity": d_rec["severity"],
                    "efs_m": d_rec["efs_amount_gbp_m"],
                    "s114_year": d_rec["s114_year"],
                })
        distress_watchlist.sort(key=lambda x: -x["severity"])

    # ---- per-council derived: money, money_share, talk_vs_spend, topic_share ----
    council_names = sorted(r["name"] for r in reg.values())
    name2ons = {r["name"]: code for code, r in reg.items()}

    topic_share = {code: corpus_shares.get(code) for code in reg}
    money = {}
    ft_shares = {}   # name -> {topic: pct}
    for code, r in reg.items():
        money[code] = money_per_resident(finance_by_ons.get(code), population.get(code))
        fts = finance_topic_shares(finance_by_ons.get(code))
        if fts:
            ft_shares[r["name"]] = fts

    # England-average topic spend share (equal-weighted over all councils) & corpus avg
    ft_england = (pd.concat([pd.Series(s) for s in ft_shares.values()], axis=1).mean(axis=1).round(1).to_dict()
                  if ft_shares else {})
    corpus_avg = (pd.concat([pd.Series(corpus_shares[c]) for c in corpus_shares], axis=1).mean(axis=1).round(1).to_dict()
                  if corpus_shares else {})

    # money median per resident across all councils that have money
    money_frames = [pd.DataFrame(m) for m in money.values() if m]
    if money_frames:
        allm = pd.concat(money_frames, ignore_index=True)
        money_median = allm.groupby("service")["gbp_per_resident"].median().round(1).to_dict()
        money_median_n = len(money_frames)
    else:
        money_median, money_median_n = None, 0

    # ---- age bands (original 15 + England only) --------------------------------
    age_mode = age_pyramid_england = age_bands_england = None
    age_by_name = {}
    if age_bands is not None and "sex" in age_bands.columns:
        age_mode = "pyramid"
        for cname in council_names + ["England"]:
            a = age_bands[age_bands["council"] == cname]
            if a.empty:
                continue
            pyr = {}
            for band in AGE_BAND_ORDER:
                b = a[a["band"] == band]
                if not b.empty:
                    pyr[band] = {"male": b.loc[b["sex"] == "male", "pct"].sum(),
                                 "female": b.loc[b["sex"] == "female", "pct"].sum()}
            if pyr:
                if cname == "England":
                    age_pyramid_england = pyr
                else:
                    age_by_name[cname] = pyr
    elif age_bands is not None:
        age_mode = "paired"
        eng = age_bands[age_bands["council"] == "England"]
        if not eng.empty:
            age_bands_england = eng.set_index("band")["pct"].to_dict()
        for cname in council_names:
            a = age_bands[age_bands["council"] == cname]
            if not a.empty:
                age_by_name[cname] = a.set_index("band")["pct"].to_dict()

    # ---- party buckets (over control) -----------------------------------------
    bucket_of = {r["name"]: control.get(code, {}).get("bucket") for code, r in reg.items()}
    disc_share_by_name = {r["name"]: corpus_shares[code] for code, r in reg.items() if code in corpus_shares}
    party_groups_spend = party_groups(ft_shares, bucket_of, "spend_share")
    party_groups_discussion = party_groups(disc_share_by_name, bucket_of, "discussion_share")

    # ---- league table (all councils, QoL + IMD indicators) -------------------
    QOL_INDICATORS = [
        {"id": "imd_national_rank", "label": "Deprivation Rank", "unit": "/282", "lower_better": True},
        {"id": "life_expectancy", "label": "Life Expectancy", "unit": "yrs", "lower_better": False},
        {"id": "rent_affordability", "label": "Rent Affordability", "unit": "%", "lower_better": True},
        {"id": "child_poverty_pct", "label": "Child Poverty", "unit": "%", "lower_better": True},
        {"id": "claimant_rate_pct", "label": "Claimant Rate", "unit": "%", "lower_better": True},
        {"id": "air_quality_pm25_pct", "label": "Air Quality (PM2.5)", "unit": "%", "lower_better": True},
        {"id": "crime_per_1000", "label": "Crime / 1k", "unit": "", "lower_better": True},
    ]

    league_rows = []
    for code, r in reg.items():
        ctrl = control.get(code, {})
        q = qol_by_code.get(code, {})
        imd_obj = q.get("overall_imd") or {}
        
        row = {
            "council": r["name"],
            "ons_code": code,
            "tier": r["tier"],
            "control": ctrl.get("current"),
            "bucket": ctrl.get("bucket"),
            "imd_national_rank": imd_obj.get("national_rank"),
            "life_expectancy": q.get("life_expectancy"),
            "rent_affordability": q.get("rent_affordability"),
            "child_poverty_pct": q.get("child_poverty_pct"),
            "claimant_rate_pct": q.get("claimant_rate_pct"),
            "air_quality_pm25_pct": q.get("air_quality_pm25_pct"),
            "crime_per_1000": q.get("crime_per_1000"),
        }
        league_rows.append(row)
    league_table = {"indicators": QOL_INDICATORS, "rows": league_rows}

    # ---- assemble councils ----------------------------------------------------
    out_councils = {}
    for code, r in reg.items():
        cname = r["name"]
        ctrl = control.get(code)

        elec = None
        if elections is not None:
            e = elections[elections["council"] == cname].sort_values("poll_date")
            if not e.empty:
                elec = {"title": e.iloc[0]["title"], "poll_date": e.iloc[0]["poll_date"]}

        ethnicity = eth_by_ons.get(code) or eth_by_name.get(cname)

        m_share = None
        if cname in ft_shares:
            rows = sorted(ft_shares[cname].items(), key=lambda kv: -kv[1])
            m_share = [{"topic": t, "council_pct": p, "england_pct": round(ft_england.get(t, 0.0), 1)} for t, p in rows]

        tvs = None
        if code in corpus_shares and cname in ft_shares:
            matched = [t for t in MATCHED_SPEND_TOPICS if t in ft_shares[cname]]
            disc_matched = {t: corpus_shares[code].get(t, 0.0) for t in matched}
            tot = sum(disc_matched.values())
            if tot > 0 and matched:
                disc_pct = {t: round(disc_matched[t] / tot * 100, 1) for t in matched}
                note = "spend committed under the previous administration" if (ctrl and ctrl["changed"]) else None
                tvs = {"topics": [{"topic": t, "discussion_pct": disc_pct[t], "spend_pct": ft_shares[cname][t]} for t in matched],
                       "note": note}

        links = []
        if reading_links is not None:
            rl = reading_links[reading_links["council"] == cname].head(3)
            links = rl[["title", "url", "source"]].to_dict("records")

        out_councils[cname] = {
            "id": r["council_id"], "ons_code": code, "tier": r["tier"],
            "party": ctrl["bucket"] if ctrl else None,
            "party_full": ctrl["current"] if ctrl else None,
            "control": ctrl,
            "election": elec,
            "population": int(population[code]) if code in population else None,
            "ethnicity": ethnicity,
            "ethnicity_england": ethnicity_england,
            "topic_share": topic_share.get(code),
            "age_bands": age_by_name.get(cname),
            "money": money.get(code),
            "money_share": m_share,
            "talk_vs_spend": tvs,
            "scorecard": scorecard.get(code, []),
            "qol": qol_by_code.get(code),
            "financial_distress": distress_by_code.get(code),
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
        "finance_topics_england": ft_england,
        "qol_england": qol_england,
        "distress_watchlist": distress_watchlist,
        "age_bands_mode": age_mode,
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

    counts = {
        "councils": len(out_councils),
        "with_topic_share": sum(1 for c in out_councils.values() if c["topic_share"]),
        "with_population": sum(1 for c in out_councils.values() if c["population"] is not None),
        "with_ethnicity": sum(1 for c in out_councils.values() if c["ethnicity"]),
        "with_age_bands": sum(1 for c in out_councils.values() if c["age_bands"]),
        "with_money": sum(1 for c in out_councils.values() if c["money"]),
        "with_money_share": sum(1 for c in out_councils.values() if c["money_share"]),
        "with_talk_vs_spend": sum(1 for c in out_councils.values() if c["talk_vs_spend"]),
        "with_scorecard": sum(1 for c in out_councils.values() if c["scorecard"]),
        "with_qol": sum(1 for c in out_councils.values() if c.get("qol")),
        "with_financial_distress": sum(1 for c in out_councils.values() if c.get("financial_distress")),
        "with_control": sum(1 for c in out_councils.values() if c["control"]),
        "with_reading_links": sum(1 for c in out_councils.values() if c["reading_links"]),
        "party_groups_spend": len(party_groups_spend),
        "party_groups_discussion": len(party_groups_discussion),
        "league_rows": len(league_rows),
    }
    print(f"wrote {out_path} -- {counts}")


if __name__ == "__main__":
    main()
