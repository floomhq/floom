"""Tests for the backend batch:

  C-B9       read-only presets fill allowed_tools + denied attempt is logged
  C-BINREST  per-file binary restore endpoint (base64 round-trip, owner-scope,
             bad token rejected)
  C-WBACK    agent-mode writeback persists a writeable-context edit
  C-DEADCODE the dead LOCAL_ENV_PATH constant is gone and imports still work
"""

from __future__ import annotations

import base64
import importlib
import logging
import platform
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

_LINUX_ONLY = pytest.mark.skipif(
    platform.system() == "Windows",
    reason="SQLite db layer uses fcntl (Linux only); runs in CI on ubuntu-latest",
)


# ---------------------------------------------------------------------------
# C-B9 part 1: read-only presets (pure helper, no app boot needed)
# ---------------------------------------------------------------------------

def test_read_only_preset_fills_read_subset():
    import models

    gmail = models.read_only_preset_for_app("gmail")
    assert gmail is not None
    assert "GMAIL_FETCH_EMAILS" in gmail
    assert "GMAIL_LIST_LABELS" in gmail
    # Read-only must never contain a write/send tool.
    assert not any(
        any(tool.startswith(f"GMAIL_{p}") for p in ("SEND", "CREATE", "DELETE", "MODIFY", "TRASH"))
        for tool in gmail
    )
    # Every preset tool passes the read_only scope enforcement (defence in depth).
    for tool in gmail:
        assert models.composio_tool_allowed_by_scope("gmail", tool, ["read_only"])


def test_read_only_preset_aliases_and_missing():
    import models

    assert models.read_only_preset_for_app("calendar") == models.read_only_preset_for_app("googlecalendar")
    assert models.read_only_preset_for_app("google_calendar") is not None
    # Apps with no curated preset return None (UI falls back to read_only scope).
    assert models.read_only_preset_for_app("apollo") is None


@_LINUX_ONLY
def test_tool_presets_endpoint(monkeypatch, tmp_path):
    _, main = _load_app(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)
    headers = {"x-floom-secret": "test-secret"}

    # Single-app form.
    r = client.get("/connections/tool-presets?app=gmail", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["app"] == "gmail"
    assert "GMAIL_FETCH_EMAILS" in body["tools"]

    # Missing-preset app returns tools: null.
    r2 = client.get("/connections/tool-presets?app=apollo", headers=headers)
    assert r2.status_code == 200
    assert r2.json()["tools"] is None

    # All-presets form.
    r3 = client.get("/connections/tool-presets", headers=headers)
    assert r3.status_code == 200
    presets = r3.json()["presets"]
    assert "gmail" in presets and "slack" in presets and "github" in presets

    # Auth required.
    assert client.get("/connections/tool-presets").status_code == 401


# ---------------------------------------------------------------------------
# C-B9 part 2: denied attempt is logged at the proxy enforcement point
# ---------------------------------------------------------------------------

@_LINUX_ONLY
def test_denied_tool_attempt_is_logged(monkeypatch, tmp_path, caplog):
    db, main = _load_app(monkeypatch, tmp_path)
    repos = db.get_repositories()
    manifest = {
        "id": "gmail-allow",
        "name": "Gmail Allow",
        "trigger": {"type": "manual"},
        "runtime": {"type": "python", "entrypoint": "run.py", "runner": "e2b"},
        "connections": [{"app": "gmail", "allowed_tools": ["GMAIL_FETCH_EMAILS"]}],
    }
    repos.workers.create(
        user_id="owner-a", worker_id="gmail-allow", name="Gmail Allow",
        manifest_json=manifest, bundle_path="workers/gmail-allow",
    )
    repos.runs.create(
        user_id="owner-a", run_id="run-allow", worker_id="gmail-allow",
        status="running", trigger_source="manual", runner="e2b",
    )
    repos.connections.upsert(
        user_id="owner-a", id="conn", app_name="gmail",
        composio_connection_id="ca_gmail", status="active",
    )

    client = TestClient(main.app, raise_server_exceptions=False)
    with caplog.at_level(logging.WARNING, logger="floom.api"):
        resp = client.post(
            "/runs/run-allow/composio-execute/GMAIL_SEND_EMAIL",
            headers=_run_headers("run-allow"),
            json={"connected_account_id": "ca_gmail", "arguments": {}},
        )
    assert resp.status_code == 403
    assert "is not allowed" in resp.json()["detail"]
    # The denied attempt is auditable: worker id + tool + "blocked by allowlist".
    blocked = [r for r in caplog.records if "blocked by allowlist" in r.getMessage()]
    assert blocked, "expected a 'blocked by allowlist' log record"
    msg = blocked[0].getMessage()
    assert "gmail-allow" in msg and "GMAIL_SEND_EMAIL" in msg
    db.get_repositories.cache_clear()


# ---------------------------------------------------------------------------
# C-BINREST: per-file binary restore endpoint
# ---------------------------------------------------------------------------

@_LINUX_ONLY
def test_binary_file_restore_round_trip(monkeypatch, tmp_path):
    db, main = _load_app(monkeypatch, tmp_path, contexts_dir=tmp_path / "contexts")
    headers = {"x-floom-secret": "test-secret"}
    client = TestClient(main.app, raise_server_exceptions=False)

    # Create a pack and upload a BINARY file (a tiny PNG header — not valid UTF-8).
    assert client.post("/contexts/binpack", headers=headers).status_code in (200, 201)
    assert client.patch(
        "/contexts/binpack/sensitive",
        json={"sensitive": False},
        headers=headers,
    ).status_code == 200
    png_v1 = b"\x89PNG\r\n\x1a\n\x00\x01\x02\xff\xfe\xfd"
    r = client.put(
        "/contexts/binpack/files/logo.png",
        content=png_v1,
        headers={**headers, "content-type": "application/octet-stream"},
    )
    assert r.status_code == 200, r.text

    # Overwrite with a different binary blob (creates a 2nd version).
    png_v2 = b"\x89PNG\r\n\x1a\n\xaa\xbb\xcc\xdd\xee"
    r2 = client.put(
        "/contexts/binpack/files/logo.png",
        content=png_v2,
        headers={**headers, "content-type": "application/octet-stream"},
    )
    assert r2.status_code == 200

    versions = client.get("/contexts/binpack/files/logo.png/versions", headers=headers).json()
    assert len(versions) >= 2
    # Newest first; the older snapshot holds png_v1.
    v1_id = versions[-1]["id"]
    snap = client.get(f"/contexts/binpack/files/logo.png/versions/{v1_id}", headers=headers).json()
    assert snap["file"]["encoding"] == "base64"
    assert base64.b64decode(snap["file"]["content"]) == png_v1

    # Restore the binary version: the bytes must round-trip exactly.
    restore = client.post(
        f"/contexts/binpack/files/logo.png/restore/{v1_id}", headers=headers
    )
    assert restore.status_code == 200, restore.text
    assert restore.json()["is_binary"] is True

    fetched = client.get("/contexts/binpack/files/logo.png", headers=headers)
    assert fetched.status_code == 200
    assert fetched.content == png_v1
    db.get_repositories.cache_clear()


@_LINUX_ONLY
def test_binary_restore_bad_token_and_owner_scope(monkeypatch, tmp_path):
    db, main = _load_app(
        monkeypatch, tmp_path, contexts_dir=tmp_path / "contexts", user_header_scope=True
    )
    client = TestClient(main.app, raise_server_exceptions=False)
    owner = {"x-floom-secret": "test-secret", "x-floom-user": "alice"}
    other = {"x-floom-secret": "test-secret", "x-floom-user": "mallory"}

    client.post("/contexts/scoped", headers=owner)
    assert client.patch(
        "/contexts/scoped/sensitive",
        json={"sensitive": False},
        headers=owner,
    ).status_code == 200
    client.put(
        "/contexts/scoped/files/doc.bin",
        content=b"\x00\x01\x02alice",
        headers={**owner, "content-type": "application/octet-stream"},
    )
    versions = client.get("/contexts/scoped/files/doc.bin/versions", headers=owner).json()
    assert versions
    vid = versions[-1]["id"]

    # Bad shared secret -> 401, no restore.
    bad = client.post(
        "/contexts/scoped/files/doc.bin/restore/" + vid,
        headers={"x-floom-secret": "wrong", "x-floom-user": "alice"},
    )
    assert bad.status_code == 401

    # A different owner cannot see (or restore) alice's pack → 404.
    foreign = client.post(
        "/contexts/scoped/files/doc.bin/restore/" + vid, headers=other
    )
    assert foreign.status_code == 404

    # The real owner can restore.
    ok = client.post("/contexts/scoped/files/doc.bin/restore/" + vid, headers=owner)
    assert ok.status_code == 200, ok.text
    db.get_repositories.cache_clear()


# ---------------------------------------------------------------------------
# C-WBACK: agent-mode writeback persists a writeable-context edit
# ---------------------------------------------------------------------------

@_LINUX_ONLY
def test_agent_writeback_persists_writeable_context(monkeypatch, tmp_path):
    """The agent_driver writeback mirrors e2b: a staged edit to a writeable:true
    pack is copied back to the canonical store; a read-only pack is not."""
    contexts_dir = tmp_path / "contexts"
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")

    # agent_capabilities binds the staging/writeback context helpers (context_dir,
    # iter_context_files, …) at import; drop it too so the fresh import picks up
    # the env-driven CONTEXTS_DIR.
    for name in [
        "contexts",
        "models",
        "runner_sandbox.agent_capabilities",
        "runner_sandbox.agent_driver",
    ]:
        sys.modules.pop(name, None)
    for _n in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(_n, None)
    contexts = importlib.import_module("contexts")
    importlib.reload(contexts)
    # Reload agent_capabilities AFTER contexts so its bound context_dir /
    # iter_context_files point at the env-driven CONTEXTS_DIR, then import the
    # driver which delegates staging to it.
    agent_capabilities = importlib.import_module("runner_sandbox.agent_capabilities")
    importlib.reload(agent_capabilities)
    from runner_sandbox.agent_driver import AgentDriver

    # Seed two packs: one writeable, one read-only.
    (contexts.context_dir("notes")).mkdir(parents=True, exist_ok=True)
    (contexts.context_dir("notes") / "memo.md").write_text("v0\n", encoding="utf-8")
    (contexts.context_dir("readonly")).mkdir(parents=True, exist_ok=True)
    (contexts.context_dir("readonly") / "fixed.md").write_text("locked\n", encoding="utf-8")

    # Agent-mode config: a validated WorkerConfig pins runner=e2b, but the driver
    # methods only read ``config.contexts``, so a lightweight stand-in (matching
    # test_agent_driver_contexts) exercises the staging + writeback paths.
    class _Config:
        contexts = [
            {"name": "notes", "writeable": True},
            {"name": "readonly", "writeable": False},
        ]
        outputs = []

    config = _Config()

    driver = AgentDriver()
    logs: list = []
    log_fn = lambda msg, level="info": logs.append((level, msg))

    # Stage the packs into a per-run context root, then simulate an agent edit
    # (the agent can mutate staged files via run_command), then write back.
    context_root = (tmp_path / "artifacts" / "run1" / "context")
    context_root.mkdir(parents=True, exist_ok=True)
    driver._stage_contexts(config=config, context_root=context_root, user_id="local-user", log_fn=log_fn)

    # Edit the staged writeable pack + the staged read-only pack.
    (context_root / "notes" / "memo.md").write_text("v1-edited\n", encoding="utf-8")
    (context_root / "notes" / "new.md").write_text("brand new\n", encoding="utf-8")
    (context_root / "readonly" / "fixed.md").write_text("HACKED\n", encoding="utf-8")

    driver._persist_writeable_contexts(
        config=config, context_root=context_root, user_id="local-user", log_fn=log_fn
    )

    # Writeable pack edits persisted (edit + new file).
    assert (contexts.context_dir("notes") / "memo.md").read_text() == "v1-edited\n"
    assert (contexts.context_dir("notes") / "new.md").read_text() == "brand new\n"
    # Read-only pack untouched on disk.
    assert (contexts.context_dir("readonly") / "fixed.md").read_text() == "locked\n"


# ---------------------------------------------------------------------------
# C-DEADCODE: the unused constant is gone, imports still work
# ---------------------------------------------------------------------------

def test_local_env_path_constant_removed():
    import run_service
    importlib.reload(run_service)
    assert not hasattr(run_service, "LOCAL_ENV_PATH")
    # The constant that IS used must survive.
    assert hasattr(run_service, "API_ENV_PATH")


# ---------------------------------------------------------------------------
# Shared app loader (mirrors test_composio_proxy / test_versioning)
# ---------------------------------------------------------------------------

def _load_app(monkeypatch, tmp_path, *, contexts_dir=None, user_header_scope=False):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret")
    monkeypatch.setenv("COMPOSIO_API_KEY", "test-composio-key")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("WORKEROS_WORKSPACE_DIR", str(tmp_path))
    monkeypatch.delenv("WORKEROS_GIT_REMOTE", raising=False)
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    if contexts_dir is not None:
        monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    if user_header_scope:
        monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "1")
    (tmp_path / "workers").mkdir(exist_ok=True)

    for name in [
        "db", "db._legacy_sqlite", "db.sqlite", "db.factory", "db.dependency",
        "db.interface", "contexts", "models", "worker_registry", "runner_utils",
        "run_service", "main",
    ]:
        sys.modules.pop(name, None)
    for _n in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(_n, None)

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    return db, main


def _run_headers(run_id: str) -> dict:
    from run_token import make_run_token

    return {"X-Floom-Run-Token": make_run_token(run_id, secret="test-secret")}
