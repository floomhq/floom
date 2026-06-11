from __future__ import annotations

import importlib
import os
import sys
import types

from fastapi.testclient import TestClient


API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)


_AUTH_HEADER = {"x-floom-secret": "test-secret-r5"}


def _load_api(
    monkeypatch,
    tmp_path,
    *,
    workeros_dev: bool = False,
    upload_hourly_cap_bytes: int | None = None,
):
    workers_dir = tmp_path / "workers"
    blobs_dir = tmp_path / "blobs"
    workers_dir.mkdir()
    blobs_dir.mkdir()

    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_BLOBS_DIR", str(blobs_dir))
    monkeypatch.setenv("FLOOM_SECRET", _AUTH_HEADER["x-floom-secret"])
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("E2B_API_KEY", "e2b-test")
    monkeypatch.setenv("COMPOSIO_API_KEY", "cmp-test")
    monkeypatch.setenv("COMPOSIO_WEBHOOK_SIGNING_KEY", "whsec-test")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workers.floom.dev")
    if upload_hourly_cap_bytes is None:
        monkeypatch.delenv("WORKEROS_UPLOAD_HOURLY_CAP_BYTES", raising=False)
    else:
        monkeypatch.setenv("WORKEROS_UPLOAD_HOURLY_CAP_BYTES", str(upload_hourly_cap_bytes))
    if workeros_dev:
        monkeypatch.setenv("WORKEROS_DEV", "1")
    else:
        monkeypatch.delenv("WORKEROS_DEV", raising=False)

    for name in [
        "main",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    ]:
        sys.modules.pop(name, None)
    for name in [n for n in list(sys.modules) if n.startswith("routers")]:
        sys.modules.pop(name, None)

    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_cors_preflight_rejects_localhost_origin_in_prod(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, workeros_dev=False)
    client = TestClient(main.app)

    resp = client.options(
        "/workers",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert resp.headers.get("access-control-allow-origin") != "http://localhost:3000"


def test_cors_preflight_allows_production_frontend(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, workeros_dev=False)
    client = TestClient(main.app)

    resp = client.options(
        "/workers",
        headers={
            "Origin": "https://workers.floom.dev",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert resp.headers.get("access-control-allow-origin") == "https://workers.floom.dev"


def test_upload_accepts_text_plain_file(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/uploads",
        headers=_AUTH_HEADER,
        files={"file": ("notes.txt", b"a" * 100, "text/plain")},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["size"] == 100
    assert body["media_type"] == "text/plain"


def test_upload_accepts_widened_code_and_markup_types(monkeypatch, tmp_path):
    """html/py/ts/json/toml are now allowed (served as attachment + nosniff).

    Browsers commonly send code files as application/octet-stream, so the
    extension is the authoritative gate; benign declared types defer to it.
    """
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    cases = [
        ("page.html", b"<h1>hi</h1>", "text/html"),
        ("script.py", b"print('hi')", "application/octet-stream"),
        ("types.ts", b"export const x = 1", "application/octet-stream"),
        ("config.toml", b"[a]\nb = 1", "application/octet-stream"),
    ]
    for filename, content, content_type in cases:
        resp = client.post(
            "/uploads",
            headers=_AUTH_HEADER,
            files={"file": (filename, content, content_type)},
        )
        assert resp.status_code == 200, f"{filename}: {resp.text}"


def test_upload_blocks_js_and_sh_extensions(monkeypatch, tmp_path):
    """Executable/script extensions stay blocked even with a benign media type."""
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    for filename in ("evil.js", "evil.sh", "evil.ps1"):
        resp = client.post(
            "/uploads",
            headers=_AUTH_HEADER,
            files={"file": (filename, b"x" * 10, "text/plain")},
        )
        assert resp.status_code == 400, f"{filename}: {resp.text}"
        assert "extension" in resp.json()["detail"]


def test_upload_rejects_disallowed_media_type(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/uploads",
        headers=_AUTH_HEADER,
        files={"file": ("payload.txt", b"a" * 100, "application/x-msdownload")},
    )

    assert resp.status_code == 400, resp.text
    assert "media type" in resp.json()["detail"]


def test_upload_rejects_oversized_file(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/uploads",
        headers=_AUTH_HEADER,
        files={"file": ("large.txt", b"a" * (50 * 1024 * 1024), "text/plain")},
    )

    assert resp.status_code == 400, resp.text
    assert "exceeds" in resp.json()["detail"]


def test_upload_rejects_disallowed_extension(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)

    resp = client.post(
        "/uploads",
        headers=_AUTH_HEADER,
        files={"file": ("run.exe", b"a" * 100, "text/plain")},
    )

    assert resp.status_code == 400, resp.text
    assert "extension" in resp.json()["detail"]


def test_upload_enforces_per_secret_hourly_cap(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path, upload_hourly_cap_bytes=150)
    client = TestClient(main.app)

    first = client.post(
        "/uploads",
        headers=_AUTH_HEADER,
        files={"file": ("first.txt", b"a" * 100, "text/plain")},
    )
    second = client.post(
        "/uploads",
        headers=_AUTH_HEADER,
        files={"file": ("second.txt", b"b" * 100, "text/plain")},
    )

    assert first.status_code == 200, first.text
    assert second.status_code == 400, second.text
    assert "hourly cap" in second.json()["detail"]
