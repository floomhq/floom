#!/usr/bin/env python3
"""Simple read-only latency probe for cloud API endpoints."""

from __future__ import annotations

import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass
class Sample:
    method: str
    path: str
    status: int
    elapsed_ms: float
    body_bytes: int
    error: str | None = None


def _request(base: str, token: str, method: str, path: str, workspace: str | None) -> Sample:
    url = f"{base.rstrip('/')}{path}"
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if workspace:
        headers["x-workeros-workspace"] = workspace
    req = urllib.request.Request(url, method=method, headers=headers)
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read()
            return Sample(method, path, int(resp.status), (time.perf_counter() - start) * 1000, len(body))
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return Sample(method, path, int(exc.code), (time.perf_counter() - start) * 1000, len(body), body[:200].decode("utf-8", "replace"))
    except Exception as exc:
        return Sample(method, path, 0, (time.perf_counter() - start) * 1000, 0, str(exc))


def main() -> int:
    base = os.environ.get("WORKEROS_SMOKE_API_BASE", "https://workeros-api.floom.dev")
    token = (os.environ.get("WORKEROS_SMOKE_TOKEN") or "").strip()
    workspace = (os.environ.get("WORKEROS_SMOKE_WORKSPACE") or "").strip() or None
    repeats = int(os.environ.get("WORKEROS_PERF_REPEATS") or "3")
    paths = [
        ("GET", "/healthz"),
        ("GET", "/api/workspaces"),
        ("GET", "/api/workers"),
        ("GET", "/api/workers?shape=list"),
        ("GET", "/api/workers?limit=20"),
        ("GET", "/api/workers?shape=list&limit=20"),
        ("GET", "/api/runs"),
        ("GET", "/api/runs?limit=20"),
        ("GET", "/api/runs?limit=5"),
        ("GET", "/api/runs?status=completed&limit=20"),
        ("GET", "/api/connections"),
        ("GET", "/api/system/overview"),
    ]
    if not token:
        print("WORKEROS_SMOKE_TOKEN is required for authenticated probes", file=sys.stderr)
        return 2

    all_samples: dict[str, list[Sample]] = {}
    for method, path in paths:
        key = f"{method} {path}"
        all_samples[key] = []
        for _ in range(repeats):
            sample = _request(base, token, method, path, workspace)
            all_samples[key].append(sample)
            print(
                json.dumps(
                    {
                        "endpoint": key,
                        "status": sample.status,
                        "elapsed_ms": round(sample.elapsed_ms, 1),
                        "body_bytes": sample.body_bytes,
                        "error": sample.error,
                    },
                    separators=(",", ":"),
                )
            )

    print("\nSUMMARY")
    for key, samples in all_samples.items():
        values = [s.elapsed_ms for s in samples]
        statuses = sorted({s.status for s in samples})
        print(
            f"{key:28} statuses={statuses} "
            f"min={min(values):7.1f}ms median={statistics.median(values):7.1f}ms max={max(values):7.1f}ms "
            f"bytes={samples[-1].body_bytes}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
