"""Search Console Insights — weekly SEO audit worker."""

import json
import math
import os
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

THRESHOLDS = {
    "ctr_opportunity_impressions": 100,
    "ctr_opportunity_ctr": 3.0,
    "position_opportunity_min": 8,
    "position_opportunity_max": 15,
    "position_opportunity_impressions": 50,
    "quick_win_min": 5,
    "quick_win_max": 7,
    "quick_win_impressions": 30,
    "decline_threshold": 0.20,
    "growth_threshold": 0.25,
}

BRANDED_TERMS = ["rocketlist"]


WORKEROS_API_URL = os.environ.get("WORKEROS_API_URL", "https://workers-api.floom.dev").rstrip("/")
FLOOM_RUN_ID = os.environ.get("FLOOM_RUN_ID", "")
WORKEROS_RUN_TOKEN = os.environ.get("WORKEROS_RUN_TOKEN", "")


def _read_connection_id() -> str:
    try:
        with open("connections.json") as f:
            connections = json.load(f)
    except FileNotFoundError:
        connections = {}
    return str(connections.get("google_search_console") or "").strip()


def composio_execute(slug: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not FLOOM_RUN_ID:
        return {"successful": False, "error": "FLOOM_RUN_ID is not set"}
    connection_id = _read_connection_id()
    if not connection_id:
        return {"successful": False, "error": "google_search_console connection is not active"}

    body = {
        "connected_account_id": connection_id,
        "arguments": payload,
    }
    url = f"{WORKEROS_API_URL}/runs/{FLOOM_RUN_ID}/composio-execute/{slug}"
    encoded = json.dumps(body).encode("utf-8")
    req_headers = {"Content-Type": "application/json"}
    if WORKEROS_RUN_TOKEN:
        req_headers["X-Workeros-Run-Token"] = WORKEROS_RUN_TOKEN
    req = urlrequest.Request(url, data=encoded, headers=req_headers, method="POST")
    try:
        with urlrequest.urlopen(req, timeout=120) as response:
            output = json.loads(response.read().decode("utf-8"))
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        return {"successful": False, "error": f"Workeros proxy HTTP {e.code}: {detail}"}
    except (URLError, TimeoutError, json.JSONDecodeError) as e:
        return {"successful": False, "error": str(e)}

    if output.get("successful") and output.get("storedInFile"):
        fp = output.get("outputFilePath")
        if fp and Path(fp).exists():
            try:
                with open(fp) as f:
                    fd = json.load(f)
                output["data"] = fd.get("data", fd)
            except Exception:
                pass
    return output


def _composio_error(result: Optional[Dict[str, Any]]) -> str:
    if not result:
        return "No response from Workeros Composio proxy"
    error = result.get("error") or result.get("message") or result.get("detail")
    if error:
        return str(error)
    data = result.get("data")
    if isinstance(data, dict):
        nested_error = data.get("error") or data.get("message") or data.get("detail")
        if nested_error:
            return str(nested_error)
    return json.dumps(result, default=str)[:1000]


def pull_gsc_data(site_url: str, start_date: date, end_date: date) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    result = composio_execute(
        "GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY",
        {
            "site_url": site_url,
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "dimensions": ["query", "page"],
            "row_limit": 5000,
        },
    )
    if not result or not result.get("successful"):
        return [], _composio_error(result)
    data = result.get("data", {})
    if isinstance(data, dict):
        response_data = data.get("response_data")
        if isinstance(response_data, dict):
            rows = response_data.get("rows", [])
        else:
            rows = data.get("rows", [])
        return rows if isinstance(rows, list) else [], None
    return [], f"Unexpected GSC response shape: {type(data).__name__}"


def build_dataset(rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    dataset: Dict[str, Dict[str, Any]] = {}
    agg = defaultdict(lambda: {"clicks": 0, "impressions": 0})
    for row in rows:
        keys = row.get("keys", [])
        query = keys[0] if len(keys) > 0 else ""
        page = keys[1] if len(keys) > 1 else ""
        key = f"Q:{query}|P:{page}"
        for m in ("clicks", "impressions"):
            v = row.get(m)
            if isinstance(v, (int, float)):
                agg[key][m] += v
        agg[key]["query"] = query
        agg[key]["page"] = page

    pos_map = defaultdict(lambda: {"weighted": 0.0, "impr": 0})
    for row in rows:
        keys = row.get("keys", [])
        query = keys[0] if len(keys) > 0 else ""
        page = keys[1] if len(keys) > 1 else ""
        key = f"Q:{query}|P:{page}"
        pos = row.get("position")
        impr = row.get("impressions") or 0
        if isinstance(pos, (int, float)) and isinstance(impr, (int, float)):
            pos_map[key]["weighted"] += pos * impr
            pos_map[key]["impr"] += impr

    for k, data in agg.items():
        clicks = data["clicks"]
        impressions = data["impressions"]
        dataset[k] = {
            "query": data["query"],
            "page": data["page"],
            "clicks": clicks,
            "impressions": impressions,
            "ctr": (clicks / impressions * 100) if impressions else 0,
            "position": (pos_map[k]["weighted"] / pos_map[k]["impr"]) if pos_map[k]["impr"] else 99,
        }
    return dataset


def compare_datasets(current: Dict[str, Any], previous: Dict[str, Any]) -> List[Dict[str, Any]]:
    results = []
    for k, cur in current.items():
        prev = previous.get(k, {})
        result = dict(cur)
        result["prev_clicks"] = prev.get("clicks", 0)
        result["prev_impressions"] = prev.get("impressions", 0)
        result["prev_position"] = prev.get("position", 99)
        result["click_change"] = cur["clicks"] - result["prev_clicks"]
        if result["prev_clicks"] > 0:
            result["click_change_pct"] = result["click_change"] / result["prev_clicks"]
        elif cur["clicks"] > 0:
            result["click_change_pct"] = float("inf")
        else:
            result["click_change_pct"] = 0
        result["position_change"] = result["prev_position"] - cur["position"]
        result["is_new"] = k not in previous
        result["is_lost"] = False
        results.append(result)

    for k, prev in previous.items():
        if k not in current:
            result = dict(prev)
            result["clicks"] = 0
            result["impressions"] = 0
            result["ctr"] = 0
            result["position"] = 99
            result["prev_clicks"] = prev.get("clicks", 0)
            result["prev_impressions"] = prev.get("impressions", 0)
            result["click_change"] = -result["prev_clicks"]
            result["click_change_pct"] = -1.0
            result["position_change"] = 0
            result["is_new"] = False
            result["is_lost"] = True
            results.append(result)
    return results


def fmt_num(n):
    if n is None or math.isinf(n):
        return "N/A"
    return f"{n:,.0f}" if isinstance(n, float) and n == int(n) else f"{n:,.1f}"


def fmt_pct(n):
    return f"{n:.2f}%" if n is not None else "N/A"


def is_branded(row: Dict[str, Any]) -> bool:
    query = str(row.get("query") or "").lower()
    page = str(row.get("page") or "").lower()
    for term in BRANDED_TERMS:
        if term.lower() in query or term.lower() in page:
            return True
    return False


def generate_seo_report(
    comparison: List[Dict[str, Any]],
    site_url: str,
    current_start: date,
    current_end: date,
    previous_start: date,
    previous_end: date,
) -> str:
    t = THRESHOLDS
    active = [r for r in comparison if not r.get("is_lost")]
    total_clicks = sum(r["clicks"] for r in active)
    total_impr = sum(r["impressions"] for r in active)
    avg_pos = (
        sum(r["position"] * r["impressions"] for r in active) / total_impr
        if total_impr else 0
    )
    brand_clicks = sum(r["clicks"] for r in active if is_branded(r))
    nonbrand_clicks = total_clicks - brand_clicks

    prev_total = sum(r["prev_clicks"] for r in comparison)
    click_delta = ((total_clicks - prev_total) / prev_total * 100) if prev_total else 0

    ctr_opp = []
    page2_push = []
    quick_wins = []
    trending_up = []
    trending_down = []
    new_queries = []
    lost_queries = []

    for r in comparison:
        if r.get("is_lost"):
            lost_queries.append(r)
            continue
        impr = r["impressions"]
        ctr = r["ctr"]
        pos = r["position"]
        change_pct = r.get("click_change_pct", 0)

        if impr >= t["ctr_opportunity_impressions"] and ctr <= t["ctr_opportunity_ctr"] and pos <= 15:
            ctr_opp.append(r)
        if t["position_opportunity_min"] <= pos <= t["position_opportunity_max"] and impr >= t["position_opportunity_impressions"]:
            page2_push.append(r)
        if t["quick_win_min"] <= pos <= t["quick_win_max"] and impr >= t["quick_win_impressions"]:
            quick_wins.append(r)
        if change_pct >= t["growth_threshold"] and r.get("prev_clicks", 0) > 0:
            trending_up.append(r)
        if change_pct <= -t["decline_threshold"]:
            trending_down.append(r)
        if r.get("is_new"):
            new_queries.append(r)

    ctr_opp.sort(key=lambda x: x["impressions"], reverse=True)
    page2_push.sort(key=lambda x: x["impressions"], reverse=True)
    quick_wins.sort(key=lambda x: x["impressions"], reverse=True)
    trending_up.sort(key=lambda x: x.get("click_change", 0), reverse=True)
    trending_down.sort(key=lambda x: x.get("click_change", 0))
    new_queries.sort(key=lambda x: x["impressions"], reverse=True)
    lost_queries.sort(key=lambda x: x["prev_clicks"], reverse=True)

    lines = [
        f"# SEO Action Report — {site_url}",
        f"",
        f"**Current Period:** {current_start} → {current_end}  ",
        f"**Previous Period:** {previous_start} → {previous_end}  ",
        f"",
        f"## Executive Summary",
        f"",
        f"**Total Clicks:** {fmt_num(total_clicks)}  ",
        f"**Total Impressions:** {fmt_num(total_impr)}  ",
        f"**Avg Position:** {avg_pos:.1f}  ",
    ]
    if total_clicks:
        lines.append(f"**Brand Clicks:** {fmt_num(brand_clicks)} ({brand_clicks/total_clicks*100:.1f}%)  ")
        lines.append(f"**Non-Brand Clicks:** {fmt_num(nonbrand_clicks)} ({nonbrand_clicks/total_clicks*100:.1f}%)  ")
    else:
        lines += ["**Brand Clicks:** 0  ", "**Non-Brand Clicks:** 0  "]
    lines.append("")
    if prev_total:
        lines.append(f"_Period-over-period clicks: {'up' if click_delta > 0 else 'down'} {abs(click_delta):.1f}%._")
        lines.append("")

    def section(title: str, subtitle: str, items: List[Dict[str, Any]], headers: List[str], fmt):
        if not items:
            return
        lines.extend([f"## {title}", "", subtitle, ""])
        lines.append("| " + " | ".join(headers) + " |")
        lines.append("|" + "|".join(["-" * (len(h) + 2) for h in headers]) + "|")
        for r in items[:10]:
            lines.append("| " + " | ".join(fmt(r)) + " |")
        lines.append("")

    section(
        "🎯 CTR Opportunities",
        "High impressions + low CTR = your title/description is failing to win the click.",
        ctr_opp,
        ["Query", "Page", "Impressions", "CTR", "Position", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            fmt_num(r["impressions"]),
            fmt_pct(r["ctr"]),
            f"{r['position']:.1f}",
            "Rewrite title/meta. Target CTR: 4-5%.",
        ],
    )

    section(
        "🚀 Page-2 Push Opportunities",
        "Ranking 8-15 with decent impressions. A small push gets you to page 1.",
        page2_push,
        ["Query", "Page", "Impressions", "Position", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            fmt_num(r["impressions"]),
            f"{r['position']:.1f}",
            "Add 2-3 internal links. Refresh content.",
        ],
    )

    section(
        "⚡ Quick Wins",
        "Position 5-7. Minor tweaks break you onto page 1.",
        quick_wins,
        ["Query", "Page", "Impressions", "Position", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            fmt_num(r["impressions"]),
            f"{r['position']:.1f}",
            "Update publish date + add 200-300 words.",
        ],
    )

    section(
        "📈 Trending Up",
        "Momentum is building. Double down before competitors catch up.",
        trending_up,
        ["Query", "Page", "Clicks Δ", "Impressions Δ", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            f"+{r['click_change']:,.0f} ({r['click_change_pct']*100:+.0f}%)",
            f"{r['impressions'] - r.get('prev_impressions', 0):+,.0f}",
            "Expand content, add strong CTA, target featured snippet.",
        ],
    )

    section(
        "📉 Trending Down (Content Decay)",
        "These are losing clicks. Refresh or lose rankings permanently.",
        trending_down,
        ["Query", "Page", "Clicks Δ", "Position Δ", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            f"{r['click_change']:,.0f} ({r['click_change_pct']*100:+.0f}%)",
            f"{r.get('position_change', 0):+.1f}" if r.get("position_change") else "—",
            "Full content refresh. Check SERP for new competitors.",
        ],
    )

    section(
        "✨ New Queries",
        "First-time appearances. Do you have content for these?",
        new_queries,
        ["Query", "Page", "Clicks", "Impressions", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            fmt_num(r["clicks"]),
            fmt_num(r["impressions"]),
            "Evaluate: optimize existing page or create new content.",
        ],
    )

    section(
        "💀 Lost Queries",
        "These had traffic before but dropped to zero. Investigate.",
        lost_queries,
        ["Query", "Page", "Previous Clicks", "Action"],
        lambda r: [
            r.get("query") or "(page-level)",
            r.get("page", "")[:50],
            fmt_num(r["prev_clicks"]),
            "Check if page was de-indexed or cannibalized.",
        ],
    )

    lines += ["## ✅ SEO Action Checklist", "", "Copy this into your PM tool and assign owners:", ""]
    checklist = []
    for r in ctr_opp[:3]:
        q = r.get("query") or "page"
        checklist.append(f"- [ ] Rewrite title/meta for `{q}` on {r.get('page', '')[:50]} (CTR opportunity)")
    for r in page2_push[:3]:
        q = r.get("query") or "page"
        checklist.append(f"- [ ] Add internal links to {r.get('page', '')[:50]} targeting `{q}` (Page-2 push)")
    for r in quick_wins[:3]:
        q = r.get("query") or "page"
        checklist.append(f"- [ ] Refresh content on {r.get('page', '')[:50]} for `{q}` (Quick win)")
    for r in trending_down[:3]:
        q = r.get("query") or "page"
        checklist.append(f"- [ ] Content decay audit: {r.get('page', '')[:50]} for `{q}`")
    for r in new_queries[:3]:
        q = r.get("query") or "page"
        checklist.append(f"- [ ] Content gap check: create/optimize for `{q}`")
    for item in checklist[:15]:
        lines.append(item)
    lines.append("")
    lines.append("---")
    lines.append(f"_Generated by Search Console Insights worker at {datetime.now(timezone.utc).isoformat()}_")

    return "\n".join(lines)


def run_diagnostics(site_url: str, decayed_paths: List[str]) -> str:
    lines = [f"# GSC Diagnostics — {site_url} — {datetime.now().date()}", ""]
    findings = []

    # Sitemaps
    sitemaps = composio_execute(
        "GOOGLE_SEARCH_CONSOLE_LIST_SITEMAPS", {"site_url": site_url}
    )
    lines.append("## Sitemaps")
    if sitemaps and sitemaps.get("successful"):
        for sm in sitemaps.get("data", {}).get("sitemap", []):
            lines.append(f"### {sm.get('path', 'unknown')}")
            lines.append(f"- **Type:** {'Sitemap Index' if sm.get('isSitemapsIndex') else 'Standard'}")
            lines.append(f"- **Last Submitted:** {sm.get('lastSubmitted', '?')}")
            lines.append(f"- **Errors:** {sm.get('errors', '?')} | **Warnings:** {sm.get('warnings', '?')}")
            for content in sm.get("contents", []):
                lines.append(
                    f"- **{content.get('type', 'web')} URLs:** Submitted={content.get('submitted', '?')}, Indexed={content.get('indexed', '?')}"
                )
            lines.append("")
    else:
        lines.append("_Failed to fetch sitemaps._")
    lines.append("")

    # Inspect decayed URLs + homepage
    inspect_urls = ["/"] + decayed_paths[:8]
    seen = set()
    lines.append("## URL Inspections")
    lines.append("")

    for path in inspect_urls:
        if path in seen:
            continue
        seen.add(path)
        full_url = site_url.rstrip("/") + path
        result = composio_execute(
            "GOOGLE_SEARCH_CONSOLE_INSPECT_URL",
            {"site_url": site_url, "inspection_url": full_url},
        )
        if not result or not result.get("successful"):
            lines.append(f"### {path}")
            lines.append("_Inspection failed._")
            lines.append("")
            continue

        index_status = result.get("data", {}).get("inspectionResult", {}).get("indexStatusResult", {})
        rich = result.get("data", {}).get("inspectionResult", {}).get("richResultsResult", {})
        coverage = index_status.get("coverageState", "unknown")
        last_crawl = index_status.get("lastCrawlTime", "unknown")

        lines.append(f"### {path}")
        lines.append(f"- **Coverage:** {coverage}")
        lines.append(f"- **Indexing State:** {index_status.get('indexingState', 'unknown')}")
        lines.append(f"- **Last Crawled:** {last_crawl}")

        if rich:
            lines.append(f"- **Rich Results:** {rich.get('verdict', 'unknown')}")
            for item in rich.get("detectedItems", []):
                for sub in item.get("items", []):
                    errors = [i for i in sub.get("issues", []) if i.get("severity") == "ERROR"]
                    if errors:
                        lines.append(f"  - **Errors:** {', '.join(e['issueMessage'] for e in errors)}")

        if "noindex" in coverage.lower():
            findings.append(f"{path}: Page has noindex tag — excluded from search")
        if "soft 404" in coverage.lower():
            findings.append(f"{path}: Soft 404 detected")
        if "duplicate" in coverage.lower():
            findings.append(f"{path}: Duplicate without user-selected canonical")
        if last_crawl != "unknown":
            try:
                crawl_date = datetime.fromisoformat(last_crawl.replace("Z", "+00:00"))
                days_since = (datetime.now(timezone.utc) - crawl_date).days
                if days_since > 30:
                    lines.append(f"- ⚠️ **Not crawled in {days_since} days**")
                    findings.append(f"{path}: Stale — not crawled in {days_since} days")
            except Exception:
                pass
        lines.append("")

    lines.append("## 🚨 Critical Findings")
    lines.append("")
    if findings:
        for f in findings:
            lines.append(f"- {f}")
    else:
        lines.append("_No critical issues detected._")
    lines.append("")

    lines.append("## ✅ Fix Checklist")
    lines.append("")
    if any("noindex" in f for f in findings):
        lines.append("- [ ] Review job expiration workflow — don't noindex filled jobs; add 'Similar Jobs' instead")
    if any("soft 404" in f for f in findings):
        lines.append("- [ ] Fix soft 404 pages — return proper 404 status or 301 to category page")
    if any("duplicate" in f for f in findings):
        lines.append("- [ ] Add canonical tags or consolidate duplicate pages")
    if any("Rich result errors" in f for f in findings):
        lines.append("- [ ] Fix JobPosting structured data — add missing required fields")
    if any("Stale" in f for f in findings):
        lines.append("- [ ] Submit updated sitemap or request reindexing for stale pages")
    lines.append("")
    lines.append("---")
    lines.append(f"_Generated at {datetime.now(timezone.utc).isoformat()}_")

    return "\n".join(lines)


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    log = context.get("log", print)
    artifact_dir = Path(context.get("artifact_dir", "out"))
    artifact_dir.mkdir(parents=True, exist_ok=True)
    site_url = inputs.get("site_url", "https://rocketlist.ai/")
    should_diagnose = inputs.get("run_diagnostics", True)

    today = date.today()
    current_end = today
    current_start = today - timedelta(days=28)
    previous_end = current_start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=28)

    log(f"Pulling GSC data for {site_url}")
    log(f"Current period: {current_start} → {current_end}")
    log(f"Previous period: {previous_start} → {previous_end}")

    current_rows, current_error = pull_gsc_data(site_url, current_start, current_end)
    previous_rows, previous_error = pull_gsc_data(site_url, previous_start, previous_end)

    log(f"Current rows: {len(current_rows)}")
    log(f"Previous rows: {len(previous_rows)}")

    if current_error:
        log(f"GSC current-period fetch failed: {current_error}")
        return {
            "status": "error",
            "error": f"GSC current-period fetch failed: {current_error}",
            "outputs": {},
            "artifacts": [],
        }
    if previous_error:
        log(f"GSC previous-period fetch failed: {previous_error}")

    if not current_rows:
        return {
            "status": "error",
            "error": f"No GSC rows returned for {site_url} between {current_start} and {current_end}",
            "outputs": {},
            "artifacts": [],
        }

    current_ds = build_dataset(current_rows)
    previous_ds = build_dataset(previous_rows)
    comparison = compare_datasets(current_ds, previous_ds)

    log("Generating SEO report...")
    seo_report = generate_seo_report(
        comparison, site_url, current_start, current_end, previous_start, previous_end
    )
    seo_file = artifact_dir / "seo_report.md"
    seo_file.write_text(seo_report)
    log(f"SEO report saved: {seo_file}")

    outputs = {"seo_report": seo_report}
    artifacts = [{"name": str(seo_file.name), "path": str(seo_file), "relative_path": str(seo_file), "type": "markdown"}]

    if should_diagnose:
        log("Running diagnostics...")
        # Extract top decayed paths for inspection
        decayed = sorted(
            [r for r in comparison if r.get("click_change_pct", 0) <= -THRESHOLDS["decline_threshold"]],
            key=lambda x: x.get("click_change", 0),
        )
        decayed_paths = []
        for r in decayed:
            page = r.get("page", "")
            if page and page not in decayed_paths:
                parsed = page.replace(site_url.rstrip("/"), "")
                decayed_paths.append(parsed)

        diagnostics = run_diagnostics(site_url, decayed_paths)
        diag_file = artifact_dir / "diagnostics.md"
        diag_file.write_text(diagnostics)
        log(f"Diagnostics saved: {diag_file}")
        outputs["diagnostics"] = diagnostics
        artifacts.append({"name": str(diag_file.name), "path": str(diag_file), "relative_path": str(diag_file), "type": "markdown"})
    else:
        diagnostics = (
            f"# GSC Diagnostics — {site_url} — {today.isoformat()}\n\n"
            "Diagnostics were skipped for this run because `run_diagnostics` was false.\n"
        )
        diag_file = artifact_dir / "diagnostics.md"
        diag_file.write_text(diagnostics)
        outputs["diagnostics"] = diagnostics
        artifacts.append({"name": str(diag_file.name), "path": str(diag_file), "relative_path": str(diag_file), "type": "markdown"})

    return {
        "status": "success",
        "outputs": outputs,
        "artifacts": artifacts,
    }


def main() -> None:
    try:
        with open("inputs.json") as f:
            inputs = json.load(f)
        result = run(inputs, {"log": print, "artifact_dir": "out"})
    except Exception as exc:
        result = {"status": "error", "error": str(exc)}
    with open("result.json", "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
