"""B10 / round-09 re-derive gate: run-token proxy + body-size middleware must
resolve when the engine app is mounted under ``/api`` (a downstream host's
``parent.mount("/api", engine.app)`` topology).

Codex flagged that R9's ``_normalized_request_path()`` was applied ONLY to the
body-size helpers, while the auth middleware's run-token match and
``_RE_RUN_LLM_PROXY`` still matched raw ``request.url.path``. When mounted at
``/api`` a sandbox using ``WORKEROS_API_URL=.../api`` would present
``/api/runs/{id}/llm`` and be rejected (403) before reaching the managed proxy.

These tests mount the app under ``/api`` like a downstream host and
assert the run-token LLM proxy still resolves (200), proving the normalization
was extended to the auth-middleware run-token matchers.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _load_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("OPENAI_API_KEY", "test-openai-key")
    monkeypatch.setenv("WORKEROS_CHAT_MODEL", "gpt-test-managed")
    monkeypatch.setenv("WORKEROS_MANAGED_LLM_MODEL", "gpt-test-managed")
    monkeypatch.setenv("WORKEROS_MANAGED_EMBEDDING_MODEL", "text-embedding-test")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    (tmp_path / "workers").mkdir()

    for name in [
        "db",
        "db._legacy_sqlite",
        "db.sqlite",
        "db.factory",
        "db.dependency",
        "db.interface",
        "models",
        "worker_registry",
        "runner_utils",
        "run_service",
        "main",
        "llm",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _seed_running_run(db, run_id: str = "run-managed", worker_id: str = "managed-worker"):
    repos = db.get_repositories()
    if repos.workers.get_any(worker_id=worker_id) is None:
        repos.workers.create(
            user_id="owner-a",
            worker_id=worker_id,
            name="Managed Worker",
            manifest_json={
                "id": worker_id,
                "name": "Managed Worker",
                "trigger": {"type": "manual"},
                "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
                "inputs": [],
                "outputs": [],
                "secrets": [],
            },
            bundle_path=f"workers/{worker_id}",
        )
    repos.runs.create(
        user_id="owner-a",
        run_id=run_id,
        worker_id=worker_id,
        status="running",
        trigger_source="manual",
        runner="e2b",
    )


def _run_headers(run_id: str) -> dict[str, str]:
    from run_token import make_run_token

    return {"X-Workeros-Run-Token": make_run_token(run_id, secret="test-secret")}


def _mounted_client(main) -> TestClient:
    parent = FastAPI()
    parent.mount("/api", main.app)
    return TestClient(parent)


def test_run_token_llm_proxy_resolves_when_mounted_under_api(monkeypatch, tmp_path):
    """The exact edge Codex flagged: /api/runs/{id}/llm must reach the proxy."""
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return {"choices": [{"message": {"content": "ok"}}], "model": kwargs["model"]}

    monkeypatch.setattr("llm.completion", fake_completion)

    client = _mounted_client(main)
    resp = client.post(
        "/api/runs/run-managed/llm",
        headers=_run_headers("run-managed"),
        json={"messages": [{"role": "user", "content": "score"}], "max_tokens": 12},
    )

    assert resp.status_code == 200, resp.text
    assert captured["model"] == "gpt-test-managed"


def test_run_token_embeddings_proxy_resolves_when_mounted_under_api(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    captured = {}

    def fake_embedding(**kwargs):
        captured.update(kwargs)
        return {"data": [{"embedding": [0.1, 0.2]}], "model": kwargs["model"]}

    monkeypatch.setattr("llm.embedding", fake_embedding)

    client = _mounted_client(main)
    resp = client.post(
        "/api/runs/run-managed/embeddings",
        headers=_run_headers("run-managed"),
        json={"input": ["alpha", "beta"]},
    )

    assert resp.status_code == 200, resp.text
    assert captured["model"] == "text-embedding-test"


def test_run_token_rejected_on_non_proxy_path_when_mounted(monkeypatch, tmp_path):
    """Normalization must not over-permit: a run token on a non-proxy /api path
    (e.g. /api/workers) still gets 403, proving the matcher narrows on the
    route-local path, not the mount prefix."""
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)

    client = _mounted_client(main)
    resp = client.get(
        "/api/workers",
        headers=_run_headers("run-managed"),
    )
    assert resp.status_code == 403, resp.text


def test_run_token_llm_proxy_still_resolves_unmounted(monkeypatch, tmp_path):
    """Regression guard: the un-prefixed (standalone) path must still work —
    normalization is a no-op when root_path is empty."""
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    captured = {}

    monkeypatch.setattr(
        "llm.completion",
        lambda **kwargs: captured.update(kwargs)
        or {"choices": [{"message": {"content": "ok"}}], "model": kwargs["model"]},
    )

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-managed/llm",
        headers=_run_headers("run-managed"),
        json={"messages": [{"role": "user", "content": "score"}]},
    )
    assert resp.status_code == 200, resp.text
    assert captured["model"] == "gpt-test-managed"
