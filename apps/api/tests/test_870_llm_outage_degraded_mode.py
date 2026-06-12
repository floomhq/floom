"""#870 — provider outage must degrade gracefully, not "Something went wrong".

Repo-side scope of #870: when OpenAI quota/auth fails, every channel told the
user "Something went wrong" with no explanation and ops got no signal. Pins:
  - outage classification (quota/auth/rate-limit) is detected
  - Slack + WhatsApp fallback handlers send the degraded-mode message for
    outages and keep the generic message for other failures
  - an LLM_PROVIDER_ALERT ERROR record is emitted for ops alerting

Provider failover itself (secondary key / second provider) is a feature
decision tracked on the issue, not covered here.

Run: cd apps/api && python -m pytest tests/test_870_llm_outage_degraded_mode.py -q
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from llm import is_llm_provider_outage, safe_llm_error_message

QUOTA_ERROR = "Error code: 429 - {'error': {'type': 'insufficient_quota'}}"


class TestOutageClassification:
    def test_quota_auth_rate_limit_are_outages(self):
        for raw in (
            QUOTA_ERROR,
            "AuthenticationError: invalid_api_key",
            "openai.RateLimitError: rate limit exceeded",
        ):
            assert is_llm_provider_outage(raw), raw

    def test_ordinary_errors_are_not_outages(self):
        for raw in ("KeyError: 'exec'", "worker not found", "TimeoutError: read timed out"):
            assert not is_llm_provider_outage(raw), raw


class TestOpsAlert:
    def test_outage_emits_alert_record(self, caplog):
        with caplog.at_level(logging.ERROR, logger="workeros.llm"):
            safe_llm_error_message(QUOTA_ERROR, action="Chat")
        assert any("LLM_PROVIDER_ALERT" in r.message for r in caplog.records)

    def test_non_outage_emits_no_alert(self, caplog):
        with caplog.at_level(logging.ERROR, logger="workeros.llm"):
            safe_llm_error_message("KeyError: 'exec'", action="Chat")
        assert not any("LLM_PROVIDER_ALERT" in r.message for r in caplog.records)


class TestChannelFallbacks:
    def _error_text(self, exc: Exception) -> str:
        # mirrors the channel handlers' selection logic
        if is_llm_provider_outage(exc):
            return safe_llm_error_message(exc, action="Chat")
        return "Something went wrong on my end. Try again in a moment."

    def test_outage_gets_degraded_message(self):
        text = self._error_text(RuntimeError(QUOTA_ERROR))
        assert "temporarily unavailable" in text
        assert "Something went wrong" not in text

    def test_other_errors_keep_generic_message(self):
        assert self._error_text(RuntimeError("boom")) == (
            "Something went wrong on my end. Try again in a moment."
        )

    def test_slack_handler_selects_degraded_message(self):
        import inspect

        from channels import slack

        src = inspect.getsource(slack._handle_slack_direct_message)
        assert "is_llm_provider_outage" in src and "safe_llm_error_message" in src

    def test_whatsapp_handler_selects_degraded_message(self):
        import inspect

        from channels import whatsapp

        src = inspect.getsource(whatsapp)
        handler = [
            f for n, f in inspect.getmembers(whatsapp, inspect.isfunction)
            if "Something went wrong" in (inspect.getsource(f) if f.__module__ == whatsapp.__name__ else "")
        ]
        assert handler, "WhatsApp fallback handler not found"
        assert all("is_llm_provider_outage" in inspect.getsource(f) for f in handler)
