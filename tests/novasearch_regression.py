#!/usr/bin/env python3
"""NovaSearch regression fixtures.

Deterministic suite that verifies each NovaSearch worker against
specific criteria. Exits non-zero on any failure.

Usage:
    python3 tests/novasearch_regression.py
    python3 tests/novasearch_regression.py --base http://localhost:8000

Environment:
    FLOOM_API_BASE  — overrides --base (default: http://localhost:8000)
    FLOOM_API_SECRET — x-floom-secret header (optional for local dev)
"""

import argparse
import csv
import io
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

POLL_INTERVAL = 2
MAX_POLLS = 45  # 90 seconds max per run

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def api(method: str, path: str, **kwargs) -> requests.Response:
    url = f"{BASE}{path}"
    kwargs.setdefault("headers", {}).update(HEADERS)
    return getattr(requests, method)(url, **kwargs)


def wait_for_run(run_id: str, expected_terminal_statuses=("completed", "failed", "pending_approval", "approved", "rejected")) -> dict:
    """Poll until the run reaches a terminal status."""
    for _ in range(MAX_POLLS):
        time.sleep(POLL_INTERVAL)
        r = api("get", f"/runs/{run_id}")
        if r.status_code != 200:
            raise RuntimeError(f"GET /runs/{run_id} returned {r.status_code}: {r.text[:200]}")
        run = r.json()
        if run["status"] in expected_terminal_statuses:
            return run
    raise TimeoutError(f"Run {run_id} did not complete in {MAX_POLLS * POLL_INTERVAL}s")


def start_run(worker_id: str, inputs: dict) -> str:
    r = api("post", f"/workers/{worker_id}/runs", json={
        "inputs": inputs,
        "trigger_source": "novasearch_regression",
    })
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Failed to start {worker_id} run: {r.status_code} {r.text[:200]}")
    return r.json()["run_id"]


def parse_csv(text: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(text.strip()))
    return list(reader)


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

results: list[dict] = []


def test(name: str):
    """Decorator for test functions — records pass/fail."""
    def decorator(fn):
        def wrapper():
            print(f"\n[TEST] {name}")
            try:
                fn()
                print(f"  PASS: {name}")
                results.append({"name": name, "status": "PASS"})
                return True
            except AssertionError as exc:
                msg = str(exc) or "Assertion failed"
                print(f"  FAIL: {name} — {msg}")
                results.append({"name": name, "status": "FAIL", "reason": msg})
                return False
            except Exception as exc:
                print(f"  ERROR: {name} — {exc}")
                results.append({"name": name, "status": "ERROR", "reason": str(exc)})
                return False
        wrapper.__name__ = fn.__name__
        return wrapper
    return decorator


# ── reverse_match_crm ───────────────────────────────────────────────────────

CRM_CSV = """name,email,current_company,current_title,headline,last_active_iso,skills,notes
Anna Keller,anna@example.com,Solaris,Senior Java Engineer,,2024-03-01,Java;Kafka;Spring Boot,Available May
Mehmet Yilmaz,mehmet@example.com,N26,Java Backend Engineer,,2024-02-15,Java;Spring;REST API,6-month contract OK
Julia Schneider,julia@example.com,Deutsche Bank,SAP FI/CO Consultant,,2024-01-20,SAP;ABAP;HANA,Perm only
Hans Meier,hans@example.com,Commerzbank,Frontend Developer,,2023-08-01,React;TypeScript;CSS,Looking for perm"""

JOB_BRIEF_JAVA = "Senior Java Backend Engineer, FinTech client in Berlin, 6-12 month AÜG contract, DACH market, €750-850/day."


@test("reverse_match_crm: Anna or Mehmet ranks in top 1 for Java FinTech brief")
def test_reverse_match_crm_top1():
    run_id = start_run("reverse_match_crm", {
        "crm_csv": CRM_CSV,
        "job_brief": JOB_BRIEF_JAVA,
        "min_score": 0.5,
        "top_n": 10,
    })
    run = wait_for_run(run_id)
    assert run["status"] in ("completed", "pending_approval"), \
        f"Unexpected status: {run['status']}. Error: {run.get('error', '')}"

    output = run.get("output", {})
    top_candidates_raw = output.get("top_candidates")
    assert top_candidates_raw, "top_candidates output is empty"

    rows = parse_csv(top_candidates_raw)
    assert len(rows) >= 1, "No candidates returned"

    top_name = rows[0].get("name", "").lower()
    assert "anna" in top_name or "mehmet" in top_name, \
        f"Expected Anna or Mehmet as top candidate, got: {rows[0].get('name')}"

    # Anna or Mehmet score should be >= 0.7
    top_score_str = rows[0].get("fit_score", "0")
    try:
        top_score = float(top_score_str)
    except ValueError:
        top_score = 0.0
    assert top_score >= 0.7, f"Top candidate score {top_score} < 0.7 for Java FinTech brief"
    print(f"  Top candidate: {rows[0].get('name')} (score={top_score})")


@test("reverse_match_crm: output has required 9 columns")
def test_reverse_match_crm_columns():
    run_id = start_run("reverse_match_crm", {
        "crm_csv": CRM_CSV,
        "job_brief": JOB_BRIEF_JAVA,
        "min_score": 0.5,
        "top_n": 5,
    })
    run = wait_for_run(run_id)
    output = run.get("output", {})
    top_candidates_raw = output.get("top_candidates", "")
    assert top_candidates_raw, "top_candidates output is empty"

    rows = parse_csv(top_candidates_raw)
    assert rows, "No rows parsed from top_candidates CSV"

    required_cols = {"name", "fit_score", "reasoning", "dach_fit", "contact_email"}
    actual_cols = set(rows[0].keys())
    missing = required_cols - actual_cols
    assert not missing, f"Missing required columns: {missing}. Got: {sorted(actual_cols)}"
    print(f"  Columns present: {sorted(actual_cols)}")


@test("reverse_match_crm: Hans (frontend dev) has lower score than Java candidates")
def test_reverse_match_crm_frontend_lower():
    run_id = start_run("reverse_match_crm", {
        "crm_csv": CRM_CSV,
        "job_brief": JOB_BRIEF_JAVA,
        "min_score": 0.1,
        "top_n": 10,
    })
    run = wait_for_run(run_id)
    output = run.get("output", {})
    top_candidates_raw = output.get("top_candidates", "")
    if not top_candidates_raw:
        return  # Skip if no output

    rows = parse_csv(top_candidates_raw)
    java_scores = []
    hans_score = None
    for row in rows:
        name = row.get("name", "").lower()
        try:
            score = float(row.get("fit_score", 0))
        except ValueError:
            score = 0.0
        if "hans" in name:
            hans_score = score
        elif "anna" in name or "mehmet" in name:
            java_scores.append(score)

    if hans_score is not None and java_scores:
        avg_java = sum(java_scores) / len(java_scores)
        assert hans_score < avg_java, \
            f"Hans (frontend) score {hans_score} should be lower than Java avg {avg_java}"
        print(f"  Hans score: {hans_score}, Java avg: {avg_java:.2f}")


# ── dach_compliance ──────────────────────────────────────────────────────────

@test("dach_compliance: AÜG output does NOT mention Scheinselbständigkeit")
def test_dach_compliance_no_scheinselbst():
    run_id = start_run("dach_compliance", {
        "engagement_type": "AÜG",
        "role_summary": "Senior Java Backend Engineer for FinTech GmbH Berlin, 12-month AÜG contract",
        "proposed_daily_rate_eur": 800,
        "location": "Berlin",
        "experience_years": 8,
    })
    run = wait_for_run(run_id)
    assert run["status"] in ("completed", "pending_approval"), \
        f"Unexpected status: {run['status']}"

    output = run.get("output", {})
    report_text = str(output.get("compliance_report", "")).lower()
    # AÜG mode should not surface Scheinselbständigkeit as primary concern
    assert "scheinselbständigkeit" not in report_text or "scheinselbstaendigkeit" not in report_text.replace("ä", "ae"), \
        "AÜG report incorrectly mentions Scheinselbständigkeit — should focus on AÜG §§"
    print(f"  Report excerpt: {str(output.get('compliance_report', ''))[:120].replace(chr(10), ' ')}")


@test("dach_compliance: AÜG report mentions 18-month maximum or equal-pay trigger")
def test_dach_compliance_aüg_clauses():
    run_id = start_run("dach_compliance", {
        "engagement_type": "AÜG",
        "role_summary": "Senior Java Backend Engineer for FinTech GmbH Berlin, 12-month AÜG contract",
        "proposed_daily_rate_eur": 800,
        "location": "Berlin",
        "experience_years": 8,
    })
    run = wait_for_run(run_id)
    output = run.get("output", {})
    report_text = str(output.get("compliance_report", "")).lower()
    has_18month = "18" in report_text and "monat" in report_text
    has_equal_pay = "equal" in report_text or "gleichstellung" in report_text or "9 monat" in report_text
    assert has_18month or has_equal_pay, \
        "AÜG report should mention 18-month maximum or equal-pay trigger (9 months)"
    print(f"  has_18month={has_18month}, has_equal_pay={has_equal_pay}")


# ── csv_enricher ─────────────────────────────────────────────────────────────

CSV_FOR_ENRICHMENT = "name,company,headline\nAnna Keller,Solaris,Senior Java\nMehmet Yilmaz,N26,Java Backend\nJulia Schneider,Deutsche Bank,SAP FI/CO"


@test("csv_enricher: output has fit_score column when instruction requests it")
def test_csv_enricher_fit_score_column():
    run_id = start_run("csv_enricher", {
        "csv_text": CSV_FOR_ENRICHMENT,
        "instruction": "Add fit_score (0–1) for a Senior Java FinTech role in Berlin",
    })
    run = wait_for_run(run_id)
    assert run["status"] == "completed", f"Unexpected status: {run['status']}"

    output = run.get("output", {})
    enriched_raw = output.get("enriched_csv") or output.get("enriched")
    assert enriched_raw, "No enriched_csv output"

    rows = parse_csv(enriched_raw)
    assert rows, "No rows in enriched CSV"

    col_keys = set(rows[0].keys())
    assert "fit_score" in col_keys, \
        f"fit_score column missing. Got columns: {sorted(col_keys)}"
    print(f"  Columns: {sorted(col_keys)}")

    # Verify fit_score values are numeric
    for row in rows:
        raw_score = row.get("fit_score", "")
        if raw_score:
            try:
                s = float(raw_score)
                assert 0.0 <= s <= 1.0, f"fit_score {s} out of range [0, 1]"
            except ValueError:
                pass  # Allow non-numeric (might be text scale like "High")


@test("csv_enricher: original name column preserved in output")
def test_csv_enricher_preserves_name():
    run_id = start_run("csv_enricher", {
        "csv_text": CSV_FOR_ENRICHMENT,
        "instruction": "Add a dach_fit column (yes/no)",
    })
    run = wait_for_run(run_id)
    output = run.get("output", {})
    enriched_raw = output.get("enriched_csv") or output.get("enriched")
    assert enriched_raw, "No enriched_csv output"
    rows = parse_csv(enriched_raw)
    assert rows, "No rows"
    names = [r.get("name", "") for r in rows]
    assert "Anna Keller" in names, f"Anna Keller missing from enriched output. Names: {names}"
    print(f"  Names preserved: {names}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global BASE
    parser = argparse.ArgumentParser(description="NovaSearch regression fixtures")
    parser.add_argument("--base", default=BASE, help="API base URL")
    args = parser.parse_args()

    BASE = args.base

    print("=" * 60)
    print("NOVASEARCH REGRESSION SUITE")
    print(f"API: {BASE}")
    print("=" * 60)

    tests_to_run = [
        test_reverse_match_crm_top1,
        test_reverse_match_crm_columns,
        test_reverse_match_crm_frontend_lower,
        test_dach_compliance_no_scheinselbst,
        test_dach_compliance_aüg_clauses,
        test_csv_enricher_fit_score_column,
        test_csv_enricher_preserves_name,
    ]

    for t in tests_to_run:
        t()

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] in ("FAIL", "ERROR"))

    print("\n" + "=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed out of {len(results)}")
    for r in results:
        mark = "OK" if r["status"] == "PASS" else "!!"
        print(f"  [{mark}] {r['name']}", end="")
        if r.get("reason"):
            print(f" — {r['reason']}", end="")
        print()
    print("=" * 60)

    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()
