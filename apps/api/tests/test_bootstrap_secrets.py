from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    artifacts_dir = tmp_path / "artifacts"
    artifacts_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "bootstrap-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-bootstrap-openai")
    monkeypatch.setenv("E2B_API_KEY", "e2b-bootstrap-key")
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(artifacts_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN_REGEX", raising=False)
    monkeypatch.delenv("WORKEROS_DEV", raising=False)

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


def test_bootstrap_seeds_openai_secret_into_db(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    with TestClient(main.app):
        repos = main.get_repositories()
        bootstrap_user_id = main._bootstrap_user_id()
        row = repos.secrets.get(user_id=bootstrap_user_id, name="OPENAI_API_KEY")

        assert row is not None
        assert row["value"] == "sk-bootstrap-openai"
        assert "OPENAI_API_KEY" in main._available_secret_names_for_user(bootstrap_user_id, repos)

        e2b_row = repos.secrets.get(user_id=bootstrap_user_id, name="E2B_API_KEY")
        assert e2b_row is not None
        assert e2b_row["value"] == "e2b-bootstrap-key"
        assert "E2B_API_KEY" in main._available_secret_names_for_user(bootstrap_user_id, repos)
