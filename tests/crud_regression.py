#!/usr/bin/env python3
"""CRUD regression tests for secrets, runs filters, export, and worker pause/unpause.

Deterministic suite that verifies CRUD operations against the live API.
Exits non-zero on any failure.

Usage:
    python3 tests/crud_regression.py
    python3 tests/crud_regression.py --base https://workers-api.floom.dev

Environment:
    FLOOM_API_BASE   — overrides --base (default: http://localhost:8000)
    FLOOM_API_SECRET — x-floom-secret header (required for prod)
"""

import argparse
import json
import os
import sys
import time
import requests

BASE = os.environ.get("FLOOM_API_BASE", "http://localhost:8000")
SECRET = os.environ.get("FLOOM_API_SECRET", "")

HEADERS: dict[str, str] = {}
if SECRET:
    HEADERS["x-floom-secret"] = SECRET

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  {PASS}  {name}")
    else:
        print(f"  {FAIL}  {name}" + (f": {detail}" if detail else ""))
        failures.append(name)


def get(path: str, params: dict | None = None) -> requests.Response:
    return requests.get(f"{BASE}{path}", headers=HEADERS, params=params, timeout=15)


def post(path: str, body: dict | None = None) -> requests.Response:
    return requests.post(
        f"{BASE}{path}",
        headers={**HEADERS, "Content-Type": "application/json"},
        json=body or {},
        timeout=15,
    )


def delete(path: str) -> requests.Response:
    return requests.delete(f"{BASE}{path}", headers=HEADERS, timeout=15)


# ---------------------------------------------------------------------------
# Test group 1: Secrets CRUD
# ---------------------------------------------------------------------------

TEST_SECRET_NAME = "CRUD_TEST_DUMMY_SECRET_XYZ"
TEST_SECRET_VALUE = "crud-test-value-12345"


def test_secrets_crud() -> None:
    print("\n[Secrets CRUD]")

    # Ensure clean state: delete if already exists
    delete(f"/secrets/{TEST_SECRET_NAME}")

    # 1. POST add
    r = post(f"/secrets/{TEST_SECRET_NAME}", {"value": TEST_SECRET_VALUE})
    check("POST /secrets/{name} returns 200", r.status_code == 200,
          f"got {r.status_code}: {r.text[:200]}")
    body = r.json()
    check("POST response has status field", "status" in body, str(body))

    # 2. GET list — secret must appear
    r = get("/secrets")
    check("GET /secrets returns 200", r.status_code == 200, r.text[:200])
    secrets = r.json()
    names = [s["name"] for s in secrets]
    check(f"GET /secrets lists {TEST_SECRET_NAME} after add", TEST_SECRET_NAME in names,
          f"found: {names[:10]}")

    # Verify used_by is present (may be empty for user-added secrets)
    matching = [s for s in secrets if s["name"] == TEST_SECRET_NAME]
    if matching:
        check("Secret entry has used_by field", "used_by" in matching[0], str(matching[0]))
        check("User-added secret has used_by as list", isinstance(matching[0].get("used_by"), list),
              str(matching[0]))

    # 3. POST test — should return "valid" (secret is set)
    r = post(f"/secrets/{TEST_SECRET_NAME}/test")
    check("POST /secrets/{name}/test returns 200", r.status_code == 200, r.text[:200])
    body = r.json()
    check("Test result has status field", "status" in body, str(body))
    check("Generic secret test returns 'valid'", body.get("status") == "valid", str(body))

    # 4. DELETE
    r = delete(f"/secrets/{TEST_SECRET_NAME}")
    check("DELETE /secrets/{name} returns 200", r.status_code == 200, r.text[:200])

    # 5. GET list — secret must be gone
    r = get("/secrets")
    check("GET /secrets returns 200 after delete", r.status_code == 200)
    secrets = r.json()
    names = [s["name"] for s in secrets]
    check(f"GET /secrets no longer lists {TEST_SECRET_NAME} after delete",
          TEST_SECRET_NAME not in names, f"still found in: {names[:10]}")


# ---------------------------------------------------------------------------
# Test group 2: Runs filter correctness
# ---------------------------------------------------------------------------

def test_runs_filters() -> None:
    print("\n[Runs Filters]")

    # Get all workers
    r = get("/workers")
    if r.status_code != 200 or not r.json():
        print("  SKIP  no workers available, skipping filter tests")
        return
    workers = r.json()
    first_worker_id = workers[0]["id"]

    # Filter by worker_id
    r = get("/runs", {"worker_id": first_worker_id, "limit": 50, "offset": 0})
    check(f"GET /runs?worker_id={first_worker_id} returns 200", r.status_code == 200,
          r.text[:200])
    if r.status_code == 200:
        runs = r.json()
        wrong = [run for run in runs if run["worker_id"] != first_worker_id]
        check("All runs match the worker_id filter", len(wrong) == 0,
              f"{len(wrong)} runs have wrong worker_id")

    # Filter by status=completed
    r = get("/runs", {"status": "completed", "limit": 50, "offset": 0})
    check("GET /runs?status=completed returns 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        runs = r.json()
        wrong = [run for run in runs if run["status"] != "completed"]
        check("All runs match status=completed filter", len(wrong) == 0,
              f"{len(wrong)} runs have wrong status")

    # Combined filter: worker_id + status
    r = get("/runs", {"worker_id": first_worker_id, "status": "completed", "limit": 50, "offset": 0})
    check("GET /runs?worker_id=X&status=completed returns 200", r.status_code == 200,
          r.text[:200])
    if r.status_code == 200:
        runs = r.json()
        wrong = [run for run in runs
                 if run["worker_id"] != first_worker_id or run["status"] != "completed"]
        check("Combined filter AND logic correct", len(wrong) == 0,
              f"{len(wrong)} runs fail combined filter")


# ---------------------------------------------------------------------------
# Test group 3: Export (high-limit fetch)
# ---------------------------------------------------------------------------

def test_runs_export() -> None:
    print("\n[Runs Export (paginated full-history fetch)]")

    # Fetch with API max limit (500) — represents what Export CSV does per page
    r = get("/runs", {"limit": 500, "offset": 0})
    check("GET /runs?limit=500 returns 200", r.status_code == 200, r.text[:200])
    if r.status_code == 200:
        runs = r.json()
        check("High-limit fetch returns a list", isinstance(runs, list), type(runs).__name__)
        # Fetch with default limit (20) to compare
        r2 = get("/runs", {"limit": 20, "offset": 0})
        if r2.status_code == 200:
            default_runs = r2.json()
            check("High-limit fetch returns >= default page fetch",
                  len(runs) >= len(default_runs),
                  f"high={len(runs)} default={len(default_runs)}")

    # Also verify pagination works: offset=0 and offset=1 return different first runs
    r1 = get("/runs", {"limit": 1, "offset": 0})
    r2 = get("/runs", {"limit": 1, "offset": 1})
    if r1.status_code == 200 and r2.status_code == 200:
        runs1 = r1.json()
        runs2 = r2.json()
        if runs1 and runs2:
            check("Pagination: offset=0 and offset=1 return different runs",
                  runs1[0]["id"] != runs2[0]["id"],
                  f"both returned {runs1[0]['id']}")


# ---------------------------------------------------------------------------
# Test group 4: Worker pause / unpause
# ---------------------------------------------------------------------------

def test_worker_pause_unpause() -> None:
    print("\n[Worker Pause / Unpause]")

    r = get("/workers")
    if r.status_code != 200 or not r.json():
        print("  SKIP  no workers available")
        return
    workers = r.json()
    w = workers[0]
    worker_id = w["id"]

    # Pause
    r = post(f"/workers/{worker_id}/pause")
    check(f"POST /workers/{worker_id}/pause returns 200", r.status_code == 200, r.text[:200])

    # Verify paused=true
    r = get(f"/workers/{worker_id}")
    check("GET /workers/{id} returns 200 after pause", r.status_code == 200)
    if r.status_code == 200:
        check("Worker shows paused=true after pause", r.json().get("paused") is True,
              str(r.json().get("paused")))

    # Unpause
    r = post(f"/workers/{worker_id}/unpause")
    check(f"POST /workers/{worker_id}/unpause returns 200", r.status_code == 200, r.text[:200])

    # Verify paused=false
    r = get(f"/workers/{worker_id}")
    check("GET /workers/{id} returns 200 after unpause", r.status_code == 200)
    if r.status_code == 200:
        check("Worker shows paused=false after unpause",
              r.json().get("paused") in (False, None),
              str(r.json().get("paused")))


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def main() -> None:
    global BASE, HEADERS, SECRET

    parser = argparse.ArgumentParser(description="Workeros CRUD regression tests")
    parser.add_argument("--base", default=BASE, help="API base URL")
    args = parser.parse_args()
    BASE = args.base.rstrip("/")

    SECRET = os.environ.get("FLOOM_API_SECRET", "")
    HEADERS.clear()
    if SECRET:
        HEADERS["x-floom-secret"] = SECRET

    print(f"Running CRUD regression tests against {BASE}")

    test_secrets_crud()
    test_runs_filters()
    test_runs_export()
    test_worker_pause_unpause()

    print()
    if failures:
        print(f"\033[91m{len(failures)} test(s) FAILED:\033[0m")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    else:
        total = (
            12  # secrets: 7 checks
            # runs filters: 6
            # export: 3
            # pause/unpause: 6
        )
        print("\033[92mAll CRUD regression tests PASSED\033[0m")
        sys.exit(0)


if __name__ == "__main__":
    main()
