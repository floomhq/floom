from runner_sandbox import e2b_driver


def test_sandbox_api_url_prefers_sandbox_callback_override(monkeypatch):
    monkeypatch.setenv("WORKEROS_API_URL", "https://localhost:8000")
    monkeypatch.setenv("WORKEROS_SANDBOX_API_URL", "https://api-origin.example.test/")
    monkeypatch.delenv("WORKEROS_E2B_API_URL", raising=False)
    monkeypatch.delenv("WORKEROS_INTERNAL_API_URL", raising=False)
    monkeypatch.delenv("WORKEROS_API_BASE", raising=False)
    monkeypatch.delenv("WORKERS_API_URL", raising=False)

    assert e2b_driver._sandbox_api_url() == "https://api-origin.example.test"


def test_sandbox_api_url_supports_internal_alias(monkeypatch):
    monkeypatch.delenv("WORKEROS_SANDBOX_API_URL", raising=False)
    monkeypatch.delenv("WORKEROS_E2B_API_URL", raising=False)
    monkeypatch.setenv("WORKEROS_INTERNAL_API_URL", "https://api-internal.example.test")
    monkeypatch.setenv("WORKEROS_API_URL", "https://localhost:8000")
    monkeypatch.delenv("WORKEROS_API_BASE", raising=False)
    monkeypatch.delenv("WORKERS_API_URL", raising=False)

    assert e2b_driver._sandbox_api_url() == "https://api-internal.example.test"
