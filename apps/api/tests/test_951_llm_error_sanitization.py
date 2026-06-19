"""#951 — LLM provider errors must never reach clients verbatim.

The leak: POST /workers/draft-from-prompt returned `LLM call failed: Error
code: 429 - {'error': {'message': 'You exceeded your current quota…'}}`,
disclosing the provider, account/billing state, and Python backend. The chat
stream error part leaked the same way (verified live: raw 401 with key
fragment). Pins:
  - safe_llm_error_message strips all provider detail for quota/auth and
    generic provider failures
  - the draft-from-prompt endpoint returns the sanitized message
  - the stream_chat error part is sanitized

Run: cd apps/api && python -m pytest tests/test_951_llm_error_sanitization.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from llm import is_llm_provider_outage, safe_llm_error_message

QUOTA_ERROR = (
    "Error code: 429 - {'error': {'message': 'You exceeded your current quota, "
    "please check your plan and billing details. For more information on this "
    "error, read the docs: https://platform.openai.com/docs/guides/error-codes/"
    "api-errors.', 'type': 'insufficient_quota', 'param': None, "
    "'code': 'insufficient_quota'}}"
)
AUTH_ERROR = (
    "Error code: 401 - {'error': {'message': 'Incorrect API key provided: "
    "sk-inval********test.', 'type': 'invalid_request_error', "
    "'code': 'invalid_api_key'}}"
)

LEAK_MARKERS = ("openai", "quota", "billing", "429", "401", "sk-", "insufficient", "api key", "'param'")


class TestSanitizer:
    @pytest.mark.parametrize("raw", [QUOTA_ERROR, AUTH_ERROR])
    def test_outage_errors_fully_scrubbed(self, raw):
        msg = safe_llm_error_message(raw, action="Worker generation")
        assert is_llm_provider_outage(raw)
        low = msg.lower()
        for marker in LEAK_MARKERS:
            assert marker not in low, f"sanitized message leaks {marker!r}: {msg}"
        assert "temporarily unavailable" in low

    def test_generic_provider_error_scrubbed(self):
        msg = safe_llm_error_message("openai.APIConnectionError: connection to api.openai.com failed")
        assert "openai" not in msg.lower()
        assert "api.openai.com" not in msg

    def test_unknown_error_gets_generic_message(self):
        msg = safe_llm_error_message(ValueError("worker_yml missing key 'exec'"), action="Chat")
        assert msg == "Chat failed. Please try again."
        assert "exec" not in msg


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("WORKEROS_DEPLOY", "local")
    monkeypatch.setenv("WORKEROS_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    monkeypatch.setenv("WORKEROS_API_ENV_FILE", str(tmp_path / "api.env"))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-951")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    for name in list(sys.modules):
        if name in ("main", "db", "contexts") or name.startswith("db.") or name == "auth":
            sys.modules.pop(name, None)
    db = importlib.import_module("db")
    db.init_db()
    db.get_repositories.cache_clear()
    main = importlib.import_module("main")
    from fastapi.testclient import TestClient

    c = TestClient(main.app, headers={"x-floom-secret": "test-secret-951"}, raise_server_exceptions=False)
    yield c, main
    db.get_repositories.cache_clear()


def test_draft_from_prompt_does_not_leak_provider_error(client, monkeypatch):
    c, _main = client
    import codegen_model

    def _boom(**_kwargs):
        raise RuntimeError(QUOTA_ERROR)

    monkeypatch.setattr(codegen_model, "chat_completion_codegen", _boom)
    resp = c.post("/workers/draft-from-prompt", json={"prompt": "summarize my gmail daily"})
    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"].lower()
    for marker in LEAK_MARKERS:
        assert marker not in detail, f"endpoint leaks {marker!r}: {detail}"
    assert "worker generation" in detail


class TestChatErrorEmitterWiring:
    """Guards the two chat error-part emitters: reverting either back to
    str(exc) must fail these even though the sanitizer itself still works."""

    def test_stream_chat_error_part_is_sanitized(self):
        import inspect

        import chat_service

        src = inspect.getsource(chat_service.stream_chat)
        assert "safe_llm_error_message" in src, (
            "stream_chat error part reverted to raw str(exc) (#951)"
        )

    def test_background_task_error_part_is_sanitized(self):
        # post_chat now lives in the extracted routers/chat.py (modular refactor).
        chat_src = Path(__file__).resolve().parents[1].joinpath("routers", "chat.py").read_text(encoding="utf-8")
        # the /chat background task emitter must not put a raw exception
        assert '"error": safe_llm_error_message(exc, action="Chat")' in chat_src, (
            "/chat background-task error part reverted to raw str(exc) (#951)"
        )
