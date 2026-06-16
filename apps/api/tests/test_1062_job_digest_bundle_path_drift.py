"""#1062 — scheduled worker run tripped `_safe_path` traversal guard.

A worker's `runtime.bundle_path` can be a STALE ABSOLUTE path baked at
registration time from an older `FLOOM_WORKERS_DIR` (e.g.
`/opt/managed-deployment/var/workers/job-digest`). At run time
`FLOOM_WORKERS_DIR` points at `.../engine/workers`, so the stale absolute
path resolved outside the current root and `_resolve_worker_bundle_dir`
raised `ValueError: Path traversal attempt: .../var/workers/job-digest`.

Fix: a stale absolute bundle_path outside the current WORKERS_DIR is treated
as registration-time drift and re-resolved by basename under the configured
WORKERS_DIR — WITHOUT weakening the traversal guard against `..`/symlink
escapes.

Run: cd apps/api && python -m pytest tests/test_1062_job_digest_bundle_path_drift.py -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from runner_utils import _resolve_worker_bundle_dir, _safe_path  # noqa: E402


class _Runtime:
    def __init__(self, bundle_path):
        self.bundle_path = bundle_path


class _Config:
    def __init__(self, bundle_path):
        self.runtime = _Runtime(bundle_path)


def _engine_workers(tmp_path: Path) -> Path:
    d = tmp_path / "engine" / "workers"
    d.mkdir(parents=True, exist_ok=True)
    return d


def test_stale_absolute_var_workers_bundle_path_resolves_under_engine(tmp_path):
    """The exact reported failure: bundle_path points at /.../var/workers/job-digest
    while WORKERS_DIR is /.../engine/workers. Must resolve, not raise."""
    workers_dir = _engine_workers(tmp_path)
    (workers_dir / "job-digest").mkdir()

    # stale absolute path under a DIFFERENT (var/workers) tree
    stale = tmp_path / "var" / "workers" / "job-digest"
    stale.parent.mkdir(parents=True)

    cfg = _Config(str(stale))
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "job-digest").resolve()


def test_relative_bundle_path_unchanged(tmp_path):
    """Existing contract: relative `workers/<id>` resolves under WORKERS_DIR.parent."""
    workers_dir = _engine_workers(tmp_path)
    (workers_dir / "job-digest").mkdir()
    cfg = _Config("workers/job-digest")
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "job-digest").resolve()


def test_bare_relative_bundle_path_resolves_under_workers_dir(tmp_path):
    """Cloud can persist runtime.bundle_path as a bare worker id; it must resolve
    under the configured WORKERS_DIR, not WORKERS_DIR.parent."""
    workers_dir = _engine_workers(tmp_path)
    (workers_dir / "job-digest").mkdir()
    cfg = _Config("job-digest")
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "job-digest").resolve()
    assert resolved != (workers_dir.parent / "job-digest").resolve()


def test_e2b_worker_dir_uses_shared_bare_relative_resolution(tmp_path, monkeypatch):
    """E2B must stay in parity with the shared worker bundle resolver."""
    from runner_sandbox import e2b_driver

    workers_dir = _engine_workers(tmp_path)
    (workers_dir / "job-digest").mkdir()
    monkeypatch.setattr(e2b_driver, "WORKERS_DIR", workers_dir)

    cfg = _Config("job-digest")
    resolved = e2b_driver._worker_dir_for_run("job-digest", cfg)
    assert resolved == (workers_dir / "job-digest").resolve()
    assert resolved != (workers_dir.parent / "job-digest").resolve()


def test_absolute_bundle_path_inside_root_is_honoured(tmp_path):
    """A correct absolute bundle_path under the current root is returned as-is."""
    workers_dir = _engine_workers(tmp_path)
    good = workers_dir / "job-digest"
    good.mkdir()
    cfg = _Config(str(good))
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == good.resolve()


def test_no_bundle_path_resolves_by_worker_id(tmp_path):
    workers_dir = _engine_workers(tmp_path)
    (workers_dir / "job-digest").mkdir()
    cfg = _Config(None)
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "job-digest").resolve()


def test_relative_traversal_still_rejected(tmp_path):
    """The guard must NOT be weakened: `..`-bearing relative paths still raise."""
    workers_dir = _engine_workers(tmp_path)
    cfg = _Config("workers/../../etc")
    with pytest.raises(ValueError, match="Path traversal"):
        _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)


def test_basename_fallback_still_rejects_traversal_in_basename(tmp_path):
    """Drift fallback uses basename only; even a malicious absolute path can't
    escape because only its basename is joined under WORKERS_DIR via _safe_path."""
    workers_dir = _engine_workers(tmp_path)
    # absolute path outside root whose basename is benign
    outside = tmp_path / "outside" / "passwd"
    cfg = _Config(str(outside))
    # basename "passwd" -> WORKERS_DIR/passwd (doesn't exist but resolves safely)
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "passwd").resolve()
    # crucially it did NOT return /etc/passwd
    assert resolved != outside.resolve()


def test_stale_absolute_resolves_under_extra_root_when_listed(tmp_path, monkeypatch):
    """The real cloud case: job-digest's bundle lives ONLY under var/workers.
    When that root is listed in FLOOM_EXTRA_WORKERS_DIRS and the dir exists, the
    stored absolute path resolves there instead of an absent engine/ basename."""
    import runner_utils

    workers_dir = _engine_workers(tmp_path)  # engine/workers (no job-digest)
    var_workers = tmp_path / "var" / "workers"
    bundle = var_workers / "job-digest"
    bundle.mkdir(parents=True)

    monkeypatch.setenv("FLOOM_EXTRA_WORKERS_DIRS", str(var_workers))
    cfg = _Config(str(bundle))
    resolved = runner_utils._resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == bundle.resolve()


def test_extra_root_not_listed_falls_back_to_basename(tmp_path, monkeypatch):
    """Without the env allow-list, a var/workers absolute path is NOT honoured
    (no silent trust of arbitrary roots); it falls back to basename under engine."""
    import runner_utils

    workers_dir = _engine_workers(tmp_path)
    var_workers = tmp_path / "var" / "workers"
    bundle = var_workers / "job-digest"
    bundle.mkdir(parents=True)

    monkeypatch.delenv("FLOOM_EXTRA_WORKERS_DIRS", raising=False)
    cfg = _Config(str(bundle))
    resolved = runner_utils._resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "job-digest").resolve()
    assert resolved != bundle.resolve()


def test_extra_root_listed_but_dir_absent_falls_back(tmp_path, monkeypatch):
    """Allow-listed root but the bundle dir doesn't exist there → basename fallback,
    not a non-existent path under the extra root."""
    import runner_utils

    workers_dir = _engine_workers(tmp_path)
    var_workers = tmp_path / "var" / "workers"
    var_workers.mkdir(parents=True)  # root exists, but no job-digest inside

    monkeypatch.setenv("FLOOM_EXTRA_WORKERS_DIRS", str(var_workers))
    cfg = _Config(str(var_workers / "job-digest"))
    resolved = runner_utils._resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "job-digest").resolve()


# --- A-05 parity: symlink-containment assert on accepted-absolute branches ----


def test_a05_absolute_symlink_escaping_extra_root_is_not_honoured(tmp_path, monkeypatch):
    """A-05: a symlink *inside* an allowed extra root that points outside it
    (e.g. <var/workers>/job-digest -> /etc) must NOT be returned as the bundle
    dir. With the realpath-containment parity assert in place, the escaping
    target is rejected and resolution falls back to the safe basename under the
    configured WORKERS_DIR — never the symlink target."""
    import os
    import runner_utils

    workers_dir = _engine_workers(tmp_path)
    var_workers = tmp_path / "var" / "workers"
    var_workers.mkdir(parents=True)
    # outside-root real dir the symlink will point at
    outside = tmp_path / "outside-secret"
    outside.mkdir()
    link = var_workers / "job-digest"
    try:
        os.symlink(outside, link)  # <extra_root>/job-digest -> /.../outside-secret
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    monkeypatch.setenv("FLOOM_EXTRA_WORKERS_DIRS", str(var_workers))
    cfg = _Config(str(link))
    resolved = runner_utils._resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)

    # MUST NOT resolve to the escaping symlink target.
    assert resolved != outside.resolve()
    # Falls back to the safe basename under the configured root.
    assert resolved == (workers_dir / "job-digest").resolve()


def test_a05_realpath_assert_helper_rejects_symlink_escape(tmp_path):
    """Direct unit test of the parity helper: a symlinked path whose realpath
    escapes the root is rejected, a contained path is returned unchanged."""
    import os
    import runner_utils

    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    escape = root / "evil"
    try:
        os.symlink(outside, escape)
    except OSError as exc:
        pytest.skip(f"symlink creation unavailable: {exc}")

    with pytest.raises(ValueError, match="symlink escape"):
        runner_utils._assert_realpath_contained(escape, root)

    good = root / "ok"
    good.mkdir()
    assert runner_utils._assert_realpath_contained(good, root) == good
