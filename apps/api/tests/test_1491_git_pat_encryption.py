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
