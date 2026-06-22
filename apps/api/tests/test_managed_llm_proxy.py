from __future__ import annotations

import importlib
import sys
from pathlib import Path

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

    return {"X-Floom-Run-Token": make_run_token(run_id, secret="test-secret")}


def test_run_token_can_call_workspace_managed_llm(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    captured = {}

    def fake_completion(**kwargs):
        captured.update(kwargs)
        return {"choices": [{"message": {"content": "ok"}}], "model": kwargs["model"]}

    monkeypatch.setattr("llm.completion", fake_completion)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-managed/llm",
        headers=_run_headers("run-managed"),
        json={"messages": [{"role": "user", "content": "score"}], "max_tokens": 12},
    )

    assert resp.status_code == 200, resp.text
    assert captured["model"] == "gpt-test-managed"
    assert captured["messages"] == [{"role": "user", "content": "score"}]
    assert captured["max_tokens"] == 12
    assert resp.json()["choices"][0]["message"]["content"] == "ok"


def test_run_token_can_call_workspace_managed_embeddings(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    captured = {}

    def fake_embedding(**kwargs):
        captured.update(kwargs)
        return {"data": [{"embedding": [0.1, 0.2]}], "model": kwargs["model"]}

    monkeypatch.setattr("llm.embedding", fake_embedding)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-managed/embeddings",
        headers=_run_headers("run-managed"),
        json={"input": ["alpha", "beta"]},
    )

    assert resp.status_code == 200, resp.text
    assert captured["model"] == "text-embedding-test"
    assert captured["input"] == ["alpha", "beta"]
    assert resp.json()["data"][0]["embedding"] == [0.1, 0.2]


def test_managed_llm_rejects_provider_endpoint_overrides(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)

    def fail_completion(**_kwargs):
        raise AssertionError("provider SDK must not be called with forbidden kwargs")

    monkeypatch.setattr("llm.completion", fail_completion)

    client = TestClient(main.app)
    for field in ("api_base", "base_url", "proxy"):
        resp = client.post(
            "/runs/run-managed/llm",
            headers=_run_headers("run-managed"),
            json={
                "messages": [{"role": "user", "content": "score"}],
                field: "https://evil.example",
            },
        )
        assert resp.status_code == 422, resp.text
        assert "extra_forbidden" in resp.text


def test_managed_embeddings_rejects_provider_endpoint_overrides(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)

    def fail_embedding(**_kwargs):
        raise AssertionError("provider SDK must not be called with forbidden kwargs")

    monkeypatch.setattr("llm.embedding", fail_embedding)

    client = TestClient(main.app)
    for field in ("api_base", "base_url", "proxy"):
        resp = client.post(
            "/runs/run-managed/embeddings",
            headers=_run_headers("run-managed"),
            json={"input": ["alpha"], field: "https://evil.example"},
        )
        assert resp.status_code == 422, resp.text
        assert "extra_forbidden" in resp.text


def test_worker_call_token_can_only_use_parent_run_managed_llm(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db, run_id="run-parent")
    _seed_running_run(db, run_id="run-other")
    from run_token import issue_worker_call_token

    token = issue_worker_call_token(
        user_id="owner-a",
        parent_run_id="run-parent",
        callable_workers=["child-worker"],
        depth=0,
        secret="test-secret",
    )

    monkeypatch.setattr(
        "llm.completion",
        lambda **kwargs: {"choices": [{"message": {"content": "parent-ok"}}]},
    )

    client = TestClient(main.app)
    allowed = client.post(
        "/runs/run-parent/llm",
        headers={"Authorization": f"Bearer {token}"},
        json={"messages": [{"role": "user", "content": "score"}]},
    )
    blocked = client.post(
        "/runs/run-other/llm",
        headers={"Authorization": f"Bearer {token}"},
        json={"messages": [{"role": "user", "content": "score"}]},
    )

    assert allowed.status_code == 200, allowed.text
    assert blocked.status_code == 403, blocked.text


def test_managed_llm_batch_runs_each_request(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    seen = []

    def fake_completion(**kwargs):
        seen.append(kwargs["messages"][0]["content"])
        return {"choices": [{"message": {"content": kwargs["messages"][0]["content"]}}]}

    monkeypatch.setattr("llm.completion", fake_completion)

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-managed/llm/batch",
        headers=_run_headers("run-managed"),
        json={
            "requests": [
                {"messages": [{"role": "user", "content": "a"}]},
                {"messages": [{"role": "user", "content": "b"}]},
            ],
            "max_parallel": 2,
        },
    )

    assert resp.status_code == 200, resp.text
    assert sorted(seen) == ["a", "b"]
    assert [r["choices"][0]["message"]["content"] for r in resp.json()["results"]] == ["a", "b"]


def test_managed_llm_rejects_terminal_run(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path)
    _seed_running_run(db)
    repos = db.get_repositories()
    repos.runs.update_status(user_id="owner-a", run_id="run-managed", status="completed")

    client = TestClient(main.app)
    resp = client.post(
        "/runs/run-managed/llm",
        headers=_run_headers("run-managed"),
        json={"messages": [{"role": "user", "content": "score"}]},
    )

    assert resp.status_code == 403
    assert "not currently running" in resp.text
