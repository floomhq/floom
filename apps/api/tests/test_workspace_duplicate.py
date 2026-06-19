"""Workspace duplicate (Notion-template style) — export + import round-trip.

A workspace = the operator's WORKERS + KNOWLEDGE PACKS (contexts) + the
workspace-agent config (workspace.md). GET /workspace/export bundles all of it
into a single .zip TEMPLATE; POST /workspace/import unpacks one into another
workspace.

These tests pin the load-bearing guarantees:
  * export EXCLUDES example/stock workers and system context packs,
  * export NEVER carries a secret VALUE (only required-secret NAMES in the
    manifest), even if a .env was dropped into a worker/pack dir,
  * import registers each worker (id-deduped, never clobbering an existing one)
    and creates each knowledge pack,
  * re-import dedups instead of clobbering,
  * zip path traversal is rejected.
"""

from __future__ import annotations

import importlib
import io
import sys
import zipfile
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


_OPERATOR_WORKER_YML = """\
schema_version: '0.3'
name: my-authored-worker
title: My Authored Worker
description: An operator-authored worker.
version: 0.1.0
targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
  secrets:
  - OPENAI_API_KEY
capabilities:
  secrets:
  - OPENAI_API_KEY
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
trigger:
  type: manual
"""

_EXAMPLE_WORKER_YML = """\
schema_version: '0.3'
is_example: true
name: example-stock
title: Example Stock
description: A shipped example worker that must NOT be exported.
version: 0.1.0
targets:
- generic
exec:
  entry: run.py
  runtime: python311
  runner: e2b
  command: python run.py
inputs:
- name: x
  kind: scalar
  type: string
  required: true
  label: X
outputs:
- name: y
  kind: scalar
  type: string
  required: true
  label: Y
trigger:
  type: manual
"""

_SECRET_VALUE = "topsecretvalue-DO-NOT-LEAK-12345"


def _build_workspace(tmp_path: Path) -> tuple[Path, Path]:
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    contexts_dir = tmp_path / "contexts"
    contexts_dir.mkdir()

    # Operator-authored worker (exportable) + a stray .env that must NOT leak.
    ow = workers_dir / "my-authored-worker"
    ow.mkdir()
    (ow / "worker.yml").write_text(_OPERATOR_WORKER_YML, encoding="utf-8")
    (ow / "run.py").write_text("print('hi')\n", encoding="utf-8")
    (ow / "requirements.txt").write_text("", encoding="utf-8")
    (ow / ".env").write_text(f"FLOOM_SECRET={_SECRET_VALUE}\n", encoding="utf-8")

    # Example worker (must be excluded from the template).
    ex = workers_dir / "example-stock"
    ex.mkdir()
    (ex / "worker.yml").write_text(_EXAMPLE_WORKER_YML, encoding="utf-8")
    (ex / "run.py").write_text("print('example')\n", encoding="utf-8")
    (ex / "requirements.txt").write_text("", encoding="utf-8")

    # Operator knowledge pack (exportable).
    op = contexts_dir / "my-knowledge-pack"
    op.mkdir()
    (op / "README.md").write_text("# My Knowledge\nfacts.\n", encoding="utf-8")
    (op / "facts.md").write_text("company facts here\n", encoding="utf-8")

    # System pack (must be excluded).
    sp = contexts_dir / "worker-author-style"
    sp.mkdir()
    (sp / "STYLE.md").write_text("engine style guide\n", encoding="utf-8")

    return workers_dir, contexts_dir


@pytest.fixture
def client_and_main(monkeypatch, tmp_path):
    workers_dir, contexts_dir = _build_workspace(tmp_path)

    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-wsdup")
    monkeypatch.setenv("WORKEROS_SHARED_SECRET_ROLE", "admin")
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(contexts_dir))
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_ENABLE_USER_HEADER_SCOPE", "0")

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "chat_service",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    import types
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )

    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")

    main.invalidate_worker_cache()
    workers = main.discover_workers()
    with main.get_db() as conn:
        main._persist_discovered_workers(conn, workers, user_id="local-user")

    from fastapi.testclient import TestClient
    with TestClient(main.app, headers={"x-floom-secret": "test-secret-wsdup"}) as client:
        yield client, main
    db.get_repositories.cache_clear()


def _export_zip(client) -> zipfile.ZipFile:
    resp = client.get("/workspace/export")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/zip"
    assert "attachment" in resp.headers.get("content-disposition", "")
    return zipfile.ZipFile(io.BytesIO(resp.content))


def test_export_excludes_examples_and_system_packs(client_and_main):
    client, _main = client_and_main
    zf = _export_zip(client)
    names = zf.namelist()

    # Operator worker + pack present.
    assert any(n.startswith("workers/my-authored-worker/") for n in names)
    assert "workers/my-authored-worker/worker.yml" in names
    assert any(n.startswith("contexts/my-knowledge-pack/") for n in names)

    # Example worker EXCLUDED.
    assert not any(n.startswith("workers/example-stock/") for n in names)
    # System context pack EXCLUDED.
    assert not any(n.startswith("contexts/worker-author-style/") for n in names)

    # Manifest sanity.
    manifest = __import__("json").loads(zf.read("workspace.json"))
    assert manifest["schema_version"] == 1
    assert manifest["counts"]["workers"] == 1
    assert manifest["counts"]["contexts"] >= 1
    worker_ids = [w["id"] for w in manifest["workers"]]
    assert worker_ids == ["my-authored-worker"]
    # Required secret NAMES are surfaced (so the importer can reconnect).
    assert "OPENAI_API_KEY" in manifest["required_secrets"]


def test_export_carries_no_secret_value(client_and_main):
    client, _main = client_and_main
    zf = _export_zip(client)
    names = zf.namelist()

    # The .env was dropped into the worker dir; it must NOT be in the template.
    assert not any(n.endswith(".env") for n in names)

    # Grep the WHOLE zip for the secret value / FLOOM_SECRET literal.
    blob = b"".join(zf.read(n) for n in names)
    assert _SECRET_VALUE.encode() not in blob
    assert b"FLOOM_SECRET" not in blob


def test_import_round_trip_into_fresh_workspace(client_and_main, monkeypatch, tmp_path):
    client, _main = client_and_main
    export = client.get("/workspace/export")
    assert export.status_code == 200
    template = export.content

    # Build a SECOND, empty workspace and import the template there.
    fresh = tmp_path / "fresh"
    (fresh / "workers").mkdir(parents=True)
    (fresh / "contexts").mkdir(parents=True)

    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(fresh / "workers"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(fresh / "contexts"))
    monkeypatch.setenv("WORKEROS_DB", str(fresh / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(fresh / "floom.db"))

    for name in [
        "main", "db", "db._legacy_sqlite", "db.sqlite", "db.factory",
        "db.dependency", "db.interface", "models", "files", "worker_registry",
        "runner_utils", "run_service", "webhook_service", "composio_client",
        "scheduler", "auth", "auth.context", "auth.dependency", "auth.factory",
        "auth.interface", "auth.local", "contexts", "chat_service",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)
    import types
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None, stop_scheduler=lambda: None,
    )
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main2 = importlib.import_module("main")

    from fastapi.testclient import TestClient
    with TestClient(main2.app, headers={"x-floom-secret": "test-secret-wsdup"}) as client2:
        assert client2.get("/workers").json() == []

        resp = client2.post(
            "/workspace/import",
            files={"bundle": ("template.zip", template, "application/zip")},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["workers_imported"] == ["my-authored-worker"]
        assert body["contexts_imported"] == ["my-knowledge-pack"]
        assert body["skipped"] == []
        assert "OPENAI_API_KEY" in body["required_secrets"]

        # Imported worker appears + is on disk (no .env).
        worker_ids = [w["id"] for w in client2.get("/workers").json()]
        assert "my-authored-worker" in worker_ids
        wdir = fresh / "workers" / "my-authored-worker"
        assert (wdir / "worker.yml").is_file()
        assert (wdir / "run.py").is_file()
        assert not (wdir / ".env").exists()

        # Pack appears.
        ctx_names = [c["name"] for c in client2.get("/contexts").json()]
        assert "my-knowledge-pack" in ctx_names

        # RE-IMPORT dedups (worker remapped, pack skipped) — no clobber.
        resp2 = client2.post(
            "/workspace/import",
            files={"bundle": ("template.zip", template, "application/zip")},
        )
        assert resp2.status_code == 200, resp2.text
        body2 = resp2.json()
        assert body2["workers_imported"] == ["my-authored-worker-2"]
        assert body2["id_remaps"] == {"my-authored-worker": "my-authored-worker-2"}
        assert any(
            s.get("type") == "context" and s.get("reason") == "already exists"
            for s in body2["skipped"]
        )
        # Original pack content unchanged (not clobbered).
        facts = client2.get("/contexts/my-knowledge-pack/files/facts.md")
        assert facts.status_code == 200
        assert "company facts here" in facts.text

    db.get_repositories.cache_clear()


def test_import_rejects_zip_traversal(client_and_main):
    client, _main = client_and_main
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "workers/../../../etc/evil/worker.yml",
            "schema_version: '0.3'\nname: evil\n",
        )
    resp = client.post(
        "/workspace/import",
        files={"bundle": ("evil.zip", buf.getvalue(), "application/zip")},
    )
    assert resp.status_code == 400, resp.text
    assert "Unsafe path" in resp.json()["detail"]


def test_import_skips_worker_without_worker_yml(client_and_main):
    client, _main = client_and_main
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("workers/broken/run.py", "print('no manifest')\n")
    resp = client.post(
        "/workspace/import",
        files={"bundle": ("broken.zip", buf.getvalue(), "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["workers_imported"] == []
    assert any(
        s.get("type") == "worker" and "missing worker.yml" in s.get("reason", "")
        for s in body["skipped"]
    )


# ---------------------------------------------------------------------------
# W9b: Duplicate workspace + Share template link.
# ---------------------------------------------------------------------------


def _active_workspace_id(client) -> str:
    resp = client.get("/workspaces")
    assert resp.status_code == 200, resp.text
    return resp.json()["active_id"]


def test_duplicate_workspace_creates_named_copy(client_and_main):
    client, _main = client_and_main

    # Name the active (default) workspace so we can assert the "(copy)" suffix.
    create = client.post("/workspaces", json={"name": "Acme Ops"})
    assert create.status_code == 200, create.text
    source_id = create.json()["id"]
    client.post(f"/workspaces/{source_id}/select")

    before = {w["id"] for w in client.get("/workspaces").json()["workspaces"]}

    resp = client.post(f"/workspaces/{source_id}/duplicate")
    assert resp.status_code == 200, resp.text
    dup = resp.json()
    assert dup["name"] == "Acme Ops (copy)"
    assert dup["id"] not in before  # genuinely a new workspace row

    after = {w["id"] for w in client.get("/workspaces").json()["workspaces"]}
    assert dup["id"] in after
    assert len(after) == len(before) + 1


def test_duplicate_unknown_workspace_404s(client_and_main):
    client, _main = client_and_main
    resp = client.post("/workspaces/ws_does_not_exist/duplicate")
    assert resp.status_code == 404, resp.text


def test_share_link_round_trips_to_the_same_template(client_and_main):
    client, _main = client_and_main

    link = client.get("/workspace/share-link")
    assert link.status_code == 200, link.text
    body = link.json()
    token = body["token"]
    assert token and len(token) >= 16
    # The signed URL embeds the same token + the owner param.
    assert f"/workspace/template/{token}" in body["url"]
    assert "owner=" in body["url"]

    # Pull the owner param straight off the minted URL and download via the
    # public (login-free) share endpoint.
    from urllib.parse import urlparse, parse_qs

    owner = parse_qs(urlparse(body["url"]).query)["owner"][0]
    pub = client.get(f"/workspace/template/{token}", params={"owner": owner})
    assert pub.status_code == 200, pub.text
    assert pub.headers["content-type"] == "application/zip"

    # Byte-for-byte identical to the authenticated export AND secret-free.
    shared = zipfile.ZipFile(io.BytesIO(pub.content))
    direct = _export_zip(client)
    assert set(shared.namelist()) == set(direct.namelist())
    blob = b"".join(shared.read(n) for n in shared.namelist())
    assert _SECRET_VALUE.encode() not in blob
    assert not any(n.endswith(".env") for n in shared.namelist())


def test_share_link_rejects_forged_token(client_and_main):
    client, _main = client_and_main
    owner = _active_workspace_id(client)
    resp = client.get(
        "/workspace/template/deadbeefdeadbeefdeadbeef",
        params={"owner": owner},
    )
    assert resp.status_code == 401, resp.text
