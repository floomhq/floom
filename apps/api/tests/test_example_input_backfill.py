"""Batch K / G5 FIX 4 — every generated worker ships a runnable sample.

The worker-author LLM unreliably emits example_input. _backfill_example_input
guarantees a runnable "Fill with sample input" by backfilling from the bundle's
sample_input_json when the worker.yml omits it (file inputs included).
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service


def _log(*_a, **_k) -> None:
    return None


def test_backfill_file_input_from_sample_json() -> None:
    yml = "name: t\ninputs:\n- name: csv_data\n  kind: file\n  type: file\n"
    out = run_service._backfill_example_input(yml, '{"csv_data":"name\\nalice\\nbob\\n"}', _log)
    parsed = yaml.safe_load(out)
    assert parsed["example_input"]["csv_data"].startswith("name")


def test_backfill_accepts_dict_sample() -> None:
    yml = "name: t\ninputs:\n- name: text\n  kind: scalar\n  type: string\n"
    out = run_service._backfill_example_input(yml, {"text": "hello"}, _log)
    assert yaml.safe_load(out)["example_input"]["text"] == "hello"


def test_backfill_does_not_overwrite_existing() -> None:
    yml = "name: t\nexample_input:\n  x: \"1\"\n"
    out = run_service._backfill_example_input(yml, '{"x":"2"}', _log)
    assert yaml.safe_load(out)["example_input"]["x"] == "1"


def test_backfill_noop_on_empty_sample() -> None:
    out = run_service._backfill_example_input("name: t\n", "", _log)
    assert "example_input" not in yaml.safe_load(out)
    out2 = run_service._backfill_example_input("name: t\n", None, _log)
    assert "example_input" not in yaml.safe_load(out2)


def test_backfill_noop_on_invalid_yaml() -> None:
    bad = "name: t\n  : : bad"
    # Returns input unchanged (no crash) on parse error.
    out = run_service._backfill_example_input(bad, '{"x":"1"}', _log)
    assert out == bad


def test_backfill_invalid_sample_json_is_noop() -> None:
    yml = "name: t\n"
    out = run_service._backfill_example_input(yml, "{not json", _log)
    assert "example_input" not in yaml.safe_load(out)


def test_synthesize_file_input_csv_from_schema() -> None:
    yml = (
        "name: t\nexec:\n  entry: run.py\n  inputs:\n"
        "  - name: csv_data\n    kind: file\n    media_type: text/csv\n    required: true\n"
    )
    out = run_service._backfill_example_input(yml, None, _log)
    ei = yaml.safe_load(out)["example_input"]
    assert "," in ei["csv_data"]  # a real CSV the UI can upload


def test_synthesize_scalars_from_schema() -> None:
    yml = "name: t\ninputs:\n- name: text\n  type: string\n- name: count\n  type: number\n"
    out = run_service._backfill_example_input(yml, None, _log)
    ei = yaml.safe_load(out)["example_input"]
    assert ei["text"] == "sample"
    assert ei["count"] == 1


def test_synthesize_skips_when_no_inputs() -> None:
    out = run_service._backfill_example_input("name: t\n", None, _log)
    assert "example_input" not in yaml.safe_load(out)
