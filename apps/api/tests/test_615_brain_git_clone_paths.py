"""#615 — brain git-clone path: cover the failure + skip branches.

Happy paths already exist (tests/test_e2b_artifact_collection.py clones a real
repo into the sandbox context dir; writeable round-trip persists edits). This
adds the two uncovered branches:
  - E2B: git clone failing (non-zero exit) must surface a hard error naming
    the pack, not continue with an empty context dir
  - Agent (in-process) path: stage_context_packs must SKIP git+ sources with
    a warning and still stage local packs — git packs are E2B-only today

Run: cd apps/api && python -m pytest tests/test_615_brain_git_clone_paths.py -q
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, WorkerRuntime, WorkerTrigger
from runner_sandbox import agent_capabilities
from runner_sandbox.e2b_driver import E2BSandboxDriver


class _FailingCloneCommands:
    def __init__(self):
        self.run_calls = []

    def run(self, command: str, **kwargs):
        self.run_calls.append((command, kwargs))
        return types.SimpleNamespace(
            exit_code=128,
            stdout="",
            stderr="fatal: repository 'https://github.com/example/missing.git' not found",
        )


class _Files:
    def __init__(self):
        self.dirs: set[str] = set()
        self._files: dict[str, bytes] = {}

    def make_dir(self, path: str):
        self.dirs.add(path)


class _Sandbox:
    def __init__(self):
        self.files = _Files()
        self.commands = _FailingCloneCommands()


def _config(contexts):
    return WorkerConfig(
        id="git-clone-failure-test",
        name="Git Clone Failure Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="python311", command="python run.py", mode="pure-script"),
        contexts=contexts,
        outputs=[],
    )


def test_e2b_git_clone_failure_is_a_hard_error():
    sandbox = _Sandbox()
    err = E2BSandboxDriver()._upload_contexts_to_sandbox(
        sandbox=sandbox,
        workdir="/home/user/worker",
        config=_config([{"name": "missing-pack", "source": "git+https://github.com/example/missing.git"}]),
        made_dirs={"/home/user/worker"},
        log_fn=lambda *_a, **_k: None,
    )
    assert err is not None
    assert "missing-pack" in err
    assert "exit 128" in err
    assert "not found" in err
    assert len(sandbox.commands.run_calls) == 1


def test_agent_path_skips_git_pack_and_stages_local(tmp_path, monkeypatch):
    contexts_root = tmp_path / "contexts"
    local_pack = contexts_root / "local-notes"
    local_pack.mkdir(parents=True)
    (local_pack / "facts.md").write_text("local fact\n", encoding="utf-8")

    import contexts as contexts_module

    monkeypatch.setattr(contexts_module, "CONTEXTS_DIR", contexts_root)

    warnings: list[str] = []

    def _log(msg, level="info"):
        if level == "warning":
            warnings.append(msg)

    context_root = tmp_path / "staged"
    context_root.mkdir()
    staged = agent_capabilities.stage_context_packs(
        config=_config([
            {"name": "git-notes", "source": "git+https://github.com/example/notes.git"},
            {"name": "local-notes"},
        ]),
        context_root=context_root,
        user_id=None,
        log_fn=_log,
    )

    assert staged == ["local-notes"]
    assert (context_root / "local-notes" / "facts.md").read_text(encoding="utf-8") == "local fact\n"
    assert not (context_root / "git-notes").exists()
    assert any("git-notes" in w and "not supported" in w for w in warnings)
