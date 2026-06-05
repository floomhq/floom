#!/usr/bin/env python3
"""Regression tests for the in-sandbox worker-author OpenAI helper."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
WORKER_AUTHOR_RUN = ROOT / "workers" / "worker-author" / "run.py"


def _load_worker_author_module():
    spec = importlib.util.spec_from_file_location("worker_author_run_test", WORKER_AUTHOR_RUN)
    if spec is None or spec.loader is None:
        raise AssertionError(f"Unable to load {WORKER_AUTHOR_RUN}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _TemperatureRejectingCompletions:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        if len(self.calls) == 1:
            raise RuntimeError(
                "Unsupported value: 'temperature' does not support 0.2 "
                "with this model. Only the default (1) value is supported."
            )
        return "ok"


class _FakeClient:
    def __init__(self):
        self.completions = _TemperatureRejectingCompletions()
        self.chat = SimpleNamespace(completions=self.completions)


def test_worker_author_codegen_retries_without_temperature_for_gpt5(monkeypatch):
    module = _load_worker_author_module()
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", "gpt-5.1")
    client = _FakeClient()

    out = module._codegen_chat(
        client,
        messages=[],
        max_output_tokens=8000,
        temperature=0.2,
        response_format={"type": "json_object"},
    )

    assert out == "ok"
    assert client.completions.calls[0]["temperature"] == 0.2
    assert "temperature" not in client.completions.calls[1]
    assert client.completions.calls[1]["model"] == "gpt-5.1"
    assert client.completions.calls[1]["max_completion_tokens"] == 8000
    assert client.completions.calls[1]["response_format"] == {"type": "json_object"}
