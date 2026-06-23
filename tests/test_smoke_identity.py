import pytest

from ops.smoke_identity import Config, IdentitySmokeError, Target, run_smoke


def test_identity_smoke_passes_all_configured_targets():
    calls: list[str] = []

    def fetch(url: str, _timeout: float):
        calls.append(url)
        return {"service": url.rsplit("/", 2)[-2], "build_sha": "abc123"}

    passed = run_smoke(
        Config(
            expected_sha="abc123",
            targets=(
                Target("api", "https://api.example/version"),
                Target("landing", "https://web.example/version"),
                Target("dashboard", "https://web.example/app/version"),
            ),
            interval_seconds=0,
        ),
        fetch=fetch,
    )

    assert calls == [
        "https://api.example/version",
        "https://web.example/version",
        "https://web.example/app/version",
    ]
    assert passed == [
        "api:api.example:abc123",
        "landing:web.example:abc123",
        "dashboard:app:abc123",
    ]


def test_identity_smoke_fails_on_stale_target():
    def fetch(url: str, _timeout: float):
        return {"service": "api", "build_sha": "oldsha" if "api" in url else "abc123"}

    with pytest.raises(IdentitySmokeError, match="build_sha=oldsha expected=abc123"):
        run_smoke(
            Config(
                expected_sha="abc123",
                targets=(
                    Target("api", "https://api.example/version"),
                    Target("landing", "https://web.example/version"),
                ),
                interval_seconds=0,
            ),
            fetch=fetch,
        )


def test_identity_smoke_fails_on_unknown_sha():
    def fetch(_url: str, _timeout: float):
        return {"service": "api", "build_sha": "unknown"}

    with pytest.raises(IdentitySmokeError, match="build_sha=unknown expected=abc123"):
        run_smoke(
            Config(
                expected_sha="abc123",
                targets=(Target("api", "https://api.example/version"),),
                interval_seconds=0,
            ),
            fetch=fetch,
        )


def test_identity_smoke_retries_until_alias_converges():
    attempts = 0

    def fetch(_url: str, _timeout: float):
        nonlocal attempts
        attempts += 1
        return {"service": "landing", "build_sha": "abc123" if attempts == 2 else "oldsha"}

    passed = run_smoke(
        Config(
            expected_sha="abc123",
            targets=(Target("landing", "https://web.example/version"),),
            attempts=2,
            interval_seconds=0,
        ),
        fetch=fetch,
    )

    assert attempts == 2
    assert passed == ["landing:landing:abc123"]


def test_config_from_env_builds_default_urls(monkeypatch):
    monkeypatch.setenv("WORKEROS_IDENTITY_EXPECTED_SHA", "abc123")
    monkeypatch.setenv("WORKEROS_IDENTITY_API_BASE", "https://api.example/")
    monkeypatch.setenv("WORKEROS_IDENTITY_WEB_BASE", "https://web.example/")

    config = Config.from_env()

    assert config.expected_sha == "abc123"
    assert config.targets == (
        Target("api", "https://api.example/version"),
        Target("landing", "https://web.example/version"),
        Target("dashboard", "https://web.example/app/version"),
    )
