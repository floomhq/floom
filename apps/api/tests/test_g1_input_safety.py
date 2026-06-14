"""g1 security batch — input/output safety fixes.

Covers:
  #913 — worker-manifest output paths are confined to the run's artifact dir
         (absolute paths / `..` no longer reach the host filesystem).
  #931 — /workspace/import enforces zip-bomb guards (entries + uncompressed).
  #932 — /workers/from-bundle strips secret-bearing files (.env, *.key, ...).
  #929 — /uploads downloads carry nosniff + attachment headers.
  #920 — the ValueError handler returns a generic message to clients.
  #921 — CORS: no wildcard *.floom.dev default; explicit methods/headers.

Run:
    cd apps/api && python -m pytest tests/test_g1_input_safety.py -v
"""
from __future__ import annotations

import asyncio
import importlib
import io
import json
import sys
import types
import zipfile
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

SECRET = "g1-input-safety-secret"


def _load_main(monkeypatch, tmp_path, *, secret: str | None = SECRET, env: dict | None = None):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("WORKEROS_INSECURE_COOKIES", "1")
    monkeypatch.delenv("WORKEROS_DEV", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("ALLOWED_ORIGIN_REGEX", raising=False)
    if secret is None:
        monkeypatch.delenv("FLOOM_SECRET", raising=False)
    else:
        monkeypatch.setenv("FLOOM_SECRET", secret)
    for key, value in (env or {}).items():
        monkeypatch.setenv(key, value)
    for name in list(sys.modules):
        if (
            name == "main"
            or name == "db"
            or name.startswith("db.")
            or name == "auth"
            or name.startswith("auth.")
            or name == "worker_registry"
        ):
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    return importlib.import_module("main")


def _client(main):
    from fastapi.testclient import TestClient

    return TestClient(main.app, raise_server_exceptions=False)


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for path, content in files.items():
            zf.writestr(path, content)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# #913 — output path confinement
# ---------------------------------------------------------------------------

class TestCandidateOutputPath:
    def _run_service(self, monkeypatch, tmp_path):
        import run_service
        from services import run_outputs

        # _candidate_output_path / _safe_artifact_path live in services.run_outputs
        # and resolve ARTIFACTS_DIR in that module's namespace; patch it there.
        monkeypatch.setattr(run_service, "ARTIFACTS_DIR", tmp_path / "artifacts")
        monkeypatch.setattr(run_outputs, "ARTIFACTS_DIR", tmp_path / "artifacts")
        return run_service

    def test_absolute_declared_path_rejected(self, monkeypatch, tmp_path):
        rs = self._run_service(monkeypatch, tmp_path)
        output = types.SimpleNamespace(path="/etc/passwd", name="leak")
        assert rs._candidate_output_path("run1", output, {}, []) is None

    def test_dotdot_declared_path_rejected(self, monkeypatch, tmp_path):
        rs = self._run_service(monkeypatch, tmp_path)
        output = types.SimpleNamespace(path="../../other-run/out.txt", name="leak")
        assert rs._candidate_output_path("run1", output, {}, []) is None

    def test_relative_declared_path_confined(self, monkeypatch, tmp_path):
        rs = self._run_service(monkeypatch, tmp_path)
        output = types.SimpleNamespace(path="out/result.txt", name="ok")
        resolved = rs._candidate_output_path("run1", output, {}, [])
        assert resolved is not None
        root = (tmp_path / "artifacts" / "run1").resolve()
        assert resolved == root / "out" / "result.txt"

    def test_absolute_echoed_value_rejected(self, monkeypatch, tmp_path):
        rs = self._run_service(monkeypatch, tmp_path)
        output = types.SimpleNamespace(path=None, name="report")
        # echoed output value pointing at an absolute path
        assert rs._candidate_output_path("run1", output, {"report": "/etc/shadow"}, []) is None


# ---------------------------------------------------------------------------
# #931 — workspace import zip-bomb guards
# ---------------------------------------------------------------------------

class TestImportZipGuards:
    def test_too_many_entries_rejected(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        import routers.workspace as _wsr
        monkeypatch.setattr(_wsr, "_MAX_IMPORT_ENTRIES", 3)
        payload = _zip_bytes({f"workers/w/file{i}.txt": b"x" for i in range(4)})
        with _client(main) as client:
            resp = client.post(
                "/workspace/import",
                headers={"x-floom-secret": SECRET},
                files={"bundle": ("t.zip", payload, "application/zip")},
            )
        assert resp.status_code == 413, resp.text
        assert "too many entries" in resp.json()["detail"]

    def test_uncompressed_size_cap_rejected(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        import routers.workspace as _wsr
        monkeypatch.setattr(_wsr, "_MAX_IMPORT_UNCOMPRESSED_BYTES", 64)
        payload = _zip_bytes({"workers/w/big.txt": b"A" * 1024})
        with _client(main) as client:
            resp = client.post(
                "/workspace/import",
                headers={"x-floom-secret": SECRET},
                files={"bundle": ("t.zip", payload, "application/zip")},
            )
        assert resp.status_code == 413, resp.text
        assert "uncompressed size exceeds" in resp.json()["detail"]


# ---------------------------------------------------------------------------
# #932 — from-bundle strips secret-bearing files
# ---------------------------------------------------------------------------

WORKER_YML = """schema_version: "0.3"
name: {name}
title: "G1 bundle worker"
description: "g1 test"
version: "0.1.0"
entrypoint: SKILL.md
targets: [generic]
exec:
  runtime: skill
  mode: agent
  runner: e2b
  inputs: []
  outputs: []
trigger:
  type: manual
"""


class TestBundleSecretStrip:
    def test_env_and_key_files_stripped(self, monkeypatch, tmp_path):
        workers_dir = tmp_path / "workers"
        workers_dir.mkdir()
        main = _load_main(
            monkeypatch, tmp_path, env={"FLOOM_WORKERS_DIR": str(workers_dir)}
        )
        name = "g1-bundle-secret-strip"
        payload = _zip_bytes(
            {
                f"{name}/worker.yml": WORKER_YML.format(name=name).encode(),
                f"{name}/SKILL.md": b"# Skill\n",
                f"{name}/.env": b"OPENAI_API_KEY=sk-planted\n",
                f"{name}/credentials.json": b"{}",
                f"{name}/deploy.key": b"-----BEGIN PRIVATE KEY-----",
            }
        )
        with _client(main) as client:
            resp = client.post(
                "/workers/from-bundle",
                headers={"x-floom-secret": SECRET},
                files={"bundle": ("b.zip", payload, "application/zip")},
            )
        assert resp.status_code in (200, 201), resp.text
        from worker_registry import WORKERS_DIR

        target = Path(WORKERS_DIR) / name
        assert (target / "worker.yml").is_file()
        assert (target / "SKILL.md").is_file()
        assert not (target / ".env").exists()
        assert not (target / "credentials.json").exists()
        assert not (target / "deploy.key").exists()


# ---------------------------------------------------------------------------
# #929 — upload download headers
# ---------------------------------------------------------------------------

class TestUploadDownloadHeaders:
    def test_nosniff_and_attachment_on_download(self, monkeypatch, tmp_path):
        monkeypatch.setenv("FLOOM_UPLOADS_DIR", str(tmp_path / "uploads"))
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as client:
            up = client.post(
                "/uploads",
                headers={"x-floom-secret": SECRET},
                files={"file": ("page.html", b"<script>alert(1)</script>", "text/html")},
            )
            assert up.status_code == 200, up.text
            url = up.json()["url"]
            down = client.get(url, headers={"x-floom-secret": SECRET})
        assert down.status_code == 200, down.text
        assert down.headers.get("x-content-type-options") == "nosniff"
        assert "attachment" in (down.headers.get("content-disposition") or "")


# ---------------------------------------------------------------------------
# #920 — generic ValueError responses
# ---------------------------------------------------------------------------

class TestValueErrorHandler:
    def test_internal_detail_not_leaked(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        resp = asyncio.run(
            main.value_error_handler(None, ValueError("/secret/path/to/config leaked"))
        )
        assert resp.status_code == 400
        body = json.loads(bytes(resp.body))
        assert body == {"detail": "Invalid request"}


# ---------------------------------------------------------------------------
# #921 — CORS lockdown
# ---------------------------------------------------------------------------

class TestCorsLockdown:
    def test_default_regex_is_none_in_prod(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        assert main._cors_allowed_origin_regex() is None

    def test_env_override_respected(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        monkeypatch.setenv("ALLOWED_ORIGIN_REGEX", r"^https://x\.example$")
        assert main._cors_allowed_origin_regex() == r"^https://x\.example$"

    def test_arbitrary_floomdev_subdomain_not_allowed(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as client:
            resp = client.options(
                "/healthz",
                headers={
                    "Origin": "https://evil.floom.dev",
                    "Access-Control-Request-Method": "GET",
                },
            )
        assert resp.headers.get("access-control-allow-origin") is None

    def test_known_frontend_origin_allowed(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as client:
            resp = client.options(
                "/healthz",
                headers={
                    "Origin": "https://workers.floom.dev",
                    "Access-Control-Request-Method": "GET",
                },
            )
        assert resp.headers.get("access-control-allow-origin") == "https://workers.floom.dev"

    def test_wildcard_headers_not_reflected(self, monkeypatch, tmp_path):
        main = _load_main(monkeypatch, tmp_path)
        with _client(main) as client:
            resp = client.options(
                "/healthz",
                headers={
                    "Origin": "https://workers.floom.dev",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "x-evil-header",
                },
            )
        allowed = (resp.headers.get("access-control-allow-headers") or "").lower()
        assert "x-evil-header" not in allowed
