"""#1062 — scheduled worker run tripped `_safe_path` traversal guard.

A worker's `runtime.bundle_path` can be a STALE ABSOLUTE path baked at
registration time from an older `FLOOM_WORKERS_DIR` (e.g.
`/opt/workeros-cloud/var/workers/job-digest`). At run time
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
    cfg = _Config("/etc/passwd")
    # basename "passwd" -> WORKERS_DIR/passwd (doesn't exist but resolves safely)
    resolved = _resolve_worker_bundle_dir(workers_dir, "job-digest", cfg, _safe_path)
    assert resolved == (workers_dir / "passwd").resolve()
    # crucially it did NOT return /etc/passwd
    assert resolved != Path("/etc/passwd")
