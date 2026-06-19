"""Wedge reliability engine fixes (2026-05-29, batch H).

These tests cover the engine-level gating + substance checks that lift the
generated-worker reliability rate, independent of any single worker:

- FIX 2: a smoke-failed generated worker is DISABLED (not deleted, stays
  editable) so the dashboard never counts it as healthy.
- FIX 3: a worker that returns status=success with an empty / missing declared
  output (green-but-empty no-op) is routed through the bounded repair loop and,
  if still empty, smoke=failed.

They are pure-function on a fake repos + a stubbed sandbox driver, so they touch
no HTTP/auth and no real E2B.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
API_DIR = ROOT / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service  # noqa: E402
from services import run_authoring  # noqa: E402
from models import (  # noqa: E402
    WorkerConfig,
    WorkerOutput,
    WorkerRuntime,
    WorkerTrigger,
    WorkerResult,
)


def _script_config(outputs):
    return WorkerConfig(
        id="gen-test",
        name="Gen Test",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type="script", entrypoint="run.py", runner="e2b", mode="pure-script"),
        outputs=outputs,
    )


class _FakeWorkersRepo:
    def __init__(self):
        self.enabled = {"gen-test": True}
        self.updates = []

    def update(self, *, user_id, worker_id, **fields):
        self.updates.append((worker_id, fields))
        if "enabled" in fields:
            self.enabled[worker_id] = bool(fields["enabled"])
        return {"id": worker_id, **fields}


class _FakeRepos:
    def __init__(self):
        self.workers = _FakeWorkersRepo()


def test_failed_smoke_disables_worker(monkeypatch):
    # FIX 2: a failed smoke verdict must disable the worker (enabled -> False),
    # never delete it.
    repos = _FakeRepos()
    # #1073 moved _smoke_and_repair_generated_worker into services.run_authoring,
    # where smoke_and_gate_generated_worker calls it by bare name. Patch it there
    # so the gate sees the canned verdict (patching the run_service re-export is a
    # no-op for the in-module call).
    monkeypatch.setattr(
        run_authoring,
        "_smoke_and_repair_generated_worker",
        lambda *a, **k: {"status": "failed", "reason": "list index out of range", "repairs": 1},
    )
    logs = []
    smoke = run_service.smoke_and_gate_generated_worker(
        "gen-test",
        {},
        user_id="u1",
        repos=repos,
        log_fn=lambda msg, level="info": logs.append((level, msg)),
    )
    assert smoke["status"] == "failed"
    assert repos.workers.enabled["gen-test"] is False
    assert any("enabled" in f for _, f in repos.workers.updates)


def test_passed_smoke_leaves_worker_enabled(monkeypatch):
    repos = _FakeRepos()
    monkeypatch.setattr(
        run_authoring,
        "_smoke_and_repair_generated_worker",
        lambda *a, **k: {"status": "passed", "reason": "", "repairs": 0},
    )
    smoke = run_service.smoke_and_gate_generated_worker(
        "gen-test",
        {},
        user_id="u1",
        repos=repos,
        log_fn=lambda *a, **k: None,
    )
    assert smoke["status"] == "passed"
    assert repos.workers.enabled["gen-test"] is True
    assert repos.workers.updates == []


def test_skipped_smoke_leaves_worker_enabled(monkeypatch):
    repos = _FakeRepos()
    monkeypatch.setattr(
        run_authoring,
        "_smoke_and_repair_generated_worker",
        lambda *a, **k: {"status": "skipped", "reason": "needs a credential"},
    )
    run_service.smoke_and_gate_generated_worker(
        "gen-test", {}, user_id="u1", repos=repos, log_fn=lambda *a, **k: None
    )
    assert repos.workers.enabled["gen-test"] is True
    assert repos.workers.updates == []


def _make_smoke_env(monkeypatch, tmp_path, config, driver_factory):
    """Wire the minimum the smoke loop needs: worker dir + recipe + driver."""
    workers_dir = tmp_path / "workers"
    (workers_dir / "gen-test").mkdir(parents=True)
    (workers_dir / "gen-test" / "run.py").write_text("def main():\n    pass\n")
    # #1073 moved the smoke loop into services.run_authoring, which reads
    # WORKERS_DIR/ARTIFACTS_DIR from its OWN module globals (imported from
    # worker_registry/runner_utils), not from run_service. Patch both so the
    # loop sees the temp dirs regardless of which name it resolves.
    monkeypatch.setattr(run_service, "WORKERS_DIR", workers_dir)
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    monkeypatch.setattr(run_authoring, "WORKERS_DIR", workers_dir)
    monkeypatch.setattr(run_authoring, "ARTIFACTS_DIR", tmp_path / "artifacts")
    (tmp_path / "artifacts").mkdir()

    monkeypatch.setattr(run_service, "_load_worker_recipe", lambda wid, repos=None: ("u1", config, {"enabled": True}))
    monkeypatch.setattr(run_service, "get_secrets_for_worker", lambda *a, **k: {})
    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *a, **k: driver_factory())
    # context scope is a no-op context manager in this stub
    import contextlib

    monkeypatch.setattr(run_service, "use_context_scope", lambda *a, **k: contextlib.nullcontext())
    monkeypatch.setattr(run_service, "context_scope_for_user", lambda *a, **k: None)
    # never make a real repair model call
    monkeypatch.setattr(run_service, "_repair_run_py", lambda **k: None)


def test_green_but_empty_output_is_smoke_failed(monkeypatch, tmp_path):
    # FIX 3: status=success with an empty declared output is NOT a pass. After
    # the repair budget is exhausted it becomes smoke=failed.
    config = _script_config([
        WorkerOutput(
            name="converted",
            label="Converted",
            type="file",
            kind="file",
            media_type="application/json",
            path="out/converted.json",
            required=True,
        )
    ])

    class _EmptyDriver:
        def run(self, **kwargs):
            run_id = kwargs["run_id"]
            art_dir = (tmp_path / "artifacts" / run_id / "out")
            art_dir.mkdir(parents=True, exist_ok=True)
            # The classic green-but-empty no-op: success + empty JSON list.
            (art_dir / "converted.json").write_text("[]")
            return WorkerResult(
                status="success",
                outputs={"converted": "out/converted.json"},
                artifacts=[
                    {
                        "name": "out/converted.json",
                        "relative_path": "out/converted.json",
                        "type": "application/json",
                        "path": str(art_dir / "converted.json"),
                        "size_bytes": 2,
                    }
                ],
            )

    _make_smoke_env(monkeypatch, tmp_path, config, _EmptyDriver)
    smoke = run_service._smoke_and_repair_generated_worker(
        "gen-test", {}, user_id="u1", repos=_FakeRepos(), log_fn=lambda *a, **k: None
    )
    # The exact P0-2 green-but-empty no-op: status=success + a required output
    # that is an empty `[]` JSON container. The smoke substance gate must catch
    # it (repair budget exhausted -> failed), NOT ship it green.
    assert smoke["status"] == "failed"
    assert "empty" in smoke["reason"] or "no real output" in smoke["reason"]


def test_missing_required_output_is_smoke_failed(monkeypatch, tmp_path):
    # FIX 3: success but the required declared output was never produced -> the
    # substance gate fails it, the repair loop runs (no-op here) and smoke fails.
    config = _script_config([
        WorkerOutput(
            name="converted",
            label="Converted",
            type="file",
            kind="file",
            media_type="application/json",
            path="out/converted.json",
            required=True,
        )
    ])

    class _NoOutputDriver:
        def run(self, **kwargs):
            # success, but never writes the declared file
            return WorkerResult(status="success", outputs={}, artifacts=[])

    _make_smoke_env(monkeypatch, tmp_path, config, _NoOutputDriver)
    smoke = run_service._smoke_and_repair_generated_worker(
        "gen-test", {}, user_id="u1", repos=_FakeRepos(), log_fn=lambda *a, **k: None
    )
    assert smoke["status"] == "failed"
    assert "missing required output" in smoke["reason"] or "no real output" in smoke["reason"]


def test_empty_text_output_is_smoke_failed(monkeypatch, tmp_path):
    # success + a declared text output that is whitespace-only -> empty -> fail.
    config = _script_config([
        WorkerOutput(
            name="report",
            label="Report",
            type="file",
            kind="file",
            media_type="text/plain",
            path="out/report.txt",
            required=True,
        )
    ])

    class _WhitespaceDriver:
        def run(self, **kwargs):
            run_id = kwargs["run_id"]
            art_dir = (tmp_path / "artifacts" / run_id / "out")
            art_dir.mkdir(parents=True, exist_ok=True)
            (art_dir / "report.txt").write_text("   \n  \n")
            return WorkerResult(
                status="success",
                outputs={"report": "out/report.txt"},
                artifacts=[
                    {
                        "name": "out/report.txt",
                        "relative_path": "out/report.txt",
                        "type": "text/plain",
                        "path": str(art_dir / "report.txt"),
                        "size_bytes": 7,
                    }
                ],
            )

    _make_smoke_env(monkeypatch, tmp_path, config, _WhitespaceDriver)
    smoke = run_service._smoke_and_repair_generated_worker(
        "gen-test", {}, user_id="u1", repos=_FakeRepos(), log_fn=lambda *a, **k: None
    )
    assert smoke["status"] == "failed"
    assert "empty" in smoke["reason"] or "no real output" in smoke["reason"]


def test_small_valid_output_smoke_passes(monkeypatch, tmp_path):
    # FIX 1 + FIX 3 interplay: a real, small, non-empty output passes the smoke.
    config = _script_config([
        WorkerOutput(
            name="out_csv",
            label="Out CSV",
            type="file",
            kind="file",
            media_type="text/csv",
            path="out/out.csv",
            required=True,
        )
    ])

    class _SmallOutputDriver:
        def run(self, **kwargs):
            run_id = kwargs["run_id"]
            art_dir = (tmp_path / "artifacts" / run_id / "out")
            art_dir.mkdir(parents=True, exist_ok=True)
            (art_dir / "out.csv").write_text("name\nALICE\nBOB\n")
            return WorkerResult(
                status="success",
                outputs={"out_csv": "out/out.csv"},
                artifacts=[
                    {
                        "name": "out/out.csv",
                        "relative_path": "out/out.csv",
                        "type": "text/csv",
                        "path": str(art_dir / "out.csv"),
                        "size_bytes": 15,
                    }
                ],
            )

    _make_smoke_env(monkeypatch, tmp_path, config, _SmallOutputDriver)
    smoke = run_service._smoke_and_repair_generated_worker(
        "gen-test", {}, user_id="u1", repos=_FakeRepos(), log_fn=lambda *a, **k: None
    )
    assert smoke["status"] == "passed"


# ---------------------------------------------------------------------------
# P2-C (2026-05-29): user-supplied run.py must NEVER be auto-rewritten.
# allow_code_repair gates the bounded auto-repair: True only for LLM-generated
# bundles (the wedge); False for user-supplied uploads.
# ---------------------------------------------------------------------------

def _failing_code_driver():
    class _ExecErrorDriver:
        def run(self, **kwargs):
            # A code-class failure: triggers the repair branch when repair is
            # allowed, otherwise must be gated as-is.
            return WorkerResult(
                status="error",
                error="ZeroDivisionError: division by zero",
                error_code="execution_error",
                outputs={},
                artifacts=[],
            )

    return _ExecErrorDriver()


def _scalar_config():
    return _script_config([
        WorkerOutput(name="score", label="Score", type="scalar", kind="scalar", required=True)
    ])


def _track_repair_env(monkeypatch, tmp_path, config, *, user_run_py):
    """Like _make_smoke_env but records every _repair_run_py call and writes a
    user-authored run.py so we can assert byte-identity."""
    workers_dir = tmp_path / "workers"
    (workers_dir / "gen-test").mkdir(parents=True)
    run_path = workers_dir / "gen-test" / "run.py"
    run_path.write_text(user_run_py)
    monkeypatch.setattr(run_service, "WORKERS_DIR", workers_dir)
    monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
    monkeypatch.setattr(run_authoring, "WORKERS_DIR", workers_dir)
    monkeypatch.setattr(run_authoring, "ARTIFACTS_DIR", tmp_path / "artifacts")
    (tmp_path / "artifacts").mkdir()
    monkeypatch.setattr(
        run_service, "_load_worker_recipe", lambda wid, repos=None: ("u1", config, {"enabled": True})
    )
    monkeypatch.setattr(run_service, "get_secrets_for_worker", lambda *a, **k: {})
    monkeypatch.setattr(run_service, "get_sandbox_driver", lambda *a, **k: _failing_code_driver())
    import contextlib

    monkeypatch.setattr(run_service, "use_context_scope", lambda *a, **k: contextlib.nullcontext())
    monkeypatch.setattr(run_service, "context_scope_for_user", lambda *a, **k: None)

    repair_calls: list = []

    def _spy_repair(**kwargs):
        repair_calls.append(kwargs)
        # Return a rewrite so that, IF the repair branch runs, the run.py would
        # change — making any user-code mutation observable.
        return user_run_py.replace("1 / 0", "1 / 1")

    monkeypatch.setattr(run_service, "_repair_run_py", _spy_repair)
    return run_path, repair_calls


def test_user_supplied_code_is_not_repaired(monkeypatch, tmp_path):
    # P2-C: allow_code_repair=False (user upload). A runtime failure must NOT
    # trigger a rewrite of the user's run.py: _repair_run_py is never called and
    # the file on disk stays byte-identical.
    user_run_py = "import json\n\ndef main():\n    x = 1 / 0  # intentional\n    return x\n"
    run_path, repair_calls = _track_repair_env(
        monkeypatch, tmp_path, _scalar_config(), user_run_py=user_run_py
    )
    before = run_path.read_bytes()
    smoke = run_service._smoke_and_repair_generated_worker(
        "gen-test",
        {},
        user_id="u1",
        repos=_FakeRepos(),
        log_fn=lambda *a, **k: None,
        allow_code_repair=False,
    )
    assert smoke["status"] == "failed"
    assert smoke["repairs"] == 0
    assert repair_calls == [], "user-supplied run.py must never be auto-repaired"
    assert run_path.read_bytes() == before, "user run.py was mutated — least-surprise violated"


def test_generated_code_still_repairs(monkeypatch, tmp_path):
    # P2-C no-regression: allow_code_repair=True (LLM-generated, the default
    # wedge). A code-class failure MUST still trigger the bounded auto-repair.
    gen_run_py = "import json\n\ndef main():\n    x = 1 / 0\n    return x\n"

    # The repair loop lazily does `import main as _main; _main.persist_worker_run_py`.
    # Inject a hermetic stub `main` module so the test never touches the real
    # init_db()/DB path while still proving the repair branch executed.
    import sys as _sys

    fake_main = types.ModuleType("main")
    fake_main.persist_worker_run_py = lambda *a, **k: None
    monkeypatch.setitem(_sys.modules, "main", fake_main)

    run_path, repair_calls = _track_repair_env(
        monkeypatch, tmp_path, _scalar_config(), user_run_py=gen_run_py
    )
    smoke = run_service._smoke_and_repair_generated_worker(
        "gen-test",
        {},
        user_id="u1",
        repos=_FakeRepos(),
        log_fn=lambda *a, **k: None,
        allow_code_repair=True,
    )
    # The wedge: at least one repair attempt was made on generated code.
    assert len(repair_calls) >= 1, "generated worker must still self-repair (wedge regression)"


def test_resolve_worker_status_list_detail_agree():
    # P2-A: the SHARED resolver returns identical status for identical inputs,
    # so the LIST and DETAIL endpoints can never disagree for the same worker.
    import main as _main
    from models import WorkerStatus, RunStatus

    # never-run, enabled, no secrets -> READY (not an unearned healthy)
    w_ready = {"status": "healthy", "archived": False, "enabled": True}
    assert _main._resolve_worker_status(
        w_ready, config=None, available_secret_names=[], last_run_status=None, has_run=False
    ) == WorkerStatus.READY

    # disabled worker -> needs_attention (broken, never healthy)
    w_disabled = {"status": "healthy", "archived": False, "enabled": False}
    assert _main._resolve_worker_status(
        w_disabled, config=None, available_secret_names=[], last_run_status=None, has_run=True
    ) == WorkerStatus.NEEDS_ATTENTION

    # last run failed -> needs_attention
    w_failed = {"status": "healthy", "archived": False, "enabled": True}
    assert _main._resolve_worker_status(
        w_failed,
        config=None,
        available_secret_names=[],
        last_run_status=RunStatus.FAILED,
        has_run=True,
    ) == WorkerStatus.NEEDS_ATTENTION

    # ran, succeeded, enabled -> healthy (earned)
    w_healthy = {"status": "healthy", "archived": False, "enabled": True}
    assert _main._resolve_worker_status(
        w_healthy,
        config=None,
        available_secret_names=[],
        last_run_status=RunStatus.COMPLETED,
        has_run=True,
    ) == WorkerStatus.HEALTHY
