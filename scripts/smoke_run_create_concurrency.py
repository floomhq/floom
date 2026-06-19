#!/usr/bin/env python3
"""Create Workeros runs concurrently against a live API.

Used for S35 production smoke evidence. The script only verifies run-create
responses; it does not wait for worker execution to finish.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import time
from pathlib import Path
from typing import Any

import requests


def _read_secret(explicit: str | None) -> str:
    if explicit:
        return explicit.strip()
    env_secret = os.environ.get("FLOOM_SECRET", "").strip()
    if env_secret:
        return env_secret
    for path in (Path(".deploy-secret"), Path("/opt/workeros/.deploy-secret")):
        if path.is_file():
            return path.read_text().strip()
    raise SystemExit("FLOOM_SECRET or --secret is required")


def _post_run(base_url: str, secret: str, worker_id: str, index: int, timeout: float) -> dict[str, Any]:
    started = time.perf_counter()
    response = requests.post(
        f"{base_url.rstrip('/')}/workers/{worker_id}/runs",
        headers={"x-floom-secret": secret},
        json={"inputs": {}, "trigger_source": f"s35_concurrency_{index}"},
        timeout=timeout,
    )
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    try:
        body: Any = response.json()
    except Exception:
        body = response.text
    return {
        "index": index,
        "status_code": response.status_code,
        "elapsed_ms": elapsed_ms,
        "body": body,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=os.environ.get("WORKEROS_API_URL", "https://localhost:8000"))
    parser.add_argument("--secret", default=None)
    parser.add_argument("--worker", default="node-smoke-test")
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=45.0)
    args = parser.parse_args()

    secret = _read_secret(args.secret)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.count) as pool:
        futures = [
            pool.submit(_post_run, args.api, secret, args.worker, index, args.timeout)
            for index in range(args.count)
        ]
        results = [future.result() for future in concurrent.futures.as_completed(futures)]
    results.sort(key=lambda item: item["index"])

    failures = [
        item for item in results
        if item["status_code"] >= 500
        or "database is locked" in json.dumps(item["body"]).lower()
        or item["status_code"] not in {200}
    ]
    summary = {
        "api": args.api,
        "worker": args.worker,
        "count": args.count,
        "status_counts": {
            str(status): sum(1 for item in results if item["status_code"] == status)
            for status in sorted({item["status_code"] for item in results})
        },
        "max_elapsed_ms": max((item["elapsed_ms"] for item in results), default=0),
        "failures": failures,
        "run_ids": [
            item["body"].get("run_id")
            for item in results
            if isinstance(item["body"], dict) and item["body"].get("run_id")
        ],
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
