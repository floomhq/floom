"""#1373/#1387/#1412 - per-worker memory is on by default."""

from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _base_worker_config(**overrides):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    data = {
        "id": "memory-default-worker",
        "name": "Memory Default Worker",
        "trigger": WorkerTrigger(type="manual"),
        "runtime": WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        "outputs": [],
    }
    data.update(overrides)
    return WorkerConfig(**data)


def test_worker_memory_defaults_to_enabled_and_mounts_writeable_context():
    config = _base_worker_config()

    assert config.memory.enabled is True
    contexts = [c.model_dump() if hasattr(c, "model_dump") else c for c in config.contexts]
    assert {
        "name": "memory-memory-default-worker",
        "writeable": True,
        "source": "local",
    } in contexts


def test_worker_memory_can_declare_when_it_is_writeable():
    config = _base_worker_config(
        memory={"writeable_when": {"input": "operation", "equals": "record_candidate_feedback"}}
    )

    contexts = [c.model_dump() if hasattr(c, "model_dump") else c for c in config.contexts]
    assert {
        "name": "memory-memory-default-worker",
        "writeable": True,
        "source": "local",
        "writeable_when": {"input": "operation", "equals": "record_candidate_feedback"},
    } in contexts


def test_worker_memory_can_still_be_explicitly_disabled():
    config = _base_worker_config(memory=False)

    assert config.memory.enabled is False
    assert config.contexts == []


def test_ensure_memory_pack_creates_visible_writeable_metadata(monkeypatch, tmp_path):
    import contexts
    from runner_sandbox import memory_context

    contexts_root = tmp_path / "contexts"
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setattr(contexts, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(memory_context._contexts_module, "CONTEXTS_DIR", contexts_root)

    config = _base_worker_config()
    logs: list[tuple[str, str]] = []

    with contexts.use_context_scope(contexts.context_scope_for_user("alice")):
        name = memory_context.ensure_memory_context_pack(
            config=config,
            user_id="alice",
            log_fn=lambda msg, level="info": logs.append((msg, level)),
        )

    assert name == "memory-memory-default-worker"
    memory_dir = contexts_root / "alice" / name
    assert (memory_dir / "MEMORY.md").read_text(encoding="utf-8").startswith("# Worker memory")
    with contexts.use_context_scope(contexts.context_scope_for_user("alice")):
        metadata = contexts.load_context_metadata()
    assert metadata[name]["writeable"] is True
    assert metadata[name]["sensitive"] is True
    assert metadata[name]["category"] == "memory"


def test_worker_create_helper_materializes_memory_pack(monkeypatch, tmp_path):
    import contexts
    from runner_sandbox import memory_context
    from services.worker_create import _ensure_worker_memory_pack

    contexts_root = tmp_path / "contexts"
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setattr(contexts, "CONTEXTS_DIR", contexts_root)
    monkeypatch.setattr(memory_context._contexts_module, "CONTEXTS_DIR", contexts_root)

    config = _base_worker_config(id="created-worker")

    _ensure_worker_memory_pack(config, "alice")

    memory_dir = contexts_root / "alice" / "memory-created-worker"
    assert (memory_dir / "MEMORY.md").is_file()
    with contexts.use_context_scope(contexts.context_scope_for_user("alice")):
        metadata = contexts.load_context_metadata()
    assert metadata["memory-created-worker"]["writeable"] is True
