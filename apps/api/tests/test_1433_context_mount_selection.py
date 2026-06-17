"""#1433: skip large context-pack uploads for runs that do not need them."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_context_mount_when_predicates():
    from contexts import context_mount_matches_inputs

    inputs = {
        "operation": "profile",
        "candidate": {"source": "linkedin"},
        "include_context": True,
    }

    assert context_mount_matches_inputs("always", inputs) is True
    assert context_mount_matches_inputs(
        {"name": "search-data", "when": {"input": "operation", "equals": "search"}},
        inputs,
    ) is False
    assert context_mount_matches_inputs(
        {"name": "search-data", "when": {"input": "operation", "not_in": ["profile"]}},
        inputs,
    ) is False
    assert context_mount_matches_inputs(
        {"name": "profile-data", "when": {"input": "operation", "in": ["profile"]}},
        inputs,
    ) is True
    assert context_mount_matches_inputs(
        {"name": "nested", "when": {"input": "candidate.source", "equals": "linkedin"}},
        inputs,
    ) is True
    assert context_mount_matches_inputs(
        {"name": "flag", "when": {"input": "include_context", "truthy": True}},
        inputs,
    ) is True
    assert context_mount_matches_inputs(
        {"name": "missing", "when": {"input": "missing", "exists": False}},
        inputs,
    ) is True


def test_invalid_context_mount_when_is_rejected():
    from contexts import context_mount_matches_inputs

    with pytest.raises(ValueError, match="when.input"):
        context_mount_matches_inputs({"name": "bad", "when": {"equals": "x"}}, {})
    with pytest.raises(ValueError, match="when.in"):
        context_mount_matches_inputs({"name": "bad", "when": {"input": "op", "in": "search"}}, {"op": "search"})


class _FakeCommandResult:
    exit_code = 0
    stdout = ""
    stderr = ""


class _FakeCommands:
    def __init__(self) -> None:
        self.runs: list[dict[str, object]] = []

    def run(self, command: str, **kwargs):
        self.runs.append({"command": command, **kwargs})
        return _FakeCommandResult()


class _FakeFiles:
    def __init__(self) -> None:
        self.dirs: list[str] = []
        self.writes: list[str] = []

    def make_dir(self, path: str) -> None:
        self.dirs.append(path)

    def write(self, path: str, _data: bytes) -> None:
        self.writes.append(path)


class _FakeSandbox:
    def __init__(self) -> None:
        self.files = _FakeFiles()
        self.commands = _FakeCommands()


def test_e2b_uploads_only_contexts_selected_by_run_inputs(monkeypatch, tmp_path):
    contexts_root = tmp_path / "contexts"
    (contexts_root / "search-data").mkdir(parents=True)
    (contexts_root / "search-data" / "embeddings.jsonl").write_text("large\n", encoding="utf-8")
    (contexts_root / "light-data").mkdir(parents=True)
    (contexts_root / "light-data" / "small.txt").write_text("small\n", encoding="utf-8")
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_root))

    import contexts as contexts_mod
    import runner_sandbox.memory_context as memory_context_mod
    import runner_sandbox.e2b_driver as e2b_driver_mod

    importlib.reload(contexts_mod)
    importlib.reload(memory_context_mod)
    importlib.reload(e2b_driver_mod)

    config = SimpleNamespace(
        contexts=[
            {"name": "search-data", "when": {"input": "operation", "not_in": ["profile"]}},
            {"name": "light-data", "when": {"input": "operation", "equals": "profile"}},
        ],
        memory=SimpleNamespace(enabled=False),
    )
    sandbox = _FakeSandbox()
    mounted: set[str] = set()
    logs: list[tuple[str, str]] = []

    err = e2b_driver_mod.E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        inputs={"operation": "profile"},
        made_dirs=set(),
        log_fn=lambda msg, level="info": logs.append((level, msg)),
        user_id="alice",
        mounted_contexts=mounted,
    )

    assert err is None
    assert mounted == {"light-data"}
    assert "/home/user/worker/context/search-data" not in sandbox.files.dirs
    assert "/home/user/worker/context/light-data" in sandbox.files.dirs
    assert any(path.endswith("/context/light-data/.workeros-upload.tar.gz") for path in sandbox.files.writes)
    assert not any(path.endswith("/context/search-data/.workeros-upload.tar.gz") for path in sandbox.files.writes)
    assert any("Skipping context 'search-data'" in msg for _level, msg in logs)
