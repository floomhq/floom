from fastapi.testclient import TestClient


def test_healthz_and_version_expose_build_identity(monkeypatch):
    import tempfile
    from pathlib import Path

    temp_root = Path(tempfile.mkdtemp(prefix="cloud-build-identity-"))
    monkeypatch.setenv("WORKEROS_BUILD_SHA", "abc123")
    monkeypatch.setenv("WORKEROS_BUILD_REF", "staging")
    monkeypatch.setenv("WORKEROS_BUILD_TIME", "2026-06-23T20:00:00Z")
    monkeypatch.setenv("WORKEROS_BUILD_SOURCE", "floom-worker")
    monkeypatch.setenv("WORKEROS_ENVIRONMENT", "staging")
    monkeypatch.setenv("WORKEROS_ROLE", "web")
    monkeypatch.setenv("WORKEROS_DEPLOY", "cloud")
    monkeypatch.setenv("SUPABASE_URL", "https://placeholder.supabase.co")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "placeholder")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "placeholder")
    monkeypatch.setenv(
        "WORKEROS_CLOUD_SECRETS_ENCRYPTION_KEY",
        "d29ya2Vyb3MtY2xvdWQtY2ktdGVzdC1rZXktMzJieXQ=",
    )
    monkeypatch.setenv("WORKEROS_DB", str(temp_root / "engine.db"))
    monkeypatch.setenv("FLOOM_DB", str(temp_root / "engine.db"))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(temp_root / "workers"))
    monkeypatch.setenv("FLOOM_CONTEXTS_DIR", str(temp_root / "contexts"))
    monkeypatch.setenv("FLOOM_ARTIFACTS_DIR", str(temp_root / "artifacts"))

    from apps.api.main import app

    client = TestClient(app)
    for path in ("/healthz", "/version"):
        payload = client.get(path).json()
        assert payload["status"] == "ok"
        assert payload["deploy"] == "cloud"
        assert payload["service"] == "cloud-api"
        assert payload["role"] == "web"
        assert payload["environment"] == "staging"
        assert payload["build_sha"] == "abc123"
        assert payload["build_ref"] == "staging"
        assert payload["build_time"] == "2026-06-23T20:00:00Z"
        assert payload["build_source"] == "floom-worker"


def test_build_identity_uses_provider_fallbacks(monkeypatch):
    monkeypatch.delenv("WORKEROS_BUILD_SHA", raising=False)
    monkeypatch.setenv("RAILWAY_GIT_COMMIT_SHA", "railway-sha")
    monkeypatch.setenv("RAILWAY_GIT_BRANCH", "staging")
    monkeypatch.setenv("RAILWAY_ENVIRONMENT_NAME", "production")

    from apps.api.build_identity import build_identity

    payload = build_identity()
    assert payload["build_sha"] == "railway-sha"
    assert payload["build_ref"] == "staging"
    assert payload["environment"] == "production"


def test_build_identity_unknown_without_env(monkeypatch):
    for name in (
        "WORKEROS_BUILD_SHA",
        "BUILD_SHA",
        "RAILWAY_GIT_COMMIT_SHA",
        "VERCEL_GIT_COMMIT_SHA",
        "GITHUB_SHA",
    ):
        monkeypatch.delenv(name, raising=False)

    from apps.api.build_identity import build_identity

    assert build_identity()["build_sha"] == "unknown"
