from __future__ import annotations

from types import SimpleNamespace

from runner_sandbox.agent_driver import AgentDriver
from services.public_view import _public_run_part


def test_agent_stream_tool_call_and_result_are_redacted(monkeypatch):
    import runner_sandbox.stream_adapter as stream_adapter

    driver = AgentDriver()
    secret = "sk-test-secret-1234567890"
    events = [
        SimpleNamespace(
            kind="tool_call",
            tool_name="secrets__set",
            args={"name": "OPENAI_API_KEY", "value": secret},
            call_id="call_1",
            metadata={},
        ),
        SimpleNamespace(
            kind="tool_output",
            output={"ok": True, "token": secret},
            call_id="call_1",
            is_error=False,
            metadata={},
        ),
    ]

    for item in events:
        monkeypatch.setattr(stream_adapter, "decode_stream_event", lambda _event, item=item: item)
        part, _emitted = driver._agent_event_to_part(object(), emitted_text_delta=False)
        encoded = str(part)
        assert secret not in encoded
        assert "redacted" in encoded


def test_public_run_part_redacts_legacy_raw_tool_payloads():
    secret = "sk-test-secret-1234567890"
    call = _public_run_part({
        "type": "tool-call",
        "toolName": "secrets__set",
        "args": {"name": "OPENAI_API_KEY", "value": secret},
    })
    result = _public_run_part({
        "type": "tool-result",
        "result": {"ok": True, "token": secret},
    })

    encoded = f"{call} {result}"
    assert secret not in encoded
    assert "redacted" in encoded

