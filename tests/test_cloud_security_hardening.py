from __future__ import annotations

import importlib
import inspect
import sys
import types
from collections import Counter

import pytest
from fastapi.testclient import TestClient


def _load_cloud_app(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("WORKEROS_DEV", "1")
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(tmp_path / "workers"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-that-cloud-must-strip")
    monkeypatch.delenv("WORKEROS_RATE_LIMIT_DEV", raising=False)

    psycopg = types.ModuleType("psycopg")
    psycopg.Connection = object
    psycopg.connect = lambda *_args, **_kwargs: None
    monkeypatch.setitem(sys.modules, "psycopg", psycopg)

    for name in [
        "apps.api.startup",
        "apps.api.main",
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "chat_service",
    ]:
        sys.modules.pop(name, None)
    return importlib.import_module("apps.api.main")


def test_cloud_healthz_gets_security_headers(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "deploy": "cloud"}
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "microphone=()" in response.headers["Permissions-Policy"]
    assert response.headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"


def test_cloud_enables_engine_rate_limiter_without_floom_secret(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    codes = [client.get("/workers").status_code for _ in range(25)]

    assert main.os.environ["WORKEROS_RATE_LIMIT_DEV"] == "1"
    assert "FLOOM_SECRET" not in main.os.environ
    assert Counter(codes) == Counter({401: 20, 429: 5})


def test_cloud_versioned_api_prefixes_reach_engine_routes(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    paths = [
        "/api/v1/workers/example/versions",
        "/v1/workers/example/versions",
        "/api/v1/workspace/versions",
        "/v1/workspace/versions",
    ]

    for path in paths:
        response = client.get(path)
        assert response.status_code == 401, path
        assert response.json()["detail"] in {"missing bearer token", "unauthorized"}


def test_cloud_create_run_override_keeps_engine_status_default(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)

    signature = inspect.signature(main.engine_main.create_run)

    assert signature.parameters["status"].default is None


def test_cloud_worker_author_can_use_platform_openai_key(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "test-platform-openai-key")
    main = _load_cloud_app(monkeypatch, tmp_path)

    class _Workers:
        def get_owner(self, *, worker_id):
            return None

        def get_recipe(self, *, worker_id):
            return None

    class _Secrets:
        def list_names(self, *, user_id):
            return []

        def resolve(self, *, user_id, names):
            return {}

    class _Repos:
        workers = _Workers()
        secrets = _Secrets()

    worker_author_secrets = main.engine_run_service.get_secrets_for_worker(
        "worker-author",
        user_id="user-1",
        repos=_Repos(),
    )
    other_worker_secrets = main.engine_run_service.get_secrets_for_worker(
        "not-worker-author",
        user_id="user-1",
        repos=_Repos(),
    )

    assert worker_author_secrets["OPENAI_API_KEY"] == "test-platform-openai-key"
    assert "OPENAI_API_KEY" not in other_worker_secrets


def test_cloud_worker_author_platform_key_survives_secret_store_disconnect(monkeypatch, tmp_path):
    monkeypatch.setenv("OPENAI_API_KEY", "test-platform-openai-key")
    main = _load_cloud_app(monkeypatch, tmp_path)

    class _Workers:
        def get_owner(self, *, worker_id):
            return None

        def get_recipe(self, *, worker_id):
            return None

    class _Secrets:
        def list_names(self, *, user_id):
            return []

        def resolve(self, *, user_id, names):
            raise RuntimeError("secret store disconnected")

    class _Repos:
        workers = _Workers()
        secrets = _Secrets()

    worker_author_secrets = main.engine_run_service.get_secrets_for_worker(
        "worker-author",
        user_id="user-1",
        repos=_Repos(),
    )

    assert worker_author_secrets["OPENAI_API_KEY"] == "test-platform-openai-key"
    with pytest.raises(RuntimeError, match="secret store disconnected"):
        main.engine_run_service.get_secrets_for_worker(
            "not-worker-author",
            user_id="user-1",
            repos=_Repos(),
        )


def test_cloud_worker_file_paths_reject_traversal_before_persistence(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)

    with pytest.raises(main.HTTPException) as excinfo:
        main._sanitize_cloud_worker_files({"../pwn.py": "x"})

    assert excinfo.value.status_code == 400
    assert "invalid segment" in str(excinfo.value.detail) or "traversal" in str(excinfo.value.detail)


def test_cloud_worker_file_paths_reject_hidden_and_absolute_paths(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)

    for bad_path in ("/tmp/pwn.py", ".env", "nested/.secret"):
        with pytest.raises(main.HTTPException) as excinfo:
            main._sanitize_cloud_worker_files({bad_path: "x"})
        assert excinfo.value.status_code == 400


def test_cloud_worker_file_paths_allow_normal_nested_source(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)

    assert main._sanitize_cloud_worker_files({"worker.yml": "name: ok", "lib/util.py": "x"}) == {
        "worker.yml": "name: ok",
        "lib/util.py": "x",
    }


def test_cloud_rate_limits_auth_routes_by_trusted_edge_ip(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    statuses = [
        client.post(
            "/auth/password-login",
            json={},
            headers={"cf-connecting-ip": "203.0.113.40"},
        ).status_code
        for _ in range(6)
    ]

    assert statuses[:5] == [422, 422, 422, 422, 422]
    assert statuses[5] == 429


def test_cloud_rate_limit_ignores_raw_x_forwarded_for(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    statuses = [
        client.post(
            "/auth/password-login",
            json={},
            headers={
                "cf-connecting-ip": "203.0.113.41",
                "x-forwarded-for": f"198.51.100.{idx}",
            },
        ).status_code
        for idx in range(6)
    ]

    assert statuses[5] == 429


def test_cloud_rate_limits_by_bearer_token_before_ip(monkeypatch, tmp_path):
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app)

    first_ip_statuses = [
        client.post(
            "/auth/cli-exchange",
            json={},
            headers={"authorization": "Bearer floom_same_token", "cf-connecting-ip": f"203.0.113.{50 + idx}"},
        ).status_code
        for idx in range(6)
    ]
    second_token_status = client.post(
        "/auth/cli-exchange",
        json={},
        headers={"authorization": "Bearer floom_other_token", "cf-connecting-ip": "203.0.113.50"},
    ).status_code

    assert first_ip_statuses[5] == 429
    assert second_token_status == 422


# ---------------------------------------------------------------------------
# P2-A / P2-B: /metrics and /system/info must be admin-only
# ---------------------------------------------------------------------------

def test_cloud_metrics_endpoint_requires_admin(monkeypatch, tmp_path):
    """P2-A: GET /metrics returns 403 for a non-admin member in cloud mode."""
    main = _load_cloud_app(monkeypatch, tmp_path)
    client = TestClient(main.app, raise_server_exceptions=False)

    # In cloud dev mode the engine auth falls through to dev-context (admin).
    # We simulate a member-role auth by calling the engine function directly.
    from auth.context import AuthContext
    engine = main.engine_main

    import pytest as _pytest
    from fastapi import HTTPException
    with _pytest.raises(HTTPException) as exc_info:
        engine.prometheus_metrics(
            auth=AuthContext(user_id="member-1", role="member", auth_method="session")
        )
    assert exc_info.value.status_code == 403


def test_cloud_system_info_endpoint_requires_admin(monkeypatch, tmp_path):
    """P2-B: GET /system/info returns 403 for a non-admin member in cloud mode."""
    main = _load_cloud_app(monkeypatch, tmp_path)
    engine = main.engine_main

    from auth.context import AuthContext
    import pytest as _pytest
    from fastapi import HTTPException
    with _pytest.raises(HTTPException) as exc_info:
        engine.system_info(
            auth=AuthContext(user_id="member-1", role="member", auth_method="session")
        )
    assert exc_info.value.status_code == 403


def test_cloud_system_info_admin_gets_full_payload(monkeypatch, tmp_path):
    """P2-B: admin receives the full system info payload (no regression)."""
    main = _load_cloud_app(monkeypatch, tmp_path)
    engine = main.engine_main

    from auth.context import AuthContext
    info = engine.system_info(
        auth=AuthContext(user_id="admin-1", role="admin", scopes=("admin",), auth_method="session")
    )
    assert "version" in info
    assert "runner" in info
    assert "python_version" in info
    assert "started_at" in info
