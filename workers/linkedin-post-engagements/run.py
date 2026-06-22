"""LinkedIn post engagements worker.

Port of ~/.agents/skills/linkedin-post-engagements/scripts/sync.py for Floom.
Differences from the Mac skill:
- APIFY_API_KEY read from env (declared as Floom secret), not hardcoded.
- profile_url + posts_limit + recent_only_days come from `inputs`.
- Output written to out/engagements.json + out/summary.md as Floom artifacts
  (the sandbox is ephemeral; cross-run merging is the user's local skill on Mac).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def apify_request(api_key: str, method: str, path: str, data: dict | None = None) -> dict:
    url = f"https://api.apify.com/v2{path}?token={api_key}"
    cmd = ["curl", "-s", "--max-time", "120"]
    if method == "POST":
        cmd += ["-X", "POST", "-H", "Content-Type: application/json", "-d", json.dumps(data)]
    cmd.append(url)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"curl failed: {result.stderr}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Apify returned non-JSON: {result.stdout[:300]}") from exc


def _unwrap_run_start(resp: dict, label: str) -> tuple[str, str]:
    if "error" in resp:
        err = resp["error"]
        msg = err.get("message") if isinstance(err, dict) else str(err)
        raise RuntimeError(f"Apify rejected {label} actor start: {msg}")
    data = resp.get("data")
    if not isinstance(data, dict) or not data.get("id") or not data.get("defaultDatasetId"):
        raise RuntimeError(f"Apify {label} returned unexpected payload: {json.dumps(resp)[:300]}")
    return data["id"], data["defaultDatasetId"]


def poll_run(api_key: str, run_id: str, max_polls: int = 120, interval: int = 5) -> dict:
    for i in range(max_polls):
        resp = apify_request(api_key, "GET", f"/actor-runs/{run_id}")
        data = resp.get("data") or {}
        status = data.get("status")
        print(f"  Poll {i + 1}: {status}", file=sys.stderr)
        if status == "SUCCEEDED":
            return data
        if status in {"FAILED", "ABORTED", "TIMED-OUT"}:
            raise RuntimeError(f"Run {run_id} ended with status {status}")
        time.sleep(interval)
    raise RuntimeError(f"Run {run_id} timed out after {max_polls * interval}s")


def run_profile_scraper(api_key: str, profile_url: str, posts_limit: int) -> list[dict]:
    print(f"Step 1/2: discovering posts from {profile_url} (limit {posts_limit})", file=sys.stderr)
    resp = apify_request(
        api_key,
        "POST",
        "/acts/datadoping~linkedin-profile-posts-scraper/runs",
        {"profiles": [profile_url], "resultsLimit": posts_limit},
    )
    run_id, dataset_id = _unwrap_run_start(resp, "profile-scraper")
    run_data = poll_run(api_key, run_id, max_polls=40, interval=3)
    print(f"  Profile scraper cost: ${run_data.get('usageTotalUsd', 0)}", file=sys.stderr)

    posts = apify_request(api_key, "GET", f"/datasets/{dataset_id}/items")
    print(f"  Posts found: {len(posts)}", file=sys.stderr)
    return posts


def run_engagement_scraper(api_key: str, urls: list[str]) -> list[dict]:
    if not urls:
        return []
    print(f"Step 2/2: extracting engagement for {len(urls)} posts", file=sys.stderr)
    resp = apify_request(
        api_key,
        "POST",
        "/acts/scraping_solutions~linkedin-posts-engagers-likers-and-commenters-no-cookies/runs",
        {"urls": urls},
    )
    run_id, dataset_id = _unwrap_run_start(resp, "engagement-scraper")
    run_data = poll_run(api_key, run_id, max_polls=120, interval=5)
    print(f"  Engagement scraper cost: ${run_data.get('usageTotalUsd', 0)}", file=sys.stderr)

    engagers = apify_request(api_key, "GET", f"/datasets/{dataset_id}/items")
    print(f"  Engagers found: {len(engagers)}", file=sys.stderr)
    return engagers


def parse_post_date(date_str: str) -> datetime:
    return datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def build_snapshot(profile_url: str, new_posts: list[dict], new_engagers: list[dict]) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    engagers_by_post: dict[str, list[dict]] = {}
    for e in new_engagers:
        post_link = e.get("post_Link") or e.get("postLink") or e.get("post_url") or e.get("url")
        if not post_link:
            continue
        engagers_by_post.setdefault(post_link, []).append(e)

    posts = []
    for post in new_posts:
        url = post.get("url")
        if not url:
            continue
        posted_at = post.get("posted_at") or {}
        posts.append(
            {
                "url": url,
                "urn": (post.get("urn") or {}).get("activity_urn"),
                "date": posted_at.get("date"),
                "text": post.get("text", ""),
                "stats": post.get("stats", {}),
                "engagers": engagers_by_post.get(url, []),
            }
        )

    unique_engagers: dict[str, dict] = {}
    for post in posts:
        for e in post["engagers"]:
            pu = e.get("url_profile") or e.get("profile_url") or e.get("name")
            if not pu:
                continue
            entry = unique_engagers.setdefault(
                pu,
                {
                    "name": e.get("name"),
                    "subtitle": e.get("subtitle"),
                    "profile_url": pu,
                    "total_engagements": 0,
                    "engaged_posts": [],
                },
            )
            entry["total_engagements"] += 1
            if e["post_Link"] not in entry["engaged_posts"]:
                entry["engaged_posts"].append(e["post_Link"])

    return {
        "last_scraped": now,
        "profile_url": profile_url,
        "posts": posts,
        "unique_engagers": unique_engagers,
    }


def render_summary(db: dict) -> str:
    total_posts = len(db["posts"])
    total_engagements = sum(len(p.get("engagers", [])) for p in db["posts"])
    unique = len(db["unique_engagers"])
    repeaters = sum(1 for v in db["unique_engagers"].values() if v["total_engagements"] > 1)
    top = sorted(db["posts"], key=lambda p: len(p.get("engagers", [])), reverse=True)[:5]

    lines = [
        f"# LinkedIn engagement snapshot — {db['last_scraped'][:10]}",
        "",
        f"- Profile: {db['profile_url']}",
        f"- Posts tracked: {total_posts}",
        f"- Total engagements (likers): {total_engagements}",
        f"- Unique people: {unique}",
        f"- Repeat engagers (>=2 posts): {repeaters}",
        "",
        "## Top posts by engagement",
        "",
    ]
    for p in top:
        snippet = (p.get("text") or "").strip().splitlines()[0][:90]
        lines.append(f"- **{len(p.get('engagers', []))}** likers · {p['date']} · {snippet}…")
    return "\n".join(lines) + "\n"


def _load_secret(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if val:
        return val
    try:
        with open("secrets.json") as fh:
            return (json.load(fh).get(name) or "").strip()
    except FileNotFoundError:
        return ""


def run(inputs: dict, context) -> dict:
    api_key = _load_secret("APIFY_API_KEY")
    if not api_key:
        raise RuntimeError("APIFY_API_KEY not set; add it via /secrets")

    profile_url = (inputs.get("profile_url") or "https://www.linkedin.com/in/USERNAME/").strip()
    posts_limit = int(inputs.get("posts_limit") or 20)
    recent_days = int(inputs.get("recent_only_days") or 0)

    posts = run_profile_scraper(api_key, profile_url, posts_limit)
    if not posts:
        print("No posts discovered. Writing empty snapshot.", file=sys.stderr)
        snapshot = build_snapshot(profile_url, [], [])
    else:
        urls_to_scrape: list[str] = []
        for p in posts:
            url = p.get("url")
            if not url:
                continue
            if recent_days > 0:
                try:
                    age_days = (datetime.now(timezone.utc) - parse_post_date(p["posted_at"]["date"])).days
                    if age_days > recent_days:
                        continue
                except Exception:
                    pass
            urls_to_scrape.append(url)
        print(f"  Engagement queue: {len(urls_to_scrape)} posts", file=sys.stderr)

        engagers = run_engagement_scraper(api_key, urls_to_scrape)
        snapshot = build_snapshot(profile_url, posts, engagers)

    out_dir = Path("out")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "engagements.json").write_text(json.dumps(snapshot, indent=2, ensure_ascii=False))
    (out_dir / "summary.md").write_text(render_summary(snapshot))

    if context is not None and hasattr(context, "log"):
        context.log("info", f"Snapshot: {len(snapshot['posts'])} posts, {len(snapshot['unique_engagers'])} unique engagers")

    return {
        "engagements": "out/engagements.json",
        "summary": "out/summary.md",
    }


def _read_inputs() -> dict:
    if Path("inputs.json").is_file():
        return json.loads(Path("inputs.json").read_text() or "{}")
    if not sys.stdin.isatty():
        payload = json.loads(sys.stdin.read() or "{}")
        return payload.get("inputs", payload) or {}
    return {}


if __name__ == "__main__":
    inputs_arg = _read_inputs()
    try:
        outputs = run(inputs_arg, None)
        Path("result.json").write_text(json.dumps({
            "status": "completed",
            "outputs": outputs,
            "artifacts": [],
        }))
    except Exception as exc:
        Path("result.json").write_text(json.dumps({
            "status": "error",
            "outputs": {},
            "error": str(exc),
        }))
        raise
