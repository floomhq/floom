"""#1387 — per-worker memory is ON by default.

Decision / Memory-A:
  - WorkerMemoryConfig.enabled defaults to True.
  - A worker whose YAML has no `memory:` block gets memory enabled.
  - A worker with `memory: false` keeps memory disabled (explicit opt-out).
  - At CREATE time the memory context folder + MEMORY.md are materialised
    immediately (not lazily on first run).
  - Existing workers whose stored config has memory disabled are not mutated.

Run: cd apps/api && python -m pytest tests/test_1387_memory_on_by_default.py -q
"""
from __future__ import annotations

import importlib
import sys
import types
import textwrap
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "test-secret-1387"


# ---------------------------------------------------------------------------
# Unit tests — WorkerMemoryConfig + WorkerConfig model defaults
# ---------------------------------------------------------------------------

class TestWorkerMemoryConfigDefault:
    def test_absent_memory_block_gives_enabled_true(self):
        """No `memory:` key in YAML → enabled=True."""
        for name in list(sys.modules):
            if name == "models":
                sys.modules.pop(name)
                break
        from models import WorkerMemoryConfig

        cfg = WorkerMemoryConfig()
        assert cfg.enabled is True

    def test_explicit_false_keeps_disabled(self):
        from models import WorkerMemoryConfig

        cfg = WorkerMemoryConfig(enabled=False)
        assert cfg.enabled is False

    def test_none_coerces_to_enabled_true(self):
        from models import WorkerMemoryConfig

        cfg = WorkerMemoryConfig.model_validate(None)
        assert cfg.enabled is True

    def test_string_false_coerces_to_disabled(self):
        from models import WorkerMemoryConfig

        for falsy in ("false", "disabled", "off", "no", "0"):
            cfg = WorkerMemoryConfig.model_validate(falsy)
            assert cfg.enabled is False, f"expected disabled for {falsy!r}"

    def test_string_true_coerces_to_enabled(self):
        from models import WorkerMemoryConfig

        for truthy in ("true", "enabled", "on", "yes", "1"):
            cfg = WorkerMemoryConfig.model_validate(truthy)
            assert cfg.enabled is True, f"expected enabled for {truthy!r}"


class TestWorkerConfigMemoryDefault:
    """WorkerConfig with no `memory:` YAML key yields memory.enabled=True and
    injects the memory context mount into .contexts."""

    def test_worker_config_without_memory_key_gets_memory_enabled(self):
        for name in list(sys.modules):
            if name in ("models",):
                sys.modules.pop(name)
        from models import WorkerConfig, WorkerTrigger, WorkerRuntime

        config = WorkerConfig(
            id="test-worker-no-mem",
            name="Test Worker",
            trigger=WorkerTrigger(type="manual"),
            runtime=WorkerRuntime(type="agent", entrypoint="SKILL.md", mode="agent"),
            outputs=[],
        )
        assert config.memory.enabled is True
        # The memory context mount must be injected into .contexts
        mem_names = [c if isinstance(c, str) else (c.get("name") if isinstance(c, dict) else getattr(c, "name", None)) for c in config.contexts]
        assert any("memory-test-worker-no-mem" == n for n in mem_names), (
            f"expected memory context mount in contexts, got: {config.contexts}"
        )

    def test_worker_config_with_memory_false_keeps_disabled(self):
        for name in list(sys.modules):
            if name in ("models",):
                sys.modules.pop(name)
        from models import WorkerConfig, WorkerTrigger, WorkerRuntime, WorkerMemoryConfig

        config = WorkerConfig(
            id="test-worker-mem-off",
            name="No Memory Worker",
            trigger=WorkerTrigger(type="manual"),
            runtime=WorkerRuntime(type="agent", entrypoint="SKILL.md", mode="agent"),
            memory=WorkerMemoryConfig(enabled=False),
            outputs=[],
        )
        assert config.memory.enabled is False
        # No memory context mount should be injected
        mem_names = [c if isinstance(c, str) else (c.get("name") if isinstance(c, dict) else getattr(c, "name", None)) for c in config.contexts]
        assert not any("memory-" in (n or "") for n in mem_names), (
            f"memory context mount must not be injected when disabled: {config.contexts}"
        )


# ---------------------------------------------------------------------------
# Integration test — POST /workers creates the memory context at create time
# ---------------------------------------------------------------------------

def _yml(worker_id: str) -> str:
    return textwrap.dedent(f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: "T"
        description: "D"
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
        trigger:
          type: manual
        connections: []
    """).strip() + "\n"


def _yml_memory_off(worker_id: str) -> str:
    return textwrap.dedent(f"""
        schema_version: "0.3"
        id: "{worker_id}"
        name: "{worker_id}"
        title: "T"
        description: "D"
        version: "0.1.0"
        exec:
          entry: run.py
          runtime: python311
          runner: e2b
          command: python run.py
        trigger:
          type: manual
        memory: false
        connections: []
    """).strip() + "\n"


@pytest.fixture()
def api_client(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(tmp_path / "blobs"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.setenv("FLOOM_SECRET", SECRET)
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    for name in list(sys.modules):
        if name in (
            "main", "models", "worker_registry", "run_service", "chat_service", "contexts",
        ) or name.startswith(("routers", "services", "core", "db", "auth", "runner_sandbox")):
            sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None
    )

    main = importlib.import_module("main")
    main.start_run = lambda *a, **k: None
    import run_service
    run_service.start_run = main.start_run

    from fastapi.testclient import TestClient
    client = TestClient(main.app, headers={"x-floom-secret": SECRET}, raise_server_exceptions=False)
    yield client, contexts_dir

    # cleanup
    for name in list(sys.modules):
        if name in ("main", "models", "worker_registry", "run_service", "contexts") or name.startswith(
            ("routers", "services", "core", "db", "auth", "runner_sandbox")
        ):
            sys.modules.pop(name, None)


class TestMemoryContextCreatedAtWorkerCreate:
    def test_new_worker_without_memory_key_has_memory_enabled(self, api_client):
        """POST /workers (no memory: key) → config.memory.enabled is True in response."""
        client, _ctxdir = api_client
        resp = client.post("/workers", json={"worker_yml": _yml("wk-mem-default"), "run_py": "print(1)"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        memory = body.get("config", {}).get("memory", {})
        assert memory.get("enabled") is True, f"expected memory.enabled=True in response, got: {memory}"

    def test_new_worker_memory_context_folder_created_at_create_time(self, api_client):
        """POST /workers → the memory-<id>/ context folder + MEMORY.md exist immediately."""
        client, contexts_dir = api_client
        resp = client.post("/workers", json={"worker_yml": _yml("wk-mem-eager"), "run_py": "print(1)"})
        assert resp.status_code == 200, resp.text

        # The memory context name is memory-<worker-id>
        memory_ctx = contexts_dir / "memory-wk-mem-eager"
        assert memory_ctx.is_dir(), (
            f"Expected memory context directory {memory_ctx} to exist after worker create"
        )
        memory_md = memory_ctx / "MEMORY.md"
        assert memory_md.is_file(), (
            f"Expected MEMORY.md to exist at {memory_md} after worker create"
        )
        assert "memory" in memory_md.read_text(encoding="utf-8").lower()

    def test_new_worker_with_memory_false_no_context_created(self, api_client):
        """POST /workers with memory: false → no memory context folder created."""
        client, contexts_dir = api_client
        resp = client.post("/workers", json={"worker_yml": _yml_memory_off("wk-no-mem"), "run_py": "print(1)"})
        assert resp.status_code == 200, resp.text

        memory_ctx = contexts_dir / "memory-wk-no-mem"
        assert not memory_ctx.exists(), (
            f"Expected NO memory context directory for disabled-memory worker, found {memory_ctx}"
        )

    def test_new_worker_memory_context_appears_in_brain_list(self, api_client):
        """POST /workers → GET /contexts lists the newly-created memory folder."""
        client, _ctxdir = api_client
        resp = client.post("/workers", json={"worker_yml": _yml("wk-brain-vis"), "run_py": "print(1)"})
        assert resp.status_code == 200, resp.text

        ctx_list = client.get("/contexts")
        assert ctx_list.status_code == 200, ctx_list.text
        names = [c["name"] for c in ctx_list.json()]
        assert "memory-wk-brain-vis" in names, (
            f"memory context must appear in /contexts list; got: {names}"
        )
