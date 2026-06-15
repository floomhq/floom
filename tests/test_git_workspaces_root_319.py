"""Regression tests for #319 — git workspace commits silently fail on Railway.

The container runs as an unprivileged user and WORKEROS_GIT_WORKSPACES_DIR
pointed at a non-writable path (/data/git-workspaces), so repo init's mkdir
raised PermissionError and commit_workspace swallowed it — silently breaking
versioning, rollback and the git-bundle backup. get_workspaces_root now falls
back to a guaranteed-writable root when the configured one isn't usable.
"""

from __future__ import annotations

from pathlib import Path

import apps.api.cloud_git_local as cgl


def test_dir_is_usable_for_creatable_dir(tmp_path):
    assert cgl._dir_is_usable(tmp_path / "new" / "nested") is True


def test_uses_configured_when_writable(monkeypatch, tmp_path):
    cfg = tmp_path / "cfg"
    monkeypatch.setenv("WORKEROS_GIT_WORKSPACES_DIR", str(cfg))
    monkeypatch.setattr(cgl, "_dir_is_usable", lambda p: True)
    assert cgl.get_workspaces_root() == cfg


def test_falls_back_when_configured_unusable(monkeypatch, tmp_path):
    fallback = tmp_path / "var" / "git-workspaces"
    monkeypatch.setattr(cgl, "_FALLBACK_WORKSPACES_ROOT", fallback)
    monkeypatch.setenv("WORKEROS_GIT_WORKSPACES_DIR", "/data/git-workspaces")
    # configured (/data) unusable; fallback usable.
    monkeypatch.setattr(cgl, "_dir_is_usable", lambda p: p == fallback)
    assert cgl.get_workspaces_root() == fallback


def test_returns_configured_when_nothing_usable(monkeypatch):
    # Neither configured nor fallback usable -> return configured so the
    # caller's mkdir surfaces the real error (now logged at ERROR).
    monkeypatch.setenv("WORKEROS_GIT_WORKSPACES_DIR", "/data/git-workspaces")
    monkeypatch.setattr(cgl, "_dir_is_usable", lambda p: False)
    assert cgl.get_workspaces_root() == Path("/data/git-workspaces")
