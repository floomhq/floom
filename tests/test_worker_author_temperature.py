#!/usr/bin/env python3
"""Regression tests for the in-sandbox worker-author OpenAI helper."""

from __future__ import annotations

import copy
import json
import importlib.util
import sys
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
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    client = _FakeClient()
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=lambda **_kwargs: client))

    out = module._codegen_chat(
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


def _script_worker_yml(*, trigger: str = "manual") -> str:
    trigger_block = (
        "trigger:\n  type: \"schedule\"\n  cron: \"0 9 * * *\"\n"
        if trigger == "schedule"
        else "trigger:\n  type: \"manual\"\n"
    )
    return f"""\
schema_version: "0.3"
name: "reverse-string"
title: "Reverse String"
description: "Reverses a text string."
version: "0.1.0"
exec:
  entry: "run.py"
  command: "python run.py"
  runtime: "python311"
  runner: "e2b"
  inputs:
    - name: "text"
      kind: "scalar"
      type: "string"
      required: true
      label: "Text"
  outputs:
    - name: "reversed_text"
      kind: "scalar"
      type: "string"
      required: true
      label: "Reversed Text"
{trigger_block}"""


_FUNCTIONAL_REVERSE_RUN_PY = """\
import json
from pathlib import Path


def main():
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
    text = str(inputs.get("text") or "")
    _write = {"status": "success", "outputs": {"reversed_text": text[::-1]}, "artifacts": [], "error": None}
    Path("result.json").write_text(json.dumps(_write), encoding="utf-8")


if __name__ == "__main__":
    main()
"""


def test_worker_author_rejects_unrequested_schedule_stub():
    module = _load_worker_author_module()
    bundle = {
        "worker_yml": _script_worker_yml(trigger="schedule"),
        "skill_md": None,
        "run_code": (
            "import json\nfrom pathlib import Path\n"
            "result_value = 'replace with the real output'\n"
            "Path('result.json').write_text(json.dumps({'status':'success','outputs':{'result':result_value}}))\n"
        ),
    }

    error = module._validate_generated_bundle(bundle, "Reverse a text string")

    assert error is not None
    assert "schedule" in error


class _QueuedCompletions:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        if not self.payloads:
            raise AssertionError("OpenAI stub exhausted")
        payload = self.payloads.pop(0)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=json.dumps(payload))
                )
            ]
        )


def test_worker_author_retries_until_bundle_has_functional_run_py(monkeypatch, tmp_path):
    module = _load_worker_author_module()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", "gpt-5.1")
    monkeypatch.delenv("WORKEROS_CHAT_MODEL", raising=False)
    monkeypatch.setattr(module, "_read_context_file", lambda *a, **k: "")
    monkeypatch.setattr(module, "_list_context_dir", lambda *a, **k: [])
    monkeypatch.setattr(module, "_read_existing_workers", lambda *a, **k: [])

    first_stub = {
        "worker_yml": _script_worker_yml(trigger="schedule"),
        "skill_md": None,
        "run_code": "result_value = 'replace with the real output'\n",
        "requirements_txt": None,
        "suggested_id": "reverse-string",
        "sample_input_json": "{\"text\":\"abc\"}",
    }
    second_functional = {
        "worker_yml": _script_worker_yml(trigger="manual"),
        "skill_md": None,
        "run_code": _FUNCTIONAL_REVERSE_RUN_PY,
        "requirements_txt": None,
        "suggested_id": "reverse-string",
        "sample_input_json": "{\"text\":\"abc\"}",
    }

    completions = _QueuedCompletions([first_stub, second_functional])

    class _FakeOpenAI:
        def __init__(self, api_key):
            self.chat = SimpleNamespace(completions=completions)

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=_FakeOpenAI))

    out = module.generate_bundle({"prompt": "Reverse a text string", "mode": "draft"})

    assert completions.calls and len(completions.calls) == 2
    assert out["run_code"] == _FUNCTIONAL_REVERSE_RUN_PY
    assert "error" not in out
    import yaml as pyyaml

    repaired = pyyaml.safe_load(out["worker_yml"])
    assert repaired["schema_version"] == "0.3"
    assert repaired["version"] == "0.1.0"


def test_worker_author_repairs_schema_version_and_missing_version(monkeypatch, tmp_path):
    module = _load_worker_author_module()
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("WORKEROS_CODEGEN_MODEL", "gpt-5.1")
    monkeypatch.delenv("WORKEROS_CHAT_MODEL", raising=False)
    monkeypatch.setattr(module, "_read_context_file", lambda *a, **k: "")
    monkeypatch.setattr(module, "_list_context_dir", lambda *a, **k: [])
    monkeypatch.setattr(module, "_read_existing_workers", lambda *a, **k: [])

    bad_yaml = (
        "schema_version: 0.3\n"
        "name: reverse-string\n"
        'title: "Reverse String"\n'
        'description: "Reverses a text string."\n'
        "exec:\n"
        '  entry: "run.py"\n'
        '  command: "python run.py"\n'
        '  runtime: "python311"\n'
        '  runner: "e2b"\n'
        "trigger:\n"
        '  type: "manual"\n'
    )
    payload = {
        "worker_yml": bad_yaml,
        "skill_md": None,
        "run_code": _FUNCTIONAL_REVERSE_RUN_PY,
        "requirements_txt": None,
        "suggested_id": "reverse-string",
        "sample_input_json": "{\"text\":\"abc\"}",
    }

    completions = _QueuedCompletions([payload])

    class _FakeOpenAI:
        def __init__(self, api_key):
            self.chat = SimpleNamespace(completions=completions)

    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=_FakeOpenAI))

    out = module.generate_bundle({"prompt": "Reverse a text string", "mode": "draft"})

    import yaml as pyyaml

    assert completions.calls and len(completions.calls) == 1
    assert "error" not in out
    assert out["worker_yml"]
    raw = pyyaml.safe_load(out["worker_yml"])
    assert raw["schema_version"] == "0.3"
    assert raw["version"] == "0.1.0"
