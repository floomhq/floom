"""#717 — server coerces worker-author YAML so create-from-prompt registers.

The worker-author LLM intermittently emits schema_version as a YAML number
(0.3) instead of "0.3", and omits the required top-level version. Both
hard-fail WorkerContract validation, so POST /workers/new/from-prompt returned
worker_creation_failed=true and registered nothing. _normalize_authored_worker_yml
now coerces numeric schema_version -> string and backfills a default version.

Run: cd apps/api && python -m pytest tests/test_authored_worker_yaml_coercion.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest
import yaml as pyyaml

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture(scope="module")
def run_service():
    return importlib.import_module("run_service")


def _norm(run_service, yml: str) -> dict:
    out = run_service._normalize_authored_worker_yml(yml, lambda *a, **k: None)
    return pyyaml.safe_load(out)


def test_numeric_schema_version_coerced_to_string(run_service):
    yml = (
        "schema_version: 0.3\n"
        'name: "echo"\n'
        'title: "Echo"\n'
        'description: "echoes"\n'
        "version: \"0.1.0\"\n"
    )
    result = _norm(run_service, yml)
    assert result["schema_version"] == "0.3"
    assert isinstance(result["schema_version"], str)


def test_missing_version_backfilled(run_service):
    yml = (
        'schema_version: "0.3"\n'
        'name: "echo"\n'
        'title: "Echo"\n'
        'description: "echoes"\n'
    )
    result = _norm(run_service, yml)
    assert result["version"] == "0.1.0"


def test_both_issues_together(run_service):
    # exactly the #717 repro: numeric schema_version + missing version
    yml = (
        "schema_version: 0.3\n"
        'name: "echo-hello"\n'
        'title: "Echo Hello"\n'
        'description: "A worker that echoes hello"\n'
    )
    result = _norm(run_service, yml)
    assert result["schema_version"] == "0.3"
    assert isinstance(result["schema_version"], str)
    assert result["version"] == "0.1.0"


def test_valid_yaml_unchanged(run_service):
    yml = (
        'schema_version: "0.3"\n'
        'name: "echo"\n'
        'title: "Echo"\n'
        'description: "echoes"\n'
        'version: "2.5.1"\n'
    )
    result = _norm(run_service, yml)
    assert result["schema_version"] == "0.3"
    assert result["version"] == "2.5.1"  # not clobbered


# --- exec.inputs/outputs emitted as a MAPPING instead of a LIST -------------
# The generator (esp. Gemini) intermittently emits exec.inputs/exec.outputs as
# a dict keyed by field name; WorkerContract rejects it with
# "Input should be a valid list" (list_type) and dead-ends create-from-prompt.
# _normalize_authored_worker_yml now coerces the mapping into the list form.

def test_exec_inputs_dict_coerced_to_list(run_service):
    yml = (
        'schema_version: "0.3"\n'
        'name: "upper"\n'
        'title: "Uppercase"\n'
        'description: "uppercases text"\n'
        'version: "0.1.0"\n'
        "exec:\n"
        "  inputs:\n"
        "    text:\n"
        "      type: string\n"
        "  outputs:\n"
        "    uppercased:\n"
        "      type: string\n"
    )
    result = _norm(run_service, yml)
    assert isinstance(result["exec"]["inputs"], list)
    assert isinstance(result["exec"]["outputs"], list)
    assert result["exec"]["inputs"][0]["name"] == "text"
    assert result["exec"]["inputs"][0]["type"] == "string"
    assert result["exec"]["outputs"][0]["name"] == "uppercased"


def test_exec_io_string_shorthand_coerced(run_service):
    # name -> bare type string shorthand, e.g. {text: string}
    yml = (
        'schema_version: "0.3"\n'
        'name: "upper"\n'
        'title: "Uppercase"\n'
        'description: "uppercases text"\n'
        'version: "0.1.0"\n'
        "exec:\n"
        "  inputs:\n"
        "    text: string\n"
        "  outputs:\n"
        "    uppercased: string\n"
    )
    result = _norm(run_service, yml)
    assert isinstance(result["exec"]["inputs"], list)
    inp = result["exec"]["inputs"][0]
    assert inp["name"] == "text" and inp["type"] == "string"


def test_toplevel_inputs_dict_coerced_to_list(run_service):
    yml = (
        'schema_version: "0.3"\n'
        'name: "upper"\n'
        'title: "Uppercase"\n'
        'description: "uppercases text"\n'
        'version: "0.1.0"\n'
        "inputs:\n"
        "  text:\n"
        "    type: string\n"
    )
    result = _norm(run_service, yml)
    assert isinstance(result["inputs"], list)
    assert result["inputs"][0]["name"] == "text"


def test_exec_io_already_list_unchanged(run_service):
    yml = (
        'schema_version: "0.3"\n'
        'name: "upper"\n'
        'title: "Uppercase"\n'
        'description: "uppercases text"\n'
        'version: "0.1.0"\n'
        "exec:\n"
        "  inputs:\n"
        "    - name: text\n"
        "      kind: scalar\n"
        "      type: string\n"
    )
    result = _norm(run_service, yml)
    assert isinstance(result["exec"]["inputs"], list)
    assert result["exec"]["inputs"][0]["name"] == "text"
