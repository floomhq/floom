"""#582 — Local git fallback: store WORKEROS_SECRETS_KEY in ~/.config/workeros/secrets.key

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_batch_secrets_key.py -x -q
"""
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import main as _main
# _get_or_create_secrets_key + its module state moved to services.git_service;
# patch/rebind the SERVICE module (the function reads ITS globals), while the
# re-exported callable on main stays the same object.
from services import git_service as _gitsvc


# ---------------------------------------------------------------------------
# #582 — _LOCAL_KEY_PATH constant is correct
# ---------------------------------------------------------------------------

def test_local_key_path_constant_correct():
    assert _gitsvc._LOCAL_KEY_PATH.parts[-3:] == (".config", "workeros", "secrets.key"), (
        f"_LOCAL_KEY_PATH should end with .config/workeros/secrets.key, got {_gitsvc._LOCAL_KEY_PATH}"
    )


# ---------------------------------------------------------------------------
# #582 — Local path used when repo_full_name is absent and key file exists
# ---------------------------------------------------------------------------

def test_get_or_create_uses_local_path_when_no_repo(tmp_path):
    key_file = tmp_path / "secrets.key"
    expected_key = os.urandom(32)
    key_file.write_bytes(expected_key)

    original_resolver = _gitsvc._secrets_key_resolver
    try:
        _gitsvc._secrets_key_resolver = None
        with patch.object(_gitsvc, "_LOCAL_KEY_PATH", key_file):
            result = _main._get_or_create_secrets_key(pat="", repo_full_name="")
        assert result == expected_key, "Should return the key bytes from the local file"
    finally:
        _gitsvc._secrets_key_resolver = original_resolver


# ---------------------------------------------------------------------------
# #582 — Generates and writes key when file is absent
# ---------------------------------------------------------------------------

def test_get_or_create_generates_local_key_when_missing(tmp_path):
    key_file = tmp_path / "subdir" / "secrets.key"
    assert not key_file.exists()

    original_resolver = _gitsvc._secrets_key_resolver
    try:
        _gitsvc._secrets_key_resolver = None
        with patch.object(_gitsvc, "_LOCAL_KEY_PATH", key_file):
            result = _main._get_or_create_secrets_key(pat="", repo_full_name="")
        assert key_file.exists(), "Key file must be created when absent"
        assert len(result) == 32, "Generated key must be 32 bytes"
        assert key_file.read_bytes() == result, "Written key must match returned key"
        if os.name != "nt":
            mode = oct(key_file.stat().st_mode & 0o777)
            assert mode == oct(0o600), f"Key file must be mode 600, got {mode}"
    finally:
        _gitsvc._secrets_key_resolver = original_resolver


# ---------------------------------------------------------------------------
# #582 — Cloud resolver short-circuits before local path
# ---------------------------------------------------------------------------

def test_local_key_path_not_reached_when_resolver_set(tmp_path):
    cloud_key = os.urandom(32)
    mock_resolver = MagicMock(return_value=cloud_key)

    key_file = tmp_path / "secrets.key"
    key_file.write_bytes(os.urandom(32))  # different key on disk

    original_resolver = _gitsvc._secrets_key_resolver
    try:
        _gitsvc._secrets_key_resolver = mock_resolver
        with patch.object(_gitsvc, "_LOCAL_KEY_PATH", key_file):
            result = _main._get_or_create_secrets_key(pat="", repo_full_name="")
        assert result == cloud_key, "Cloud resolver must take precedence over local file"
        mock_resolver.assert_called_once()
    finally:
        _gitsvc._secrets_key_resolver = original_resolver


# ---------------------------------------------------------------------------
# #582 — GitHub path still used when repo_full_name is present
# ---------------------------------------------------------------------------

def test_github_path_used_when_repo_present(tmp_path):
    github_key = os.urandom(32)
    mock_gh = MagicMock()
    mock_gh.get_secrets_key.return_value = github_key

    original_resolver = _gitsvc._secrets_key_resolver
    import sys
    original_gh_module = sys.modules.get("github_api")
    try:
        _gitsvc._secrets_key_resolver = None
        sys.modules["github_api"] = mock_gh
        result = _main._get_or_create_secrets_key(
            pat="ghp_fake", repo_full_name="org/repo"
        )
        assert result == github_key, "GitHub repo variable path must be used when repo_full_name is set"
        mock_gh.get_secrets_key.assert_called_once_with("ghp_fake", "org/repo")
    finally:
        _gitsvc._secrets_key_resolver = original_resolver
        if original_gh_module is not None:
            sys.modules["github_api"] = original_gh_module
        else:
            sys.modules.pop("github_api", None)
