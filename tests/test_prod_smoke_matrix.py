from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = REPO_ROOT / "scripts" / "prod_smoke_matrix.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("prod_smoke_matrix", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_manifest_parser_finds_active_stock_workers():
    mod = _load_module()
    specs = mod.load_active_workers()

    worker_ids = [spec.worker_id for spec in specs]
    assert len(worker_ids) == 12
    assert worker_ids == [
        "weekly_update",
        "research_brief",
        "dach_compliance",
        "github-digest",
        "gmail_intake_brief",
        "csv_enricher",
        "cv_writeup",
        "reverse_match_crm",
        "linkedin-post-engagements",
        "node-smoke-test",
        "openblog",
        "opendraft",
    ]

    csv_spec = next(spec for spec in specs if spec.worker_id == "csv_enricher")
    assert csv_spec.file_input_name == "csv_file"
    assert csv_spec.sample_file and csv_spec.sample_file.name == "sample_candidates.csv"

    opendraft_spec = next(spec for spec in specs if spec.worker_id == "opendraft")
    assert opendraft_spec.cancel_after_start is True


def test_render_report_includes_system_health_and_matrix():
    mod = _load_module()
    report = mod._render_report(
        report_date="2026-06-08",
        api_base="https://workers-api.floom.dev",
        metrics={
            "workers_count": 12,
            "runs_total": 1866,
            "runs_7d": 1868,
            "runs_failed_7d": 1684,
            "connections_count": 4,
            "secrets_count": 6,
            "active_triggers": 5,
            "drafts_last_hour": 0,
        },
        alerts=[
            {"worker_id": "github-digest", "incident_key": "missing_connection", "reason": "Missing connection", "open": True},
            {"worker_id": "weekly_update", "incident_key": "noise", "reason": "resolved", "open": False},
        ],
        failures=[("slack-listener", 853, 853), ("whatsapp-listener", 705, 705)],
        smoke_results=[
            mod.WorkerSmokeResult("weekly_update", "run_1", "completed", 1200, 12, ""),
            mod.WorkerSmokeResult("opendraft", "run_2", "cancel_requested", None, None, "smoke start + cancel"),
        ],
    )

    assert "# Smoke Results — 2026-06-08" in report
    assert "failure_rate_7d" in report
    assert "open_alert_incidents" in report
    assert "slack-listener" in report
    assert "opendraft" in report
    assert "smoke start + cancel" in report
