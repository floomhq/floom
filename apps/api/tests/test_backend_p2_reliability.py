from __future__ import annotations

import collections
import importlib
import sys


def _fresh_main(monkeypatch):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    for name in ["main", "scheduler"]:
        sys.modules.pop(name, None)
    return importlib.import_module("main")


def test_health_reports_scheduler_degraded_when_local_scheduler_dead(monkeypatch):
    main = _fresh_main(monkeypatch)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    main._HEALTH_CACHE.clear()

    monkeypatch.setattr(main, "_health_check_db", lambda: {"ok": True})
    monkeypatch.setattr(main, "_health_check_disk", lambda: {"ok": True})
    monkeypatch.setattr(main, "_health_check_e2b", lambda: {"ok": True})
    monkeypatch.setattr(main, "_health_check_openai", lambda: {"ok": True})
    monkeypatch.setattr(main, "_health_check_composio", lambda: {"ok": True})

    payload = main._run_health_checks()

    assert payload["status"] == "degraded"
    assert payload["checks"]["scheduler"]["ok"] is False


def test_health_does_not_require_scheduler_in_cloud_mode(monkeypatch):
    main = _fresh_main(monkeypatch)
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    main._HEALTH_CACHE.clear()

    assert main._health_check_scheduler() == {
        "ok": True,
        "enabled": False,
        "deploy": "cloud",
    }


def test_claim_draft_slot_removes_expired_empty_bucket(monkeypatch):
    main = _fresh_main(monkeypatch)
    main._draft_rate_store.clear()
    main._draft_rate_store["anon"] = collections.deque([100.0])
    monkeypatch.setattr(main.time, "monotonic", lambda: 100.0 + main._DRAFT_RATE_WINDOW_SECONDS + 1.0)

    class Request:
        headers = {}

    assert main._claim_draft_slot(Request()) is None
    assert len(main._draft_rate_store["anon"]) == 1
    assert main._draft_rate_store["anon"][0] > 100.0
