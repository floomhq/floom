"""Regression: the worker path-traversal guard must not fire on legit paths.

Root cause (2026-06-14 cloud audit, Issue 10): on Railway, FLOOM_WORKERS_DIR was
`/opt/workeros-cloud/var/workers` where a parent segment is a symlink. The old
`_safe_path` did `WORKERS_DIR.joinpath(id).resolve()` then
`relative_to(WORKERS_DIR)` — `.resolve()` follows symlinks, so a valid
`<WORKERS_DIR>/<worker_id>` could resolve to a realpath that is no longer
`relative_to` the (also-resolved-but-differently) base, raising
`ValueError: Path traversal attempt`. That bubbled to the global handler as a
generic 400. Fix: check containment lexically (os.path.normpath) and reject only
genuine escapes (absolute parts, `..` segments).
"""

import importlib
import os
from pathlib import Path


def _reload_with_workers_dir(tmp_path: Path):
    os.environ["FLOOM_WORKERS_DIR"] = str(tmp_path)
    import worker_registry
    import runner_utils
    importlib.reload(worker_registry)
    importlib.reload(runner_utils)
    return worker_registry, runner_utils


def test_legit_worker_id_resolves_under_symlinked_root(tmp_path, monkeypatch):
    # Build a symlinked deploy root: <tmp>/link -> <tmp>/real, workers under link.
    real = tmp_path / "real"
    (real / "workers").mkdir(parents=True)
    link = tmp_path / "link"
    link.symlink_to(real)
    workers_dir = link / "workers"
    (workers_dir / "outbound-approval-demo").mkdir()

    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    import worker_registry
    importlib.reload(worker_registry)
    try:
        # The old guard would raise here because .resolve() collapses the symlink.
        resolved = worker_registry._safe_path("outbound-approval-demo")
        assert resolved.name == "outbound-approval-demo"
    finally:
        os.environ.pop("FLOOM_WORKERS_DIR", None)
        importlib.reload(worker_registry)


def test_traversal_escape_is_rejected(tmp_path, monkeypatch):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    import worker_registry
    importlib.reload(worker_registry)
    try:
        for bad in ("../../etc", "../secrets", "/etc/passwd"):
            try:
                worker_registry._safe_path(bad)
            except ValueError:
                continue
            raise AssertionError(f"expected ValueError for traversal part {bad!r}")
    finally:
        os.environ.pop("FLOOM_WORKERS_DIR", None)
        importlib.reload(worker_registry)


def test_runner_utils_safe_path_symlinked_base(tmp_path, monkeypatch):
    import runner_utils
    importlib.reload(runner_utils)
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    link.symlink_to(real)
    # A legit child under the symlinked base must resolve, not raise.
    resolved = runner_utils._safe_path(link, "wkr-123")
    assert resolved.name == "wkr-123"
    # Escapes still rejected.
    try:
        runner_utils._safe_path(link, "../escape")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for '../escape'")
