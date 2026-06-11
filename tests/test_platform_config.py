"""Tests for GET /system/platform-config redacted summary response."""

import importlib
import os
import sys
import types

from fastapi.testclient import TestClient


API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)


def _load_api(tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"

    os.environ["FLOOM_DB"] = str(db_path)
    os.environ["FLOOM_WORKERS_DIR"] = str(workers_dir)
    os.environ["FLOOM_SECRET"] = "test-secret-platform"

    for name in [
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    ]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_platform_config_returns_redacted_summary_shape(tmp_path):
    main = _load_api(tmp_path)
    client = TestClient(main.app)

    resp = client.get("/system/platform-config", headers={"x-floom-secret": "test-secret-platform"})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert set(body.keys()) == {"all_required_set", "missing", "set_count", "required_count"}
    assert isinstance(body["all_required_set"], bool)
    assert isinstance(body["missing"], list)
    assert isinstance(body["set_count"], int)
    assert isinstance(body["required_count"], int)


def test_platform_config_only_includes_missing_names(tmp_path):
    main = _load_api(tmp_path)
    client = TestClient(main.app)

    os.environ["OPENAI_API_KEY"] = "sk-test"
    os.environ["E2B_API_KEY"] = "e2b-test"
    os.environ["COMPOSIO_API_KEY"] = "cmp-test"
    os.environ["COMPOSIO_WEBHOOK_SIGNING_KEY"] = "whsec-test"
    os.environ["WORKERS_FRONTEND_URL"] = "https://workers.floom.dev"
    os.environ["FLOOM_SECRET"] = "test-secret-platform"

    resp = client.get("/system/platform-config", headers={"x-floom-secret": "test-secret-platform"})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["all_required_set"] is True
    assert body["missing"] == []
    assert body["set_count"] == body["required_count"]


def test_platform_config_marks_missing_required_names(tmp_path):
    main = _load_api(tmp_path)
    client = TestClient(main.app)

    # #814: PLATFORM_OPENAI_API_KEY is the canonical required platform key now
    # (OPENAI_API_KEY is only a back-compat fallback in PLATFORM_SECRET_SPECS),
    # so pop both to make the canonical key resolve as missing.
    os.environ.pop("OPENAI_API_KEY", None)
    os.environ.pop("PLATFORM_OPENAI_API_KEY", None)
    os.environ["E2B_API_KEY"] = "e2b-test"
    os.environ["COMPOSIO_API_KEY"] = "cmp-test"
    os.environ["COMPOSIO_WEBHOOK_SIGNING_KEY"] = "whsec-test"
    os.environ["WORKERS_FRONTEND_URL"] = "https://workers.floom.dev"
    os.environ["FLOOM_SECRET"] = "test-secret-platform"

    resp = client.get("/system/platform-config", headers={"x-floom-secret": "test-secret-platform"})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["all_required_set"] is False
    assert "PLATFORM_OPENAI_API_KEY" in body["missing"]
    assert body["set_count"] < body["required_count"]
