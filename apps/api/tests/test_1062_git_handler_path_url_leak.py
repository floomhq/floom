"""A-05 — git endpoints must not leak fs paths or token-bearing remote URLs.

`GitOpsError` messages are built from `git` stderr, which routinely echoes
the remote URL (e.g. `fatal: unable to access
'https://x-access-token:<PAT>@github.com/...'`) AND server filesystem paths.
The git endpoints used to serialize `{exc}` verbatim into the HTTP response,
leaking the workspace's GitHub token and internal fs layout.

Pins (mirrors the #836 / `_mcp_internal_error` hardening):
  - `_git_safe_http_detail` returns a generic, user-safe message with no
    `/opt/`, no `https://...@`, no `token`, while keeping the user-meaningful
    classification (auth failed / repo not found / network).
  - the three git endpoints (link / push / import-clone) route through it.

Run: cd apps/api && python -m pytest tests/test_1062_git_handler_path_url_leak.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


# A realistic git stderr that leaks BOTH an fs path and a token-bearing URL.
LEAKY_GIT_STDERR = (
    "git push failed: fatal: unable to access "
    "'https://x-access-token:ghp_SECRETTOKEN1234567890@github.com/floomhq/workeros.git/': "
    "The requested URL returned error: 403; "
    "could not read from '/opt/workeros-cloud/var/workspaces/ws_abc/.git'"
)

LEAK_MARKERS = ("/opt/", "ghp_", "x-access-token", "@github.com", "https://", "secrettoken", ".git'")


@pytest.fixture
def main_mod(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "engine" / "workers"))
    (tmp_path / "engine" / "workers").mkdir(parents=True)
    for name in list(sys.modules):
        if name in ("main", "db", "contexts", "git_ops", "github_api") or name.startswith("db."):
            sys.modules.pop(name, None)
    main = importlib.import_module("main")
    return main


def test_git_safe_detail_strips_paths_and_tokens(main_mod):
    main = main_mod
    err = main._git_ops.GitOpsError(LEAKY_GIT_STDERR)
    msg = main._git_safe_http_detail(err, "push")
    low = msg.lower()
    for marker in LEAK_MARKERS:
        assert marker.lower() not in low, f"git error leaks {marker!r}: {msg}"
    # 403 → user-meaningful auth classification, no internals
    assert "authentication failed" in low


def test_git_safe_detail_classifies_not_found(main_mod):
    main = main_mod
    err = main._git_ops.GitOpsError(
        "git clone failed: remote: Repository not found. "
        "fatal: repository 'https://x-access-token:ghp_X@github.com/a/b.git/' not found; "
        "/opt/workeros-cloud/var/x"
    )
    msg = main._git_safe_http_detail(err, "clone")
    low = msg.lower()
    for marker in LEAK_MARKERS:
        assert marker.lower() not in low, f"leaks {marker!r}: {msg}"
    assert "repository not found" in low


def test_git_safe_detail_generic_fallback(main_mod):
    main = main_mod
    err = main._git_ops.GitOpsError(
        "git push failed: error: some weird internal /opt/secret/path failure "
        "https://x-access-token:ghp_Y@github.com/a/b.git"
    )
    msg = main._git_safe_http_detail(err, "push")
    low = msg.lower()
    for marker in LEAK_MARKERS:
        assert marker.lower() not in low, f"leaks {marker!r}: {msg}"
    assert "git operation failed" in low


def test_github_api_safe_detail_keeps_clean_message(main_mod):
    main = main_mod
    # GitHub's own message is safe + user-meaningful — keep it.
    err = main._github_api_safe_detail(RuntimeError("Bad credentials"))
    assert err == "GitHub error: Bad credentials"


def test_github_api_safe_detail_redacts_url_token(main_mod):
    main = main_mod
    err = main._github_api_safe_detail(
        RuntimeError("failed at https://x-access-token:ghp_Z@github.com/a/b")
    )
    low = err.lower()
    for marker in ("ghp_", "x-access-token", "@github.com", "https://"):
        assert marker not in low, f"leaks {marker!r}: {err}"


def test_git_endpoints_route_through_safe_helper(main_mod):
    """Reverting any git endpoint back to f-string {exc} must fail this."""
    src = Path(__file__).resolve().parents[1].joinpath("main.py").read_text(encoding="utf-8")
    for banned in (
        'detail=f"Git operation failed: {exc}"',
        'detail=f"Push failed: {exc}"',
        'detail=f"Clone failed: {exc}"',
        'detail=f"GitHub error: {exc}"',
    ):
        assert banned not in src, f"git endpoint reverted to raw exc leak: {banned}"
    # and the safe helpers are wired in
    assert '_git_safe_http_detail(exc, "link")' in src
    assert '_git_safe_http_detail(exc, "push")' in src
    assert '_git_safe_http_detail(exc, "clone")' in src
    assert "_github_api_safe_detail(exc)" in src
