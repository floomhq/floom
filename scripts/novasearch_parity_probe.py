#!/usr/bin/env python3
"""NovaSearch old-vs-WorkerOS parity probe.

Default mode is old-backend baseline only. It calls guarded CRM-only fixtures
from docs/novasearch-migration/gold-fixtures.json and prints normalized
evidence. If --new-match-url is supplied later, the script compares the old
backend response with the WorkerOS response using the fixture thresholds.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURES_PATH = ROOT / "docs" / "novasearch-migration" / "gold-fixtures.json"


def _post_json(
    url: str,
    api_key: str | None,
    body: dict[str, Any],
    *,
    auth_header: str,
) -> dict[str, Any]:
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers[auth_header] = api_key
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = response.read().decode("utf-8")
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"HTTP {response.status}: {payload[:500]}")
            return json.loads(payload)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def _candidate_key(candidate: dict[str, Any]) -> str:
    for key in ("candidate_id", "id", "linkedin_url", "linkedinUrl", "url", "name"):
        value = str(candidate.get(key) or "").strip().lower()
        if value:
            return value
    return json.dumps(candidate, sort_keys=True)[:120].lower()


def _candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("curated_matches", "matches", "candidates", "top_candidates"):
        value = payload.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def _count(payload: dict[str, Any], key: str) -> int | None:
    value = payload.get(key)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def _downloadable_count(payload: dict[str, Any]) -> int | None:
    scalar = _count(payload, "downloadable_count")
    if scalar is not None:
        return scalar
    matches = payload.get("downloadable_matches")
    if isinstance(matches, list):
        return len(matches)
    available = payload.get("available_for_download")
    if isinstance(available, list):
        return len(available)
    return None


def _external_count(payload: dict[str, Any]) -> int:
    scalar = _count(payload, "external_count")
    if scalar is not None:
        return scalar
    candidates = _candidates(payload)
    return sum(
        1
        for item in candidates
        if str(item.get("source") or "").lower().startswith("external")
        or str(item.get("candidate_id") or "").lower().startswith("external")
    )


def _normalize(fixture_id: str, payload: dict[str, Any], elapsed_ms: float) -> dict[str, Any]:
    candidates = _candidates(payload)
    return {
        "fixture_id": fixture_id,
        "elapsed_ms": round(elapsed_ms, 2),
        "query_log_id": payload.get("query_log_id") or payload.get("query_id"),
        "ranking_version": payload.get("ranking_version") or (payload.get("job") or {}).get("ranking_version"),
        "total_scored": _count(payload, "total_scored"),
        "displayed_count": _count(payload, "displayed_count") or len(candidates),
        "downloadable_count": _downloadable_count(payload),
        "external_count": _external_count(payload),
        "curated_count": len(candidates),
        "top_keys": [_candidate_key(item) for item in candidates[:10]],
        "top_names": [str(item.get("name") or "").strip() for item in candidates[:10]],
        "raw_keys": sorted(payload.keys()),
    }


def _overlap(a: list[str], b: list[str]) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    aset = set(a)
    bset = set(b)
    return len(aset & bset) / max(1, min(len(aset), len(bset)))


def _compare(
    fixture: dict[str, Any],
    old_norm: dict[str, Any],
    new_norm: dict[str, Any],
    thresholds: dict[str, Any],
) -> dict[str, Any]:
    failures: list[str] = []
    top_overlap = _overlap(old_norm["top_keys"], new_norm["top_keys"])
    if top_overlap < float(thresholds["top_10_overlap_min"]):
        failures.append(f"top_10_overlap {top_overlap:.2f} below threshold")

    expected = fixture.get("expected") or {}
    if expected.get("non_empty") and new_norm["curated_count"] < 1:
        failures.append("expected non-empty curated results")

    if "curated_count" in expected and new_norm["curated_count"] != expected["curated_count"]:
        failures.append(f"curated_count expected {expected['curated_count']} got {new_norm['curated_count']}")

    if "downloadable_count" in expected:
        expected_count = int(expected["downloadable_count"])
        delta = abs((new_norm["downloadable_count"] or 0) - expected_count)
        if delta > int(thresholds["downloadable_count_delta_max"]):
            failures.append(f"downloadable_count delta {delta} above threshold")

    expected_external = expected.get("external_count", thresholds.get("external_count_expected"))
    if expected_external is not None and new_norm["external_count"] != int(expected_external):
        failures.append(f"external_count expected {expected_external} got {new_norm['external_count']}")

    return {
        "fixture_id": fixture["id"],
        "ok": not failures,
        "failures": failures,
        "top_10_overlap": round(top_overlap, 3),
        "old": old_norm,
        "new": new_norm,
    }


def _load_fixtures() -> dict[str, Any]:
    return json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))


def _run_one(
    url: str,
    api_key: str | None,
    fixture: dict[str, Any],
    *,
    auth_header: str,
) -> dict[str, Any]:
    start = time.perf_counter()
    payload = _post_json(url, api_key, fixture["request"], auth_header=auth_header)
    elapsed_ms = (time.perf_counter() - start) * 1000
    return _normalize(fixture["id"], payload, elapsed_ms)


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe NovaSearch parity fixtures")
    parser.add_argument("--fixtures", default=str(FIXTURES_PATH))
    parser.add_argument("--old-base", default=os.environ.get("NOVA_API_BASE", "https://nova-api.floom.dev"))
    parser.add_argument("--old-api-key", default=os.environ.get("NOVA_API_KEY") or os.environ.get("PILOT_API_KEY"))
    parser.add_argument("--new-match-url", default=os.environ.get("WORKEROS_NOVASEARCH_MATCH_URL"))
    parser.add_argument("--new-api-key", default=os.environ.get("WORKEROS_NOVASEARCH_API_KEY"))
    parser.add_argument("--old-auth-header", default=os.environ.get("NOVA_AUTH_HEADER", "x-api-key"))
    parser.add_argument("--new-auth-header", default=os.environ.get("WORKEROS_NOVASEARCH_AUTH_HEADER", "x-api-key"))
    parser.add_argument("--fixture", action="append", help="limit to fixture id; can be repeated")
    args = parser.parse_args()

    fixture_doc = json.loads(Path(args.fixtures).read_text(encoding="utf-8"))
    selected = set(args.fixture or [])
    fixtures = [
        item for item in fixture_doc["fixtures"]
        if not selected or item["id"] in selected
    ]
    if not fixtures:
        print("No fixtures selected", file=sys.stderr)
        return 2
    if not args.old_api_key:
        print("Old backend API key required via --old-api-key, NOVA_API_KEY, or PILOT_API_KEY", file=sys.stderr)
        return 2

    old_url = args.old_base.rstrip("/") + "/api/match"
    report: dict[str, Any] = {
        "schema_version": fixture_doc["schema_version"],
        "old_url": old_url,
        "new_match_url": args.new_match_url,
        "results": [],
    }
    failures = 0

    for fixture in fixtures:
        old_norm = _run_one(
            old_url,
            args.old_api_key,
            fixture,
            auth_header=args.old_auth_header,
        )
        if not args.new_match_url:
            report["results"].append({"fixture_id": fixture["id"], "old": old_norm})
            continue
        new_norm = _run_one(
            args.new_match_url,
            args.new_api_key,
            fixture,
            auth_header=args.new_auth_header,
        )
        result = _compare(fixture, old_norm, new_norm, fixture_doc["thresholds"])
        failures += 0 if result["ok"] else 1
        report["results"].append(result)

    print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
