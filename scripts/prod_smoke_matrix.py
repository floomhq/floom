#!/usr/bin/env python3
"""Automated production smoke matrix for all active stock workers.

Usage:
    FLOOM_SECRET=<secret> python scripts/prod_smoke_matrix.py
    FLOOM_SECRET=<secret> python scripts/prod_smoke_matrix.py --api-base http://localhost:8000
    FLOOM_SECRET=<secret> python scripts/prod_smoke_matrix.py --workers research_brief,weekly_update

Results are written to docs/workers/SMOKE-RESULTS-YYYY-MM-DD.md.

Environment:
    FLOOM_SECRET   required   Operator secret for API authentication
    FLOOM_API_BASE optional   API base URL (default: http://localhost:8000)
    SMOKE_TIMEOUT  optional   Per-worker timeout in seconds (default: 300)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    import requests
except ImportError:
    print("ERROR: 'requests' not installed. Run: pip install requests", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKERS_DIR = REPO_ROOT / "workers"
DOCS_DIR = REPO_ROOT / "docs" / "workers"

# Workers covered by the automated smoke matrix.
# Long-running workers (e.g. opendraft ~44min) get a short run + cancel test.
_DEFAULT_WORKERS: List[Dict[str, Any]] = [
    # Agent workers
    {"id": "research_brief", "inputs": {"topic": "AI safety"}, "mode": "agent"},
    {"id": "weekly_update", "inputs": {"notes": "Shipped smoke matrix script"}, "mode": "agent"},
    # E2B script workers
    {"id": "node-smoke-test", "inputs": {}, "mode": "e2b"},
    {"id": "csv_enricher", "inputs": {}, "mode": "e2b"},
    {"id": "gmail_intake_brief", "inputs": {}, "mode": "e2b"},
    {"id": "cv_writeup", "inputs": {}, "mode": "e2b"},
    # Long-running — smoke start + cancel, don't wait for completion
    {"id": "opendraft", "inputs": {}, "mode": "e2b", "cancel_after_seconds": 15},
]

_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})


def _api(base: str, secret: str) -> "ApiClient":
    return ApiClient(base, secret)


class ApiClient:
    def __init__(self, base: str, secret: str) -> None:
        self.base = base.rstrip("/")
        self.headers = {"X-Floom-Secret": secret}

    def post(self, path: str, json: Any = None) -> requests.Response:
        return requests.post(
            f"{self.base}{path}", json=json, headers=self.headers, timeout=30
        )

    def get(self, path: str) -> requests.Response:
        return requests.get(f"{self.base}{path}", headers=self.headers, timeout=30)


def trigger_run(api: ApiClient, worker_id: str, inputs: Dict[str, Any]) -> Optional[str]:
    try:
        resp = api.post(f"/workers/{worker_id}/runs", json={"inputs": inputs})
        if resp.status_code == 200:
            data = resp.json()
            return data.get("run_id")
        print(f"  [ERROR] POST /workers/{worker_id}/runs -> {resp.status_code}: {resp.text[:200]}")
        return None
    except Exception as exc:
        print(f"  [ERROR] {worker_id} trigger failed: {exc}")
        return None


def poll_run(
    api: ApiClient,
    run_id: str,
    *,
    timeout: int = 300,
    cancel_after: Optional[int] = None,
) -> Dict[str, Any]:
    started = time.monotonic()
    cancelled = False
    while True:
        elapsed = time.monotonic() - started
        if cancel_after and not cancelled and elapsed >= cancel_after:
            try:
                api.post(f"/runs/{run_id}/cancel")
                cancelled = True
                print(f"    Cancelled after {cancel_after}s (long-run smoke)")
            except Exception as exc:
                print(f"    Cancel failed: {exc}")

        if elapsed > timeout:
            return {"status": "timeout", "elapsed": elapsed}

        try:
            resp = api.get(f"/runs/{run_id}")
            data = resp.json()
            status = data.get("status", "unknown")
            if status in _TERMINAL_STATUSES:
                return {"status": status, "elapsed": elapsed, "error": data.get("error")}
        except Exception:
            pass

        time.sleep(3)


def run_smoke_matrix(
    workers: List[Dict[str, Any]],
    api: ApiClient,
    timeout: int,
) -> List[Dict[str, Any]]:
    results = []
    for spec in workers:
        worker_id = spec["id"]
        inputs = spec.get("inputs", {})
        cancel_after = spec.get("cancel_after_seconds")
        print(f"\n[SMOKE] {worker_id} ...", flush=True)

        run_id = trigger_run(api, worker_id, inputs)
        if run_id is None:
            results.append({"worker_id": worker_id, "status": "trigger_failed", "run_id": None, "elapsed": 0})
            print(f"  FAIL (could not trigger)")
            continue

        print(f"  run_id={run_id} — polling ...", flush=True)
        result = poll_run(api, run_id, timeout=timeout, cancel_after=cancel_after)
        result["worker_id"] = worker_id
        result["run_id"] = run_id
        results.append(result)

        status_emoji = "✓" if result["status"] in ("completed", "cancelled") else "✗"
        print(f"  {status_emoji} {result['status']} in {result['elapsed']:.1f}s", flush=True)
        if result.get("error"):
            print(f"    error: {result['error'][:150]}")

    return results


def write_results(results: List[Dict[str, Any]], date_str: str) -> Path:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DOCS_DIR / f"SMOKE-RESULTS-{date_str}.md"
    passed = [r for r in results if r["status"] in ("completed", "cancelled")]
    failed = [r for r in results if r["status"] not in ("completed", "cancelled")]

    lines = [
        f"# Prod Smoke Results — {date_str}",
        "",
        f"**{len(passed)}/{len(results)} passed**",
        "",
        "| Worker | Status | Elapsed | Run ID |",
        "| --- | --- | --- | --- |",
    ]
    for r in results:
        status_icon = "✓" if r["status"] in ("completed", "cancelled") else "✗"
        elapsed = f"{r['elapsed']:.1f}s" if r.get("elapsed") else "—"
        lines.append(f"| {r['worker_id']} | {status_icon} {r['status']} | {elapsed} | {r.get('run_id') or '—'} |")

    if failed:
        lines += ["", "## Failures", ""]
        for r in failed:
            lines.append(f"### {r['worker_id']}")
            lines.append(f"- status: `{r['status']}`")
            if r.get("error"):
                lines.append(f"- error: {r['error']}")
            lines.append("")

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Run prod smoke matrix for all active workers")
    parser.add_argument("--api-base", default=os.environ.get("FLOOM_API_BASE", "http://localhost:8000"))
    parser.add_argument("--workers", help="Comma-separated worker IDs to smoke (default: all)")
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("SMOKE_TIMEOUT", "300")))
    args = parser.parse_args()

    secret = os.environ.get("FLOOM_SECRET", "")
    if not secret:
        print("ERROR: FLOOM_SECRET env var is required", file=sys.stderr)
        sys.exit(1)

    api = ApiClient(args.api_base, secret)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    workers = _DEFAULT_WORKERS
    if args.workers:
        wanted = set(args.workers.split(","))
        workers = [w for w in _DEFAULT_WORKERS if w["id"] in wanted]
        if not workers:
            print(f"ERROR: none of {wanted} found in the default smoke matrix", file=sys.stderr)
            sys.exit(1)

    print(f"Smoke matrix: {len(workers)} workers against {args.api_base}")
    results = run_smoke_matrix(workers, api, args.timeout)

    out_path = write_results(results, date_str)
    print(f"\nResults written to: {out_path}")

    passed = sum(1 for r in results if r["status"] in ("completed", "cancelled"))
    if passed < len(results):
        print(f"\nFAILED: {len(results) - passed}/{len(results)} workers did not pass", file=sys.stderr)
        sys.exit(1)
    print(f"\nAll {len(results)} workers passed.")


if __name__ == "__main__":
    main()
