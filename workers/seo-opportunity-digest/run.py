"""SEO Opportunity Digest — openpaper.dev.

Phase 1: pull Search Console data, find page-2 opportunities, draft briefs,
         emit decision_required for human review.
Phase 2: after approval, create one Notion page per opportunity.
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

WORKEROS_API_URL = os.environ.get("WORKEROS_API_URL", "https://workers-api.floom.dev").rstrip("/")
FLOOM_RUN_ID = os.environ.get("FLOOM_RUN_ID", "")
WORKEROS_RUN_TOKEN = os.environ.get("WORKEROS" + "_RUN_TOKEN", "")


def _read_inputs():
    try:
        with open("inputs.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _read_connection_id(app):
    try:
        with open("connections.json") as f:
            return str(json.load(f).get(app) or "").strip()
    except FileNotFoundError:
        return ""


def _write_result(status, *, outputs=None, decision_required=None, error=None):
    payload = {"status": status}
    if outputs:
        payload["outputs"] = outputs
    if decision_required:
        payload["decision_required"] = decision_required
    if error:
        payload["error"] = error
    with open("result.json", "w") as f:
        json.dump(payload, f)


def composio_execute(app, slug, arguments):
    connection_id = _read_connection_id(app)
    if not connection_id:
        return {"successful": False, "error": f"{app} connection not found"}
    url = f"{WORKEROS_API_URL}/runs/{FLOOM_RUN_ID}/composio-execute/{slug}"
    body = {"connected_account_id": connection_id, "arguments": arguments}
    headers = {"Content-Type": "application/json"}
    if WORKEROS_RUN_TOKEN:
        headers["X-Workeros-Run-Token"] = WORKEROS_RUN_TOKEN
    req = urlrequest.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urlrequest.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        return {"successful": False, "error": f"HTTP {e.code}: {e.read().decode(errors='replace')}"}
    except (URLError, TimeoutError) as e:
        return {"successful": False, "error": str(e)}


def fetch_search_console(site_url, start_date, end_date):
    return composio_execute("google_search_console", "GOOGLE_SEARCH_CONSOLE_GET_SEARCH_ANALYTICS", {
        "siteUrl": site_url,
        "startDate": start_date,
        "endDate": end_date,
        "dimensions": ["query", "page"],
        "rowLimit": 500,
    })


def draft_brief(query, position, impressions, ctr, page):
    intent_map = [
        ("vs", "comparison", "Create a dedicated comparison page or add a comparison table."),
        ("how to", "tutorial", "Add a step-by-step guide section with a clear H1 starting with 'How to'."),
        ("best", "list/review", "Build a curated list page with scoring criteria and a clear CTA."),
        ("free", "tool access", "Lead with the free tier offer above the fold; add an inline demo."),
        ("online", "tool access", "Rewrite H1 to emphasise instant access; add an inline demo GIF."),
        ("template", "resource", "Create a downloadable template page with a preview and one-click copy."),
        ("example", "reference", "Add a rich examples section with real screenshots and code snippets."),
    ]
    intent = "informational"
    action = "Rewrite the H1 to match exact query phrasing and add an FAQ section addressing sub-intents."
    for keyword, intent_label, suggestion in intent_map:
        if keyword in query.lower():
            intent = intent_label
            action = suggestion
            break
    return (
        f"Searchers want {intent} content. "
        f"openpaper.dev currently ranks #{position:.1f} for this query on page `{page.split('/')[-1] or '/'}`—close but not visible. "
        f"{action}"
    )


def build_brief_text(opportunities, run_date):
    lines = [f"# SEO Opportunities — openpaper.dev (week of {run_date})\n"]
    for i, op in enumerate(opportunities, 1):
        lines.append(f"## {i}. \"{op['query']}\" — Position {op['position']:.1f}")
        lines.append(f"- Impressions: {op['impressions']} | CTR: {op['ctr_pct']:.1f}% | Score: {op['score']:.0f}")
        lines.append(f"- **Brief:** {op['brief']}")
        lines.append("")
    lines.append(f"{len(opportunities)} opportunities found. Approve to queue in Notion.")
    return "\n".join(lines)


def create_notion_page(title, body):
    return composio_execute("notion", "NOTION_CREATE_PAGE", {
        "title": title,
        "content": body,
    })


def main():
    inputs = _read_inputs()
    decision = inputs.get("decision")
    approved_output = inputs.get("approved_output")

    # Phase 2: create Notion pages for approved opportunities
    if decision == "approved":
        brief_text = approved_output if isinstance(approved_output, str) else json.dumps(approved_output)
        # Parse opportunity titles from the brief
        titles = [line.split('"')[1] for line in brief_text.splitlines() if line.startswith("## ") and '"' in line]
        created = []
        for title in titles:
            result = create_notion_page(f"SEO: {title}", brief_text)
            created.append({"query": title, "created": result.get("successful", False)})
        _write_result("success", outputs={
            "phase": "run-2-execute",
            "opportunity_brief": f"Created {len([c for c in created if c['created']])} Notion pages.",
        })
        print(f"[phase-2] Created {len(created)} Notion pages.")
        sys.exit(0)

    # Phase 1: fetch Search Console data and draft briefs
    site_url = inputs.get("site_url", "sc-domain:openpaper.dev")
    min_impressions = int(inputs.get("min_impressions", 50))
    top_n = int(inputs.get("top_n", 5))

    today = datetime.now(timezone.utc)
    end_date = (today - timedelta(days=1)).strftime("%Y-%m-%d")
    start_date = (today - timedelta(days=8)).strftime("%Y-%m-%d")

    result = fetch_search_console(site_url, start_date, end_date)
    if not result.get("successful", True) or "error" in result and result["error"]:
        _write_result("error", error=f"Search Console fetch failed: {result.get('error')}")
        sys.exit(1)

    rows = result.get("data", {}).get("rows") or result.get("rows") or []
    if not rows:
        _write_result("success", outputs={
            "phase": "run-1-propose",
            "opportunity_brief": "No Search Console data found for this period.",
        })
        sys.exit(0)

    opportunities = []
    for row in rows:
        keys = row.get("keys", [])
        query = keys[0] if len(keys) > 0 else ""
        page = keys[1] if len(keys) > 1 else ""
        impressions = row.get("impressions", 0)
        ctr = row.get("ctr", 0)
        position = row.get("position", 0)
        if impressions < min_impressions:
            continue
        if not (8 <= position <= 20):
            continue
        score = impressions * (1 - ctr)
        opportunities.append({
            "query": query,
            "page": page,
            "impressions": impressions,
            "ctr": ctr,
            "ctr_pct": ctr * 100,
            "position": position,
            "score": score,
            "brief": draft_brief(query, position, impressions, ctr, page),
        })

    opportunities.sort(key=lambda x: x["score"], reverse=True)
    top = opportunities[:top_n]

    if not top:
        _write_result("success", outputs={
            "phase": "run-1-propose",
            "opportunity_brief": f"No queries found matching criteria (position 8-20, impressions >= {min_impressions}).",
        })
        sys.exit(0)

    run_date = today.strftime("%Y-%m-%d")
    brief_text = build_brief_text(top, run_date)

    _write_result("success", outputs={
        "phase": "run-1-propose",
        "opportunity_brief": brief_text,
    }, decision_required={
        "label": "Approve SEO opportunities before queuing in Notion",
        "preview": brief_text,
    })
    print(f"[phase-1] Found {len(top)} opportunities — awaiting approval.")
    sys.exit(0)


if __name__ == "__main__":
    main()
