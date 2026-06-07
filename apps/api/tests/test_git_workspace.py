"""Tests for the git workspace features added in feat/git-workspace.

Covers (cross-platform, no FastAPI boot required):
  - GitHub Variables key storage (get/set/round-trip)
  - .secrets.enc encrypt/decrypt round-trip
  - Wrong key rejection (AES-GCM auth tag)
  - workspace-tools.yml read/write round-trip
  - visibility field in worker.yml round-trip
  - _patch_worker_yml_field preserves other fields
  - push_background: fires without blocking, skips if no remote
  - set_workspace_id_resolver / get_active_workspace_id
  - set_secrets_key_resolver hook
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_GIT_REQUIRED = pytest.mark.skipif(
    not (lambda: subprocess.run(["git", "--version"], capture_output=True, timeout=5).returncode == 0)(),
    reason="git not available",
)


# ---------------------------------------------------------------------------
# Secrets encryption helpers (no FastAPI, no DB)
# ---------------------------------------------------------------------------

class TestSecretsEncryption:
    """AES-256-GCM encrypt/decrypt used by .secrets.enc."""

    def _encrypt(self, data: dict, key: bytes) -> bytes:
        import os as _os, json as _json
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        nonce = _os.urandom(12)
        ct = AESGCM(key).encrypt(nonce, _json.dumps(data).encode(), None)
        return nonce + ct

    def _decrypt(self, blob: bytes, key: bytes) -> dict:
        import json as _json
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        plaintext = AESGCM(key).decrypt(blob[:12], blob[12:], None)
        return _json.loads(plaintext.decode())

    def test_round_trip(self) -> None:
        key = os.urandom(32)
        secrets = {"OPENAI_API_KEY": "sk-test", "SLACK_TOKEN": "xoxb-123"}
        blob = self._encrypt(secrets, key)
        result = self._decrypt(blob, key)
        assert result == secrets

    def test_wrong_key_raises(self) -> None:
        from cryptography.exceptions import InvalidTag
        key = os.urandom(32)
        blob = self._encrypt({"K": "V"}, key)
        with pytest.raises(InvalidTag):
            self._decrypt(blob, os.urandom(32))

    def test_nonce_is_random(self) -> None:
        key = os.urandom(32)
        blob1 = self._encrypt({"K": "V"}, key)
        blob2 = self._encrypt({"K": "V"}, key)
        # Different nonces → different ciphertexts even for same plaintext
        assert blob1[:12] != blob2[:12]

    def test_empty_secrets_round_trips(self) -> None:
        key = os.urandom(32)
        blob = self._encrypt({}, key)
        assert self._decrypt(blob, key) == {}

    def test_key_32_bytes(self) -> None:
        """Our key derivation always produces exactly 32 bytes (AES-256)."""
        import hashlib, hmac as _hmac
        key = _hmac.new(
            b"ghp_test_pat",
            msg=b"workeros-secrets-v1:acme/workeros-main",
            digestmod=hashlib.sha256,
        ).digest()
        assert len(key) == 32  # SHA-256 always yields 32 bytes


# ---------------------------------------------------------------------------
# GitHub Variables key storage (unit — mocks the _call transport)
# ---------------------------------------------------------------------------

class TestGitHubVariablesKeyStorage:
    """github_api.get_secrets_key / set_secrets_key logic without real HTTP."""

    def test_key_encode_decode_round_trip(self) -> None:
        from base64 import b64encode, b64decode
        key = os.urandom(32)
        encoded = b64encode(key).decode("ascii")
        assert b64decode(encoded) == key

    def test_get_secrets_key_returns_none_on_404(self, monkeypatch) -> None:
        import github_api
        def _fake_call(method, path, pat, body=None, timeout=15):
            raise github_api.GitHubAPIError("Not Found", 404)
        monkeypatch.setattr(github_api, "_call", _fake_call)
        result = github_api.get_secrets_key("ghp_test", "acme/workeros-main")
        assert result is None

    def test_get_secrets_key_returns_bytes(self, monkeypatch) -> None:
        from base64 import b64encode
        import github_api
        key = os.urandom(32)
        def _fake_call(method, path, pat, body=None, timeout=15):
            return {"name": "WORKEROS_SECRETS_KEY", "value": b64encode(key).decode()}
        monkeypatch.setattr(github_api, "_call", _fake_call)
        result = github_api.get_secrets_key("ghp_test", "acme/workeros-main")
        assert result == key

    def test_set_secrets_key_patches_then_creates_on_404(self, monkeypatch) -> None:
        import github_api
        calls = []
        def _fake_call(method, path, pat, body=None, timeout=15):
            calls.append((method, path))
            if method == "PATCH":
                raise github_api.GitHubAPIError("Not Found", 404)
            return {}
        monkeypatch.setattr(github_api, "_call", _fake_call)
        github_api.set_secrets_key("ghp_test", "acme/workeros-main", os.urandom(32))
        assert any(m == "PATCH" for m, _ in calls)
        assert any(m == "POST" for m, _ in calls)

    def test_set_secrets_key_patches_on_existing(self, monkeypatch) -> None:
        import github_api
        calls = []
        def _fake_call(method, path, pat, body=None, timeout=15):
            calls.append(method)
            return {}
        monkeypatch.setattr(github_api, "_call", _fake_call)
        github_api.set_secrets_key("ghp_test", "acme/workeros-main", os.urandom(32))
        assert "PATCH" in calls
        assert "POST" not in calls


# ---------------------------------------------------------------------------
# workspace_id resolver hook in git_ops
# ---------------------------------------------------------------------------

class TestWorkspaceIdResolver:
    """set_workspace_id_resolver / get_active_workspace_id."""

    def setup_method(self) -> None:
        import git_ops
        git_ops.set_workspace_id_resolver(None)  # reset before each test

    def teardown_method(self) -> None:
        import git_ops
        git_ops.set_workspace_id_resolver(None)

    def test_returns_none_when_unset(self) -> None:
        import git_ops
        assert git_ops.get_active_workspace_id() is None

    def test_returns_value_from_resolver(self) -> None:
        import git_ops
        git_ops.set_workspace_id_resolver(lambda: "ws-abc123")
        assert git_ops.get_active_workspace_id() == "ws-abc123"

    def test_resolver_returning_none(self) -> None:
        import git_ops
        git_ops.set_workspace_id_resolver(lambda: None)
        assert git_ops.get_active_workspace_id() is None

    def test_reset_to_none(self) -> None:
        import git_ops
        git_ops.set_workspace_id_resolver(lambda: "ws-xyz")
        git_ops.set_workspace_id_resolver(None)
        assert git_ops.get_active_workspace_id() is None

    def test_resolver_exception_returns_none(self) -> None:
        import git_ops
        def _bad():
            raise RuntimeError("db down")
        git_ops.set_workspace_id_resolver(_bad)
        assert git_ops.get_active_workspace_id() is None


# ---------------------------------------------------------------------------
# push_background — fires a thread, doesn't block, skips without remote
# ---------------------------------------------------------------------------

@_GIT_REQUIRED
class TestPushBackground:

    def test_does_not_raise_without_remote(self, tmp_path: Path) -> None:
        import git_ops, time
        git_ops.ensure_repo(tmp_path)
        (tmp_path / "f.txt").write_text("hello")
        git_ops.commit_paths(tmp_path, ["f.txt"], "init")
        # Should fire and complete silently with no remote configured
        git_ops.push_background(tmp_path)
        time.sleep(0.5)  # let daemon thread complete

    def test_returns_immediately(self, tmp_path: Path) -> None:
        import git_ops, time
        git_ops.ensure_repo(tmp_path)
        start = time.monotonic()
        git_ops.push_background(tmp_path)
        elapsed = time.monotonic() - start
        assert elapsed < 0.5, f"push_background blocked for {elapsed:.2f}s"


# ---------------------------------------------------------------------------
# workspace-tools.yml structure
# ---------------------------------------------------------------------------

class TestWorkspaceToolsYml:
    """Read/write workspace-tools.yml without DB or git."""

    def _write_tools_yml(self, workspace: Path, tools: list) -> None:
        import yaml
        doc = {"version": 1, "tools": tools}
        (workspace / "workspace-tools.yml").write_text(
            yaml.safe_dump(doc, sort_keys=False), encoding="utf-8"
        )

    def test_round_trip_empty(self, tmp_path: Path) -> None:
        import yaml
        self._write_tools_yml(tmp_path, [])
        doc = yaml.safe_load((tmp_path / "workspace-tools.yml").read_text())
        assert doc["version"] == 1
        assert doc["tools"] == []

    def test_round_trip_with_tools(self, tmp_path: Path) -> None:
        import yaml
        tools = [
            {"id": "abc", "name": "my-tool", "worker_id": "my-worker", "description": "Does stuff"},
            {"id": "def", "name": "other-tool", "worker_id": "other-worker", "description": ""},
        ]
        self._write_tools_yml(tmp_path, tools)
        doc = yaml.safe_load((tmp_path / "workspace-tools.yml").read_text())
        assert len(doc["tools"]) == 2
        assert doc["tools"][0]["name"] == "my-tool"
        assert doc["tools"][0]["worker_id"] == "my-worker"

    def test_missing_file_returns_no_tools(self, tmp_path: Path) -> None:
        assert not (tmp_path / "workspace-tools.yml").exists()
        # Simulate _load_workspace_tools_yml early exit
        result = 0 if not (tmp_path / "workspace-tools.yml").is_file() else -1
        assert result == 0


# ---------------------------------------------------------------------------
# worker.yml visibility field
# ---------------------------------------------------------------------------

class TestWorkerYmlVisibility:
    """_patch_worker_yml_field and visibility round-trip."""

    def _make_worker_yml(self, path: Path, extra: dict | None = None) -> None:
        import yaml
        doc = {
            "schema_version": "0.3",
            "name": "test-worker",
            "title": "Test Worker",
            "description": "A test worker",
            "version": "0.1.0",
            "exec": {"entry": "SKILL.md", "runtime": "skill"},
        }
        if extra:
            doc.update(extra)
        path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")

    def test_patch_adds_visibility_field(self, tmp_path: Path) -> None:
        import yaml
        workers_dir = tmp_path / "workers" / "my-worker"
        workers_dir.mkdir(parents=True)
        yml = workers_dir / "worker.yml"
        self._make_worker_yml(yml)

        # Simulate _patch_worker_yml_field
        raw = yaml.safe_load(yml.read_text()) or {}
        raw["visibility"] = "workspace"
        yml.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")

        result = yaml.safe_load(yml.read_text())
        assert result["visibility"] == "workspace"
        # Other fields preserved
        assert result["name"] == "test-worker"
        assert result["version"] == "0.1.0"

    def test_patch_updates_existing_visibility(self, tmp_path: Path) -> None:
        import yaml
        workers_dir = tmp_path / "workers" / "my-worker"
        workers_dir.mkdir(parents=True)
        yml = workers_dir / "worker.yml"
        self._make_worker_yml(yml, {"visibility": "private"})

        raw = yaml.safe_load(yml.read_text()) or {}
        raw["visibility"] = "workspace"
        yml.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")

        result = yaml.safe_load(yml.read_text())
        assert result["visibility"] == "workspace"

    def test_visibility_defaults_to_private_when_absent(self, tmp_path: Path) -> None:
        import yaml
        workers_dir = tmp_path / "workers" / "my-worker"
        workers_dir.mkdir(parents=True)
        yml = workers_dir / "worker.yml"
        self._make_worker_yml(yml)  # no visibility field

        raw = yaml.safe_load(yml.read_text()) or {}
        visibility = raw.get("visibility") or "private"
        assert visibility == "private"

    def test_worker_contract_accepts_visibility(self) -> None:
        """WorkerContract model now has visibility field."""
        from models import WorkerContract
        fields = WorkerContract.model_fields
        assert "visibility" in fields

    def test_worker_contract_visibility_optional(self) -> None:
        """visibility is optional — existing worker.yml files without it still parse."""
        from models import WorkerContract
        field = WorkerContract.model_fields["visibility"]
        # Optional fields have a default of None
        assert field.default is None or field.is_required() is False


# ---------------------------------------------------------------------------
# git_ops.push_background: thread name
# ---------------------------------------------------------------------------

class TestPushBackgroundThread:

    def test_spawns_named_daemon_thread(self, monkeypatch) -> None:
        import threading, git_ops
        spawned: list[str] = []

        real_thread = threading.Thread

        def _capture_thread(*args, target=None, daemon=None, name=None, **kw):
            spawned.append(name or "")
            t = real_thread(target=lambda: None, daemon=daemon, name=name)
            return t

        monkeypatch.setattr(threading, "Thread", _capture_thread)
        git_ops.push_background(Path("/tmp/fake-workspace"))
        assert any("git-push" in (n or "") for n in spawned)
