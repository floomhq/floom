#!/usr/bin/env python3
"""Comprehensive E2E test for Floom V0 API."""

import requests
import time
import sys

BASE = "http://localhost:8000"

def ok(r, expected_status=200):
    if r.status_code != expected_status:
        print(f"  FAIL: status {r.status_code}, body: {r.text[:200]}")
        return False
    return True

def test_health():
    print("\n[1] GET /workers (discovery)")
    r = requests.get(f"{BASE}/workers")
    if not ok(r): return False
    data = r.json()
    ids = [w["id"] for w in data]
    print(f"  Found workers: {ids}")
    assert "weekly_update" in ids, "weekly_update missing"
    assert "csv_enricher" in ids, "csv_enricher missing"
    assert "research_brief" in ids, "research_brief missing"
    print("  PASS")
    return True

def test_worker_detail():
    print("\n[2] GET /workers/{id}")
    r = requests.get(f"{BASE}/workers/weekly_update")
    if not ok(r): return False
    w = r.json()
    assert w["id"] == "weekly_update"
    assert w["config"]["inputs"]
    print(f"  Worker: {w['name']}, inputs: {len(w['config']['inputs'])}")
    print("  PASS")
    return True

def test_secrets():
    print("\n[3] GET /secrets")
    r = requests.get(f"{BASE}/secrets")
    if not ok(r): return False
    data = r.json()
    for s in data:
        print(f"  {s['name']}: {s['status']} (used by: {s['used_by']})")
    print("  PASS")
    return True

def test_reload():
    print("\n[4] POST /workers/reload")
    r = requests.post(f"{BASE}/workers/reload")
    if not ok(r): return False
    print(f"  Loaded: {r.json()['workers_loaded']}")
    print("  PASS")
    return True

def test_run_no_approval():
    print("\n[5] POST /workers/csv_enricher/runs (no approval)")
    r = requests.post(f"{BASE}/workers/csv_enricher/runs", json={
        "inputs": {
            "csv_text": "name,company\nAlice,Acme\nBob,Stark",
            "instruction": "Add a note about each company size"
        },
        "trigger_source": "manual"
    })
    if not ok(r): return False
    run_id = r.json()["run_id"]
    print(f"  Run ID: {run_id}")

    # Poll for completion
    for i in range(20):
        time.sleep(1)
        r2 = requests.get(f"{BASE}/runs/{run_id}")
        if not ok(r2): return False
        run = r2.json()
        print(f"  Poll {i+1}: status={run['status']}, logs={len(run['logs'])}")
        if run["status"] in ("completed", "failed", "pending_approval"):
            break

    assert run["status"] == "completed", f"Expected completed, got {run['status']}"
    assert run["output"], "No output"
    assert "enriched_csv" in run["output"], "Missing enriched_csv output"
    print("  PASS")
    return True

def test_run_with_approval():
    print("\n[6] POST /workers/weekly_update/runs (with approval)")
    r = requests.post(f"{BASE}/workers/weekly_update/runs", json={
        "inputs": {
            "notes": "Closed 4 pilots. Shipped onboarding.",
            "audience": "investor"
        },
        "trigger_source": "manual"
    })
    if not ok(r): return False
    run_id = r.json()["run_id"]
    print(f"  Run ID: {run_id}")

    # Poll for pending approval
    for i in range(20):
        time.sleep(1)
        r2 = requests.get(f"{BASE}/runs/{run_id}")
        if not ok(r2): return False
        run = r2.json()
        print(f"  Poll {i+1}: status={run['status']}, logs={len(run['logs'])}")
        if run["status"] in ("completed", "failed", "pending_approval"):
            break

    assert run["status"] == "pending_approval", f"Expected pending_approval, got {run['status']}"
    assert run["approval"], "No approval created"
    assert run["output"], "No output"
    assert "update" in run["output"], "Missing update output"
    print("  Output preview:", run["output"]["update"][:80].replace("\n", " "), "...")

    # Test approvals list
    r3 = requests.get(f"{BASE}/approvals?status=pending")
    if not ok(r3): return False
    approvals = r3.json()
    assert any(a["run_id"] == run_id for a in approvals), "Run not in approvals list"
    print(f"  Pending approvals: {len(approvals)}")

    # Approve
    r4 = requests.post(f"{BASE}/runs/{run_id}/approve")
    if not ok(r4): return False
    print(f"  Approval response: {r4.json()}")

    r5 = requests.get(f"{BASE}/runs/{run_id}")
    run5 = r5.json()
    assert run5["status"] == "approved", f"Expected approved, got {run5['status']}"
    print("  PASS")
    return True

def test_research_brief():
    print("\n[7] POST /workers/research_brief/runs")
    r = requests.post(f"{BASE}/workers/research_brief/runs", json={
        "inputs": {
            "topic": "AI agents in customer support",
            "audience": "executive",
            "depth": "overview"
        },
        "trigger_source": "manual"
    })
    if not ok(r): return False
    run_id = r.json()["run_id"]
    print(f"  Run ID: {run_id}")

    for i in range(20):
        time.sleep(1)
        r2 = requests.get(f"{BASE}/runs/{run_id}")
        run = r2.json()
        print(f"  Poll {i+1}: status={run['status']}, logs={len(run['logs'])}")
        if run["status"] in ("completed", "failed", "pending_approval"):
            break

    assert run["status"] == "pending_approval", f"Expected pending_approval, got {run['status']}"
    assert "brief" in run["output"], "Missing brief output"
    print("  Output preview:", run["output"]["brief"][:80].replace("\n", " "), "...")

    # Reject
    r3 = requests.post(f"{BASE}/runs/{run_id}/reject", json={"reason": "Too short"})
    if not ok(r3): return False
    r4 = requests.get(f"{BASE}/runs/{run_id}")
    run4 = r4.json()
    assert run4["status"] == "rejected", f"Expected rejected, got {run4['status']}"
    print("  PASS")
    return True

def test_runs_list():
    print("\n[8] GET /runs")
    r = requests.get(f"{BASE}/runs?limit=10")
    if not ok(r): return False
    data = r.json()
    print(f"  Total runs returned: {len(data)}")
    assert len(data) >= 3, "Expected at least 3 runs"
    print("  PASS")
    return True

def test_logs():
    print("\n[9] GET /runs/{id}/logs")
    r = requests.get(f"{BASE}/runs")
    runs = r.json()
    if not runs:
        print("  SKIP: no runs")
        return True
    run_id = runs[0]["id"]
    r2 = requests.get(f"{BASE}/runs/{run_id}/logs")
    if not ok(r2): return False
    logs = r2.json()
    print(f"  Logs for {run_id}: {len(logs)} entries")
    print("  PASS")
    return True

def main():
    print("=" * 60)
    print("FLOOM V0 — FULL E2E TEST SUITE")
    print("=" * 60)

    tests = [
        test_health,
        test_worker_detail,
        test_secrets,
        test_reload,
        test_run_no_approval,
        test_run_with_approval,
        test_research_brief,
        test_runs_list,
        test_logs,
    ]

    passed = 0
    failed = 0
    for t in tests:
        try:
            if t():
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"  EXCEPTION: {e}")
            failed += 1

    print("\n" + "=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed out of {len(tests)}")
    print("=" * 60)
    return failed == 0

if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
