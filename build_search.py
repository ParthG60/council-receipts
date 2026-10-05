"""Build per-council document search indexes for the site.

Generates site/search_index/<ons_code>.json — one file per council containing
a list of classified documents with snippet, date, meeting, and topic hit counts.

Run after build.py (needs the same data shards). Idempotent — writes one file
per council, overwrites on re-run.
"""
import json
import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).parent.parent
ENG_DIR = ROOT / "data_england"
SITE_DIR = Path(__file__).parent
INDEX_DIR = SITE_DIR / "search_index"

sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).parent))
from taxonomy import TOPICS as TOPIC_KEYWORDS  # noqa: E402
from common import load_registry  # noqa: E402

TOPICS = list(TOPIC_KEYWORDS.keys())
NOTICE_PATTERN = r"(?i)\border\b|notice|traffic|speed limit|parking|prohibition|public path"

# tokens too generic to be useful as cross-council search keys
STOPWORDS = {
    "the", "and", "for", "that", "this", "with", "was", "were", "are", "not", "but",
    "from", "has", "have", "had", "will", "would", "can", "could", "should", "may",
    "been", "being", "into", "over", "under", "also", "than", "then", "there", "their",
    "they", "them", "she", "it", "its", "on", "at", "in", "is", "to", "of", "a",
    "council", "committee", "meeting", "report", "item", "agenda", "minutes", "page",
    "appendix", "date", "time", "matter", "decision", "recommend", "recommendation",
    "member", "members", "present", "chair", "apologies", "received", "note", "notes",
    "update", "review", "purpose", "background", "summary", "introduction", "regarding",
    "within", "which", "these", "those", "such", "each", "other", "more", "most",
}
TOKEN_RE = re.compile(r"[a-z]{4,}")


def tokens_of(text):
    return {t for t in TOKEN_RE.findall((text or "").lower()) if t not in STOPWORDS}



def read_shard_csv(path):
    if not path.exists():
        return None
    try:
        df = pd.read_csv(path)
    except Exception:
        return None
    return None if df.empty else df


def main():
    reg = load_registry()
    id2ons = {r["council_id"]: code for code, r in reg.items() if r["council_id"] is not None}

    # Load ALL doc_topics shards
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
        print("No data found.")
        return

    corpus = pd.concat(frames, ignore_index=True)
    if "committee" in corpus.columns:
        corpus = corpus[~corpus["committee"].str.contains(NOTICE_PATTERN, na=False)]
    for t in TOPICS:
        if t not in corpus.columns:
            corpus[t] = 0

    # Map council_id -> ons_code, drop unmapped
    corpus["ons_code"] = corpus["council_id"].map(id2ons)
    corpus = corpus[corpus["ons_code"].notna()]

    # Filter to documents with at least one topic hit
    topic_cols = [c for c in TOPICS if c in corpus.columns]
    corpus["_total_hits"] = corpus[topic_cols].sum(axis=1)
    corpus = corpus[corpus["_total_hits"] > 0]

    print(f"Building search index for {len(corpus):,} classified documents across {len(reg)} councils...")

    INDEX_DIR.mkdir(parents=True, exist_ok=True)

    count = 0
    global_index = {}   # token -> {ons_code: doc_count}
    for ons_code, grp in corpus.groupby("ons_code"):
        # Sort by date descending, take newest 500
        grp = grp.sort_values("date", ascending=False).head(500)
        docs = []
        for _, row in grp.iterrows():
            topics_hit = [t for t in topic_cols if row[t] > 0]
            snippet = str(row.get("snippet", ""))[:120].strip()
            meeting = str(row.get("meeting_name", ""))[:80].strip()
            docs.append({
                "d": str(row["date"])[:10] if pd.notna(row.get("date")) else "",
                "m": meeting,
                "s": snippet,
                "u": str(row.get("pdf_url", "")),
                "t": topics_hit,
            })
            # accumulate cross-council token index
            for tk in tokens_of(meeting + " " + snippet + " " + " ".join(topics_hit)):
                bucket = global_index.setdefault(tk, {})
                bucket[ons_code] = bucket.get(ons_code, 0) + 1
        out_path = INDEX_DIR / f"{ons_code}.json"
        out_path.write_text(json.dumps(docs, indent=None, default=str), encoding="utf-8")
        count += 1

    # Global index: only keep tokens that appear in >= 2 councils (a token in one
    # council is already reachable via that council's own page), cap council lists.
    compact = {}
    for tk, bucket in global_index.items():
        if len(bucket) < 2:
            continue
        pairs = sorted(bucket.items(), key=lambda kv: -kv[1])[:40]
        compact[tk] = [[ons, n] for ons, n in pairs]
    (SITE_DIR / "search_index_global.json").write_text(
        json.dumps(compact, separators=(",", ":"), default=str), encoding="utf-8"
    )

    # Build the master list of what search indexes exist (for the frontend)
    listed = sorted(reg.keys())
    INDEX_DIR.parent.joinpath("search_index.json").write_text(
        json.dumps({code: reg[code]["name"] for code in listed}, indent=None),
        encoding="utf-8",
    )

    print(f"Wrote {count} search index files to {INDEX_DIR}/")
    print(f"Wrote search_index_global.json: {len(compact)} tokens")



if __name__ == "__main__":
    main()