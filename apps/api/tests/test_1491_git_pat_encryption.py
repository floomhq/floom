from __future__ import annotations

import importlib
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_git_workspace_pat_is_encrypted_at_rest(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_SECRET", "pat-encryption-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    for name in list(sys.modules):
        if name == "db" or name.startswith("db.") or name.startswith("services.git_service"):
            sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    git_service = importlib.import_module("services.git_service")

    git_service._git_cfg_upsert(
        "alice",
        github_pat="ghp_plaintext_secret",
        github_username="alice",
        connected_at="2026-06-18T00:00:00Z",
    )

    with db.get_db() as conn:
        row = conn.execute(
            "SELECT github_pat FROM git_workspace_config WHERE user_id = ?",
            ("alice",),
        ).fetchone()

    stored = str(row["github_pat"])
    assert stored.startswith("enc:v1:")
    assert "ghp_plaintext_secret" not in stored
    assert git_service._git_cfg_get("alice")["github_pat"] == "ghp_plaintext_secret"


def test_git_workspace_plaintext_pat_rows_are_still_readable(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_SECRET", "pat-encryption-secret")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))

    for name in list(sys.modules):
        if name == "db" or name.startswith("db.") or name.startswith("services.git_service"):
            sys.modules.pop(name, None)

    db = importlib.import_module("db")
    db.init_db()
    git_service = importlib.import_module("services.git_service")

    with db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO git_workspace_config (user_id, github_pat, github_username, connected_at)
            VALUES (?, ?, ?, ?)
            """,
            ("alice", "ghp_legacy_plaintext", "alice", "2026-06-18T00:00:00Z"),
        )

    assert git_service._git_cfg_get("alice")["github_pat"] == "ghp_legacy_plaintext"


def test_github_token_auth_uses_askpass_not_tokenized_url(monkeypatch, tmp_path):
    git_ops = importlib.import_module("git_ops")
    calls: list[tuple[list[str], dict[str, str] | None]] = []

    def fake_git(args, cwd, check=True, timeout=30, env=None):
        calls.append((args, env))

        class Result:
            returncode = 0
            stderr = ""
            stdout = ""

        return Result()

    monkeypatch.setattr(git_ops, "_git", fake_git)

    git_ops.configure_remote(tmp_path, "https://github.com/floomhq/workeros.git")
    git_ops.push_with_github_token(tmp_path, "ghp_plaintext_secret")

    flattened_args = " ".join(" ".join(args) for args, _env in calls)
    assert "ghp_plaintext_secret" not in flattened_args
    assert "x-access-token:ghp_plaintext_secret" not in flattened_args
    assert calls[-1][0] == ["push", "-u", "origin", "HEAD"]
    assert calls[-1][1]["WORKEROS_GIT_ASKPASS_PASSWORD"] == "ghp_plaintext_secret"
