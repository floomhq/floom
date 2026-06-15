"""Unit tests for the shared codegen model config + chat helper.

The prompt-to-worker wedge depends on generation + draft + repair all using the
same strong code model. These tests pin:
  - the strong default + env override,
  - the gpt-5.x (max_completion_tokens) vs gpt-4 (max_tokens) param selection,
  - the one-shot retry on the OpenAI "use the other token param" 400.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import codegen_model as cm  # noqa: E402


def test_default_is_strong_coder(monkeypatch):
    monkeypatch.delenv("WORKEROS_CODEGEN_MODEL", raising=False)
    monkeypatch.delenv("WORKEROS_CHAT_MODEL", raising=False)
    assert cm.codegen_model() == "gpt-5.5"
    assert cm.DEFAULT_CODEGEN_MODEL == "gpt-5.5"


def test_env_override(monkeypatch):
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", "gpt-4o")
    assert cm.codegen_model() == "gpt-4o"


def test_blank_env_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", "   ")
    monkeypatch.delenv("WORKEROS_CHAT_MODEL", raising=False)
    assert cm.codegen_model() == "gpt-5.5"


@pytest.mark.parametrize(
    "model,expected_kwarg",
    [
        ("gpt-5.1", "max_completion_tokens"),
        ("gpt-5", "max_completion_tokens"),
        ("o3", "max_completion_tokens"),
        ("o4-mini", "max_completion_tokens"),
        ("gpt-4o-mini", "max_tokens"),
        ("gpt-4.1", "max_tokens"),
    ],
)
def test_token_param_selection(model, expected_kwarg):
    class _FakeCompletions:
        def __init__(self):
            self.captured = None

        def create(self, **kwargs):
            self.captured = kwargs
            return "resp"

    class _FakeClient:
        def __init__(self):
            self.chat = type("C", (), {"completions": _FakeCompletions()})()

    client = _FakeClient()
    cm.chat_completion_codegen(
        client, messages=[], max_output_tokens=1234, model=model
    )
    captured = client.chat.completions.captured
    assert expected_kwarg in captured
    assert captured[expected_kwarg] == 1234
    assert captured["model"] == model


def test_retries_on_max_completion_tokens_400():
    """A model misdetected as gpt-4-family (max_tokens) that actually needs
    max_completion_tokens self-heals on the OpenAI 400."""
    calls = []

    class _FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            if "max_tokens" in kwargs and len(calls) == 1:
                raise RuntimeError(
                    "Unsupported parameter: 'max_tokens' is not supported with "
                    "this model. Use 'max_completion_tokens' instead."
                )
            return "ok"

    class _FakeClient:
        def __init__(self):
            self.chat = type("C", (), {"completions": _FakeCompletions()})()

    client = _FakeClient()
    # custom-named model not matching gpt-5 prefix -> first try uses max_tokens
    out = cm.chat_completion_codegen(
        client, messages=[], max_output_tokens=900, model="custom-reasoner"
    )
    assert out == "ok"
    assert len(calls) == 2
    assert "max_tokens" in calls[0]
    assert "max_completion_tokens" in calls[1]


def test_retries_without_temperature_when_model_rejects_non_default_temperature():
    """gpt-5.5 accepts only default temperature; retry without that parameter."""
    calls = []

    class _FakeCompletions:
        def create(self, **kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise RuntimeError(
                    "Unsupported value: 'temperature' does not support 0.2 "
                    "with this model. Only the default (1) value is supported."
                )
            return "ok"

    class _FakeClient:
        def __init__(self):
            self.chat = type("C", (), {"completions": _FakeCompletions()})()

    out = cm.chat_completion_codegen(
        _FakeClient(),
        messages=[],
        max_output_tokens=700,
        model="gpt-5.5",
        temperature=0.2,
    )

    assert out == "ok"
    assert len(calls) == 2
    assert calls[0]["temperature"] == 0.2
    assert "temperature" not in calls[1]
    assert calls[1]["model"] == "gpt-5.5"
    assert calls[1]["max_completion_tokens"] == 700


def test_non_param_error_propagates():
    class _FakeCompletions:
        def create(self, **kwargs):
            raise RuntimeError("rate limit exceeded")

    class _FakeClient:
        def __init__(self):
            self.chat = type("C", (), {"completions": _FakeCompletions()})()

    with pytest.raises(RuntimeError, match="rate limit"):
        cm.chat_completion_codegen(
            _FakeClient(), messages=[], max_output_tokens=10, model="gpt-5.1"
        )
