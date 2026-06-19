from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from routers.runs import _public_run_log_sse_event


def test_live_run_log_sse_message_is_redacted() -> None:
    event = {
        "type": "log",
        "level": "error",
        "message": "Traceback (most recent call last):\nOPENAI_API_KEY=sk-secret\nRuntimeError: boom",
        "timestamp": "2026-06-19T00:00:00Z",
        "trace_id": "trace_123",
    }

    out = _public_run_log_sse_event(event)

    assert out["type"] == "log"
    assert out["level"] == "error"
    assert out["timestamp"] == "2026-06-19T00:00:00Z"
    assert out["trace_id"] == "trace_123"
    assert "sk-secret" not in out["message"]
    assert "Traceback" not in out["message"]
