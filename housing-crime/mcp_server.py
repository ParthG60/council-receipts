#!/usr/bin/env python3
"""MCP (Model Context Protocol) server for the Housing & Crime Forensic Terminal.

Zero dependencies — stdlib only. Add to Claude Desktop / Claude Code / Cursor and
ask questions against verified council data instead of scraping.

Config example (claude_desktop_config.json):
  {
    "mcpServers": {
      "council-housing-crime": {
        "command": "python3",
        "args": ["/absolute/path/to/site/housing-crime/mcp_server.py"]
      }
    }
  }

Tools:
  - list_councils(query?)
  - get_council_dossier(council)
  - search_decisions(council?, category?, keyword?, min_value?, limit?)
  - generate_foi(council, topic?)
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
DATA_PATH = HERE / "data.json"
PROTOCOL = "2024-11-05"

DATA = None


def load():
    global DATA
    if DATA is None:
        DATA = json.loads(DATA_PATH.read_text())
    return DATA


def resolve_council(name_or_ons):
    d = load()
    key = (name_or_ons or "").strip()
    if key in d["councils"]:
        return d["councils"][key]
    low = key.lower()
    for c in d["councils"].values():
        if c["name"].lower() == low:
            return c
    for c in d["councils"].values():
        if low and low in c["name"].lower():
            return c
    return None


CAT_LABEL = {
    "housing_ta": "Emergency housing / temporary accommodation",
    "planning_s106": "Planning & Section 106",
    "enforcement_asb": "Enforcement & ASB",
    "contracts": "Contracts & procurement",
}


def tool_list_councils(args):
    d = load()
    q = (args.get("query") or "").lower()
    rows = [c for c in d["councils"].values() if not q or q in c["name"].lower()]
    rows.sort(key=lambda c: -c.get("total_decisions", 0))
    lines = [f"{c['name']} ({c['ons_code']}) — {c['total_decisions']} flagged decisions" for c in rows[:60]]
    return "\n".join(lines) or "No councils matched."


def tool_get_dossier(args):
    c = resolve_council(args.get("council"))
    if not c:
        return "Council not found."
    p, s = c["pressure"], c["spend"]
    L = [f"# {c['name']} ({c['ons_code']})", f"Control: {c.get('party') or 'n/a'}"]
    L.append(f"Rent burden: {p['rent_affordability']}% (rank #{p['rent_affordability_rank']}/282)")
    L.append(f"Crime: {p['crime_per_1000']}/1k (rank #{p['crime_rank']}/282)")
    L.append(f"Housing spend: £{s['housing']}/head" if s.get("housing") is not None else "Housing spend: n/a")
    L.append(f"Safety spend: £{s['env_regulatory']}/head" if s.get("env_regulatory") is not None else "Safety spend: n/a")
    L.append(f"Borrowing: £{c['borrowing_per_resident']}/head" if c.get("borrowing_per_resident") is not None else "Borrowing: n/a")
    L.append("")
    L.append("Decision counts: " + ", ".join(f"{CAT_LABEL[k]}={v}" for k, v in c["decision_counts"].items()))
    if c["leads"]:
        L.append("")
        L.append("Investigative leads:")
        L += [f"- {l['label']}: {l['advice']}" for l in c["leads"]]
    L.append("")
    L.append("Recent flagged decisions:")
    for d in c["decisions"][:15]:
        val = f" £{d['value_gbp']:,.0f}" if d.get("value_gbp") else ""
        L.append(f"- [{d['date']}] ({', '.join(CAT_LABEL.get(k, k) for k in d['categories'])}){val} {d['topline']}")
    return "\n".join(L)


def tool_search_decisions(args):
    d = load()
    c = resolve_council(args.get("council")) if args.get("council") else None
    cat = args.get("category")
    kw = (args.get("keyword") or "").lower()
    minv = args.get("min_value") or 0
    limit = int(args.get("limit") or 25)
    pool = [c] if c else list(d["councils"].values())
    out = []
    for council in pool:
        for dec in council["decisions"]:
            if cat and cat not in dec["categories"]:
                continue
            if kw and kw not in (dec["topline"] + " " + dec["snippet"]).lower():
                continue
            if minv and (dec.get("value_gbp") or 0) < minv:
                continue
            out.append((council["name"], dec))
    out.sort(key=lambda t: t[1]["date"], reverse=True)
    if not out:
        return "No decisions matched."
    L = [f"{len(out)} matching decisions (showing {min(limit, len(out))}):"]
    for name, dec in out[:limit]:
        val = f" £{dec['value_gbp']:,.0f}" if dec.get("value_gbp") else ""
        L.append(f"- [{dec['date']}] {name}: ({', '.join(CAT_LABEL.get(k, k) for k in dec['categories'])}){val} {dec['topline']}")
        if dec.get("url"):
            L.append(f"    {dec['url']}")
    return "\n".join(L)


FOI = {
    "housing_ta": "Temporary accommodation: annual spend by type (last 3 years); nightly B&B rates and households placed; out-of-borough placements; CPR exemptions applied.",
    "planning_s106": "S106: policy-required vs secured affordable housing per major application (last 3 years); viability-driven reductions and units lost; S106/CIL receipts vs unspent.",
    "enforcement_asb": "ASB: spend on PSPOs, private security, wardens, CCTV (last 3 years); FPNs issued and collected; youth/prevention budget over same period.",
    "contracts": "Procurement: all CPR waivers/direct awards (last 2 years) with supplier, value, justification; top 10 suppliers by payments.",
}


def tool_generate_foi(args):
    c = resolve_council(args.get("council"))
    if not c:
        return "Council not found."
    cats = [l["category"] for l in c["leads"]] or list(FOI)
    topic = args.get("topic") or cats[0]
    if topic not in FOI:
        topic = cats[0]
    return (f"To: {c['name']} — Freedom of Information Team\n"
            f"Subject: FOIA 2000 request — {CAT_LABEL[topic]}\n\n"
            f"Dear Sir/Madam,\n\nUnder the Freedom of Information Act 2000, please provide:\n\n"
            f"{FOI[topic]}\n\n"
            "Please provide machine-readable data where possible. If any part exceeds the cost "
            "limit, advise which parts can be answered within it.\n\nYours faithfully,\n[Name]")


TOOLS = [
    {
        "name": "list_councils",
        "description": "List English councils with housing/crime decisions on record, optionally filtered by name.",
        "inputSchema": {"type": "object", "properties": {"query": {"type": "string", "description": "Name substring filter"}}},
    },
    {
        "name": "get_council_dossier",
        "description": "Verified pressure metrics, spend, decisions and investigative leads for one council.",
        "inputSchema": {"type": "object", "properties": {"council": {"type": "string", "description": "Council name or ONS code"}}, "required": ["council"]},
    },
    {
        "name": "search_decisions",
        "description": "Search flagged housing/crime executive decisions across councils.",
        "inputSchema": {"type": "object", "properties": {
            "council": {"type": "string"},
            "category": {"type": "string", "enum": list(CAT_LABEL)},
            "keyword": {"type": "string"},
            "min_value": {"type": "number", "description": "Minimum GBP contract value"},
            "limit": {"type": "integer"},
        }},
    },
    {
        "name": "generate_foi",
        "description": "Draft a Freedom of Information request for a council and topic.",
        "inputSchema": {"type": "object", "properties": {"council": {"type": "string"}, "topic": {"type": "string", "enum": list(FOI)}}, "required": ["council"]},
    },
]
DISPATCH = {"list_councils": tool_list_councils, "get_council_dossier": tool_get_dossier,
            "search_decisions": tool_search_decisions, "generate_foi": tool_generate_foi}


def respond(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = req.get("method")
        id_ = req.get("id")
        if method == "initialize":
            respond(id_, {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                          "serverInfo": {"name": "council-housing-crime", "version": "1.0.0"}})
        elif method == "tools/list":
            respond(id_, {"tools": TOOLS})
        elif method == "tools/call":
            params = req.get("params") or {}
            fn = DISPATCH.get(params.get("name"))
            if not fn:
                respond(id_, error={"code": -32601, "message": "Unknown tool"})
                continue
            try:
                text = fn(params.get("arguments") or {})
                respond(id_, {"content": [{"type": "text", "text": text}], "isError": False})
            except Exception as e:
                respond(id_, {"content": [{"type": "text", "text": f"Error: {e}"}], "isError": True})
        elif method in ("notifications/initialized", "initialized"):
            continue
        elif id_ is not None:
            respond(id_, error={"code": -32601, "message": f"Unknown method {method}"})


if __name__ == "__main__":
    main()
