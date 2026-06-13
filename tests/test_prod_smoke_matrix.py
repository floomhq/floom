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
    assert len(worker_ids) == 11
    assert worker_ids == [
        "weekly_update",
        "research_brief",
        "dach_compliance",
        "github-digest",
        "gmail_intake_brief",
        "csv_enricher",
        "cv_writeup",
        "reverse_match_crm",
        "node-smoke-test",
        "openblog",
        "opendraft",
    ]
    assert "linkedin-post-engagements" not in worker_ids

    csv_spec = next(spec for spec in specs if spec.worker_id == "csv_enricher")
    assert csv_spec.file_input_name == "csv_file"
    assert csv_spec.sample_file and csv_spec.sample_file.name == "sample_candidates.csv"
    assert csv_spec.sample_file.is_file()

    cv_spec = next(spec for spec in specs if spec.worker_id == "cv_writeup")
    assert cv_spec.file_input_name == "cv_file"
    assert cv_spec.sample_file and cv_spec.sample_file.name == "sample_cv.txt"
    assert cv_spec.sample_file.is_file()

    node_spec = next(spec for spec in specs if spec.worker_id == "node-smoke-test")
    assert node_spec.file_input_name is None
    assert node_spec.sample_file is None
    assert "No inputs required" in node_spec.smoke_input.read_text(encoding="utf-8")

    opendraft_spec = next(spec for spec in specs if spec.worker_id == "opendraft")
    assert opendraft_spec.cancel_after_start is True


def test_worker_filter_rejects_archived_or_unknown_workers(tmp_path, monkeypatch):
    mod = _load_module()
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    out = tmp_path / "report.md"

    try:
        mod.main(["--workers", "linkedin-post-engagements", "--output", str(out)])
    except SystemExit as exc:
        assert "Unknown or inactive worker(s): linkedin-post-engagements" in str(exc)
    else:
        raise AssertionError("expected archived worker filter to exit")


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


def _result(mod, worker_id, status="completed", run_id="run_x"):
    return mod.WorkerSmokeResult(worker_id, run_id, status, 1000, 10, "")


def test_parse_report_pass_states_round_trips_rendered_report():
    mod = _load_module()
    report = mod._render_report(
        report_date="2026-06-10",
        api_base="https://workers-api.floom.dev",
        metrics={},
        alerts=[],
        failures=[],
        smoke_results=[
            _result(mod, "weekly_update"),
            _result(mod, "research_brief", status="failed"),
        ],
    )
    states = mod._parse_report_pass_states(report)
    assert states == {"weekly_update": "pass", "research_brief": "fail"}


def test_find_regressions_only_flags_pass_to_fail():
    mod = _load_module()
    previous = {"weekly_update": "pass", "research_brief": "fail", "csv_enricher": "pass"}
    current = [
        _result(mod, "weekly_update", status="failed"),     # pass -> fail: regression
        _result(mod, "research_brief", status="failed"),    # fail -> fail: not a regression
        _result(mod, "csv_enricher"),                       # pass -> pass: fine
        _result(mod, "brand-new-worker", status="failed"),  # no baseline: not a regression
    ]
    assert mod._find_regressions(previous, current) == ["weekly_update"]


def test_previous_report_path_picks_latest_older(tmp_path):
    mod = _load_module()
    (tmp_path / "SMOKE-RESULTS-2026-05-29.md").write_text("old", encoding="utf-8")
    (tmp_path / "SMOKE-RESULTS-2026-06-09.md").write_text("newer", encoding="utf-8")
    (tmp_path / "SMOKE-RESULTS-2026-06-12.md").write_text("today", encoding="utf-8")
    picked = mod._previous_report_path(tmp_path, "2026-06-12")
    assert picked and picked.name == "SMOKE-RESULTS-2026-06-09.md"
    assert mod._previous_report_path(tmp_path, "2026-05-29") is None


def test_render_report_lists_regressions_section():
    mod = _load_module()
    report = mod._render_report(
        report_date="2026-06-12",
        api_base="https://workers-api.floom.dev",
        metrics={},
        alerts=[],
        failures=[],
        smoke_results=[_result(mod, "weekly_update", status="failed")],
        regressions=["weekly_update"],
        previous_report_name="SMOKE-RESULTS-2026-06-09.md",
    )
    assert "Regressions vs SMOKE-RESULTS-2026-06-09.md" in report
    assert "- `weekly_update`" in report
