"""Emily worker listing honors the legacy default local owner scope.

Run:
    cd apps/api && python -m pytest tests/test_emily_worker_legacy_scope.py -q
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _reset_modules() -> None:
    for name in list(sys.modules):
        if name in ("chat_service", "main", "contexts") or name == "db" or name.startswith("db."):
            sys.modules.pop(name, None)


def _configure_env(monkeypatch, *, db_path: Path, contexts_dir: Path) -> None:
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    monkeypatch.setenv("WORKEROS_USER_ID", "federico")
    monkeypatch.setenv("WORKEROS_DB", str(db_path))
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))


def _manifest(worker_id: str, *, system_worker: bool = False) -> dict:
    payload = {
        "id": worker_id,
        "name": worker_id,
        "title": worker_id,
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "local"},
        "inputs": [],
        "outputs": [],
        "secrets": [],
        "connections": [],
    }
    if system_worker:
        payload["system_worker"] = True
    return payload


def _seed_db(db, session_user_id: str) -> None:
    now = db.now_iso()
    with db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO users
                (id, username, password_hash, role, disabled, created_at, updated_at)
            VALUES (?, 'fede', 'test-hash', 'member', 0, ?, ?)
            """,
            (session_user_id, now, now),
        )
        conn.execute(
            """
            INSERT INTO workspace_members
                (workspace_id, user_id, role, status, created_at, updated_at)
            VALUES ('local-default', ?, 'owner', 'active', ?, ?)
            """,
            (session_user_id, now, now),
        )
    repos = db.get_repositories()
    for worker_id, owner_id, manifest in (
        ("legacy-real", "federico", _manifest("legacy-real")),
        ("legacy-system", "federico", _manifest("legacy-system", system_worker=True)),
        ("other-private", "other-user", _manifest("other-private")),
    ):
        repos.workers.create(
            user_id=owner_id,
            worker_id=worker_id,
            name=worker_id,
            manifest_json=json.dumps(manifest),
            bundle_path=f"workers/{worker_id}",
            workspace_id="local-default",
            visibility="private",
        )


def _load_chat_service():
    import chat_service

    return chat_service


def test_emily_worker_list_resolves_uuid_session_to_legacy_default_owner(tmp_path, monkeypatch):
    session_user_id = "9d3dc98d-58a0-4b64-9b39-5bb1c2d27e0a"
    db_path = tmp_path / "workeros.db"
    contexts_dir = tmp_path / "contexts"
    legacy_pack = contexts_dir / "federico" / "company"
    legacy_pack.mkdir(parents=True)
    (legacy_pack / "README.md").write_text("# Company\n", encoding="utf-8")
    _configure_env(monkeypatch, db_path=db_path, contexts_dir=contexts_dir)
    _reset_modules()

    import db

    db.init_db()
    db.get_repositories.cache_clear()
    _seed_db(db, session_user_id)
    chat_service = _load_chat_service()

    result = chat_service._tool_workers_list_all({}, session_user_id)

    assert result["count"] == 1
    assert {worker["id"] for worker in result["workers"]} == {"legacy-real"}
    assert result["hidden_system_count"] == 1

    include_system = chat_service._tool_workers_list_all({"include_system": True}, session_user_id)
    assert {worker["id"] for worker in include_system["workers"]} == {
        "legacy-real",
        "legacy-system",
    }
    assert "other-private" not in {worker["id"] for worker in include_system["workers"]}
