from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


AUTH_SECRET = "test-auth-boundary-secret"


def _load_main(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("FLOOM_SECRET", AUTH_SECRET)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    for name in list(sys.modules):
        if name == "main" or name == "db" or name.startswith("db.") or name.startswith("auth."):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_worker_call_token_blocked_from_general_api(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)
    from run_token import issue_worker_call_token

    token = issue_worker_call_token(
        user_id="local-user",
        parent_run_id="run-parent",
        callable_workers=["child-worker"],
    )

    with TestClient(main.app, raise_server_exceptions=False) as client:
        response = client.get("/workers", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 403
    assert "child run creation" in response.json()["detail"]


def test_draft_from_prompt_unauthenticated_request_never_calls_llm(monkeypatch, tmp_path):
    main = _load_main(monkeypatch, tmp_path)

    with patch.object(main, "_call_draft_llm", side_effect=AssertionError("LLM must not be called")):
        with TestClient(main.app, raise_server_exceptions=False) as client:
            response = client.post(
                "/workers/draft-from-prompt",
                json={"prompt": "draft a worker"},
            )

    assert response.status_code == 401
