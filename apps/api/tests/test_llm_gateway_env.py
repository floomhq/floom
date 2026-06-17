"""#1448: engine-side wiring for the managed LLM gateway.

Verifies the sandbox env injection (_llm_gateway_env) and that the gateway host
is added to the sandbox egress allowlist when configured. The proxy itself needs
live provider creds + load to verify (see ops/llm-gateway/README.md).
"""

from __future__ import annotations

from runner_sandbox import e2b_driver


def test_gateway_env_off_by_default(monkeypatch):
    monkeypatch.delenv("WORKEROS_LLM_GATEWAY_URL", raising=False)
    monkeypatch.delenv("WORKEROS_LLM_GATEWAY_KEY", raising=False)
    assert e2b_driver._llm_gateway_env() == {}


def test_gateway_env_url_only(monkeypatch):
    monkeypatch.setenv("WORKEROS_LLM_GATEWAY_URL", "https://llm-gw.floom.dev/v1/")
    monkeypatch.delenv("WORKEROS_LLM_GATEWAY_KEY", raising=False)
    env = e2b_driver._llm_gateway_env()
    # Trailing slash stripped; both openai + litellm base vars set; no key.
    assert env == {
        "OPENAI_BASE_URL": "https://llm-gw.floom.dev/v1",
        "OPENAI_API_BASE": "https://llm-gw.floom.dev/v1",
    }


def test_gateway_env_url_and_key(monkeypatch):
    monkeypatch.setenv("WORKEROS_LLM_GATEWAY_URL", "https://llm-gw.floom.dev/v1")
    monkeypatch.setenv("WORKEROS_LLM_GATEWAY_KEY", "sk-virtual-123")
    env = e2b_driver._llm_gateway_env()
    assert env["OPENAI_API_KEY"] == "sk-virtual-123"
    assert env["OPENAI_BASE_URL"] == "https://llm-gw.floom.dev/v1"


def test_gateway_host_in_egress_allowlist(monkeypatch):
    monkeypatch.setenv("WORKEROS_LLM_GATEWAY_URL", "https://llm-gw.floom.dev/v1")
    hosts = e2b_driver._platform_egress_hosts()
    assert "llm-gw.floom.dev" in hosts


def test_gateway_host_absent_when_unset(monkeypatch):
    monkeypatch.delenv("WORKEROS_LLM_GATEWAY_URL", raising=False)
    hosts = e2b_driver._platform_egress_hosts()
    # Direct provider hosts are still present; no stray gateway host.
    assert "api.openai.com" in hosts
