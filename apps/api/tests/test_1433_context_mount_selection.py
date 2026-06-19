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
        self.existing: set[str] = {"/home/user/worker"}

    def make_dir(self, path: str) -> None:
        self.dirs.append(path)
        self.existing.add(path)

    def write(self, path: str, _data: bytes) -> None:
        self.writes.append(path)

    def exists(self, path: str, **_kwargs) -> bool:
        return path in self.existing


class _FakeSandbox:
    def __init__(self) -> None:
        self.files = _FakeFiles()
        self.commands = _FakeCommands()
        self.killed = False

    def kill(self) -> None:
        self.killed = True


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


def test_context_mount_predicates_see_worker_input_defaults(monkeypatch, tmp_path):
    contexts_root = tmp_path / "contexts"
    (contexts_root / "default-data").mkdir(parents=True)
    (contexts_root / "default-data" / "small.txt").write_text("small\n", encoding="utf-8")
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_root))

    import contexts as contexts_mod
    import runner_sandbox.memory_context as memory_context_mod
    import runner_sandbox.e2b_driver as e2b_driver_mod

    importlib.reload(contexts_mod)
    importlib.reload(memory_context_mod)
    importlib.reload(e2b_driver_mod)

    config = SimpleNamespace(
        inputs=[SimpleNamespace(name="operation", default="profile")],
        contexts=[
            {"name": "default-data", "when": {"input": "operation", "equals": "profile"}},
        ],
        memory=SimpleNamespace(enabled=False),
    )
    sandbox = _FakeSandbox()
    mounted: set[str] = set()

    err = e2b_driver_mod.E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=config,
        inputs={},
        made_dirs=set(),
        log_fn=lambda *_args: None,
        user_id="alice",
        mounted_contexts=mounted,
    )

    assert err is None
    assert mounted == {"default-data"}


def test_warm_pool_reuses_alive_sandbox_and_clears_pool(monkeypatch):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    e2b_driver_mod.clear_warm_pool()
    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    sandbox = _FakeSandbox()
    logs: list[tuple[str, str]] = []
    entry = e2b_driver_mod._WarmSandboxEntry(
        key="key-1",
        sandbox=sandbox,
        workdir="/home/user/worker",
        mounted_contexts={"light-data"},
    )

    assert e2b_driver_mod._warm_pool_return(entry, log_fn=lambda msg, level="info": logs.append((level, msg))) is True
    assert e2b_driver_mod.warm_pool_size() == 1
    leased = e2b_driver_mod._warm_pool_lease("key-1", log_fn=lambda msg, level="info": logs.append((level, msg)))
    assert leased is entry
    assert leased.uses == 1
    assert e2b_driver_mod.warm_pool_size() == 0
    assert e2b_driver_mod.clear_warm_pool() == 0


def test_warm_pool_discards_dead_sandbox(monkeypatch):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    e2b_driver_mod.clear_warm_pool()
    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    sandbox = _FakeSandbox()
    sandbox.files.existing.clear()
    entry = e2b_driver_mod._WarmSandboxEntry(
        key="key-dead",
        sandbox=sandbox,
        workdir="/home/user/worker",
        mounted_contexts=set(),
    )

    assert e2b_driver_mod._warm_pool_return(entry, log_fn=lambda *_args: None) is False
    assert sandbox.killed is True
    assert e2b_driver_mod.warm_pool_size() == 0


def test_warm_pool_key_disabled_for_mutable_or_git_contexts(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    runtime = SimpleNamespace(command="python run.py", type="python")

    writable_cfg = SimpleNamespace(
        runtime=runtime,
        contexts=[{"name": "scratch", "writeable": True}],
    )
    assert e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=writable_cfg,
        inputs={},
        sandbox_template=None,
    ) == (None, None)

    git_cfg = SimpleNamespace(
        runtime=runtime,
        contexts=[{"name": "repo", "source": "git+https://github.com/example/repo.git"}],
    )
    assert e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=git_cfg,
        inputs={},
        sandbox_template=None,
    ) == (None, None)


def test_context_selection_changes_with_run_inputs(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        contexts=[
            {"name": "search-data", "when": {"input": "operation", "equals": "search"}},
            {"name": "profile-data", "when": {"input": "operation", "equals": "profile"}},
        ],
    )

    search_contexts, search_err = e2b_driver_mod._selected_contexts_for_inputs(
        cfg,
        {"operation": "search"},
    )
    profile_contexts, profile_err = e2b_driver_mod._selected_contexts_for_inputs(
        cfg,
        {"operation": "profile"},
    )
    assert search_err is None
    assert profile_err is None
    assert [context["name"] for context in search_contexts] == ["search-data"]
    assert [context["name"] for context in profile_contexts] == ["profile-data"]


def test_writeable_when_makes_memory_mount_read_only_for_default_read_operation(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        inputs=[SimpleNamespace(name="operation", default="profile")],
        contexts=[
            {
                "name": "memory-review_pack-v5",
                "writeable": True,
                "writeable_when": {"input": "operation", "equals": "record_candidate_feedback"},
            }
        ],
    )

    selected, selected_err = e2b_driver_mod._selected_contexts_for_inputs(cfg, {})
    warm_key, warm_err = e2b_driver_mod._warm_pool_key(
        worker_id="review_pack-v5",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={"operation": "profile"},
        sandbox_template="tmpl",
    )

    assert selected_err is None
    assert selected == [
        {
            "name": "memory-review_pack-v5",
            "writeable": False,
            "source": "local",
            "writeable_when": {"input": "operation", "equals": "record_candidate_feedback"},
        }
    ]
    assert warm_err is None
    assert warm_key


def test_writeable_when_keeps_memory_mount_mutable_for_write_operation(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        inputs=[SimpleNamespace(name="operation", default="record_candidate_feedback")],
        contexts=[
            {
                "name": "memory-review_pack-v5",
                "writeable": True,
                "writeable_when": {"input": "operation", "equals": "record_candidate_feedback"},
            }
        ],
    )

    selected, selected_err = e2b_driver_mod._selected_contexts_for_inputs(
        cfg,
        {"operation": "record_candidate_feedback"},
    )
    warm_key, warm_err = e2b_driver_mod._warm_pool_key(
        worker_id="review_pack-v5",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={},
        sandbox_template="tmpl",
    )

    assert selected_err is None
    assert selected[0]["writeable"] is True
    assert warm_err is None
    assert warm_key is None


def test_read_only_writeable_when_context_is_not_persisted(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        inputs=[SimpleNamespace(name="operation", default="profile")],
        contexts=[
            {
                "name": "memory-review_pack-v5",
                "writeable": True,
                "writeable_when": {"input": "operation", "equals": "record_candidate_feedback"},
            }
        ],
    )
    sandbox = _FakeSandbox()

    e2b_driver_mod.E2BSandboxDriver()._persist_writeable_contexts(
        sandbox=sandbox,
        workdir="/home/user/worker",
        run_id="run-read",
        config=cfg,
        log_fn=lambda *_args: None,
        user_id="u",
        mounted_contexts={"memory-review_pack-v5"},
        writeable_contexts=set(),
    )

    assert sandbox.commands.runs == []


def test_warm_pool_allows_scalar_run_inputs_but_still_keys_selected_contexts(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        contexts=[
            {"name": "search-data", "when": {"input": "operation", "equals": "search"}},
            {"name": "profile-data", "when": {"input": "operation", "equals": "profile"}},
        ],
    )

    search_key, search_err = e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={"operation": "search"},
        sandbox_template="tmpl",
    )
    profile_key, profile_err = e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={"operation": "profile"},
        sandbox_template="tmpl",
    )

    assert search_err is None
    assert profile_err is None
    assert search_key
    assert profile_key
    assert search_key != profile_key


def test_warm_pool_disabled_for_secrets_and_connections(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    cfg = SimpleNamespace(runtime=SimpleNamespace(command="python run.py", type="python"), contexts=[])

    assert e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={},
        secrets={"API_KEY": "secret"},
        sandbox_template="tmpl",
    ) == (None, None)

    connection_cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        contexts=[],
        connections=["gmail"],
    )
    assert e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=connection_cfg,
        inputs={},
        sandbox_template="tmpl",
    ) == (None, None)


def test_warm_pool_key_changes_when_local_context_changes(monkeypatch, tmp_path):
    contexts_root = tmp_path / "contexts"
    (contexts_root / "search-data").mkdir(parents=True)
    data_file = contexts_root / "search-data" / "embeddings.jsonl"
    data_file.write_text("old\n", encoding="utf-8")
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_root))
    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")

    import contexts as contexts_mod
    import runner_sandbox.e2b_driver as e2b_driver_mod

    importlib.reload(contexts_mod)
    importlib.reload(e2b_driver_mod)

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    cfg = SimpleNamespace(
        runtime=SimpleNamespace(command="python run.py", type="python"),
        contexts=[{"name": "search-data"}],
    )

    first_key, first_err = e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={},
        sandbox_template="tmpl",
    )
    data_file.write_text("new-data\n", encoding="utf-8")
    second_key, second_err = e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={},
        sandbox_template="tmpl",
    )

    assert first_err is None
    assert second_err is None
    assert first_key
    assert second_key
    assert first_key != second_key


def test_warm_pool_key_changes_when_bundle_content_changes_same_size(monkeypatch, tmp_path):
    import runner_sandbox.e2b_driver as e2b_driver_mod

    monkeypatch.setenv("WORKEROS_E2B_WARM_POOL_ENABLED", "1")
    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    run_py = worker_dir / "run.py"
    run_py.write_text("print('aa')\n", encoding="utf-8")
    cfg = SimpleNamespace(runtime=SimpleNamespace(command="python run.py", type="python"), contexts=[])

    first_key, first_err = e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={},
        sandbox_template="tmpl",
    )
    run_py.write_text("print('bb')\n", encoding="utf-8")
    second_key, second_err = e2b_driver_mod._warm_pool_key(
        worker_id="w",
        user_id="u",
        worker_dir=worker_dir,
        config=cfg,
        inputs={},
        sandbox_template="tmpl",
    )

    assert first_err is None
    assert second_err is None
    assert first_key
    assert second_key
    assert first_key != second_key


def test_cleanup_run_state_removes_run_scoped_files():
    import runner_sandbox.e2b_driver as e2b_driver_mod

    sandbox = _FakeSandbox()
    assert e2b_driver_mod._cleanup_run_state(sandbox, "/home/user/worker", log_fn=lambda *_args: None) is True
    command = str(sandbox.commands.runs[-1]["command"])
    assert "find . -mindepth 1 -maxdepth 1 -not -name context" in command
    assert "find /tmp -mindepth 1 -maxdepth 1" in command
