"""Regression: the worker path-traversal guard must not fire on legit paths.

Root cause (2026-06-14 cloud audit, Issue 10): on Railway, FLOOM_WORKERS_DIR was
`/opt/managed-deployment/var/workers` where a parent segment is a symlink. The old
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


def test_worker_registry_symlink_inside_base_escape_blocked(tmp_path, monkeypatch):
    """Defense-in-depth: a symlink *inside* the workers dir that points outside
    it must be rejected by the realpath containment assertion, even though the
    path is lexically clean (no ``..``, not absolute). This is the adversarial
    PoC: plant ``<WORKERS_DIR>/evil -> /etc`` and try to read ``evil/hostname``.
    """
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    (workers_dir / "evil").symlink_to("/etc")

    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    import worker_registry
    importlib.reload(worker_registry)
    try:
        try:
            worker_registry._safe_path("evil/hostname")
        except ValueError:
            pass  # expected: realpath resolves to /etc/hostname, outside base
        else:
            raise AssertionError(
                "expected ValueError for symlink-escape 'evil/hostname'"
            )
    finally:
        os.environ.pop("FLOOM_WORKERS_DIR", None)
        importlib.reload(worker_registry)


def test_runner_utils_symlink_inside_base_escape_blocked(tmp_path):
    """Same realpath escape guard for runner_utils._safe_path(base, *parts)."""
    import runner_utils
    importlib.reload(runner_utils)
    base = tmp_path / "base"
    base.mkdir()
    (base / "evil").symlink_to("/etc")
    try:
        runner_utils._safe_path(base, "evil", "hostname")
    except ValueError:
        pass  # expected
    else:
        raise AssertionError("expected ValueError for symlink-escape 'evil/hostname'")


def test_worker_registry_symlinked_deploy_root_still_works(tmp_path):
    """Regression guard for the original P0 the PR fixed: when WORKERS_DIR is
    reached *through* a symlink (Railway deploy root), a legit worker id must
    still resolve. The realpath layer must NOT re-break this, because base and
    target both fully resolve the same symlink prefix.
    """
    realbase = tmp_path / "realbase"
    (realbase / "workers").mkdir(parents=True)
    symbase = tmp_path / "symbase"
    symbase.symlink_to(realbase)
    workers_dir = symbase / "workers"
    (workers_dir / "outbound-approval-demo").mkdir()

    os.environ["FLOOM_WORKERS_DIR"] = str(workers_dir)
    import worker_registry
    importlib.reload(worker_registry)
    try:
        resolved = worker_registry._safe_path("outbound-approval-demo")
        assert resolved.name == "outbound-approval-demo"
    finally:
        os.environ.pop("FLOOM_WORKERS_DIR", None)
        importlib.reload(worker_registry)


def test_safe_path_nonexistent_leaf_allowed(tmp_path):
    """Creating a not-yet-existing worker/run dir must not be blocked by the
    realpath layer (realpath resolves the existing prefix, leaves the leaf).
    """
    import runner_utils
    importlib.reload(runner_utils)
    base = tmp_path / "base"
    base.mkdir()
    resolved = runner_utils._safe_path(base, "brand-new-run-id")
    assert resolved.name == "brand-new-run-id"
    assert not resolved.exists()  # leaf truly does not exist yet
    # nested non-existent path under a clean base is also fine
    nested = runner_utils._safe_path(base, "a", "b", "c")
    assert nested.name == "c"
