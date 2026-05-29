"""Issue #190: parse_worker_manifest must lift top-level inputs/outputs/secrets
into the exec block for schema_version 0.3 manifests.

Workers (and authoring tools) emit schema_version "0.3" with inputs/outputs/
secrets at the TOP level, while the 0.3 WorkerContract requires them under
`exec`. Before the fix they were silently dropped -> UI shows "no inputs".
"""

import os
import sys
import warnings

API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from models import WorkerContract, parse_worker_manifest  # noqa: E402


def _manifest_with_top_level_io() -> dict:
    return {
        "schema_version": "0.3",
        "name": "legacy-shape-worker",
        "title": "Legacy Shape Worker",
        "description": "Emits inputs/outputs/secrets at the top level.",
        "version": "0.1.0",
        "entrypoint": "SKILL.md",
        "targets": ["generic"],
        "inputs": [
            {"name": "topic", "type": "string", "label": "Topic", "required": True},
        ],
        "outputs": [
            {"name": "report", "type": "string", "label": "Report"},
        ],
        "secrets": ["OPENAI_API_KEY"],
        "exec": {
            "runtime": "skill",
            "mode": "agent",
            "runner": "e2b",
            "entrypoint": "SKILL.md",
        },
        "trigger": {"type": "manual"},
    }


def test_top_level_inputs_lifted_into_exec():
    raw = _manifest_with_top_level_io()
    parsed = parse_worker_manifest(raw)
    assert isinstance(parsed, WorkerContract)

    input_names = [f.name for f in parsed.exec.inputs]
    assert "topic" in input_names, "top-level input was dropped"

    output_names = [f.name for f in parsed.exec.outputs]
    assert "report" in output_names, "top-level output was dropped"

    assert "OPENAI_API_KEY" in parsed.exec.secrets, "top-level secret was dropped"


def test_lift_emits_deprecation_warning():
    raw = _manifest_with_top_level_io()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        parse_worker_manifest(raw)
    assert any(issubclass(w.category, DeprecationWarning) for w in caught), (
        "lifting legacy top-level fields should emit a DeprecationWarning"
    )


def test_exec_scoped_fields_are_not_overwritten():
    """If exec already declares a field, the top-level copy must not clobber it."""
    raw = _manifest_with_top_level_io()
    raw["exec"]["inputs"] = [
        {"name": "canonical", "type": "string", "label": "Canonical", "required": True},
    ]
    parsed = parse_worker_manifest(raw)
    input_names = [f.name for f in parsed.exec.inputs]
    assert input_names == ["canonical"], "exec-scoped inputs must win over top-level"


def test_no_warning_when_already_exec_scoped():
    raw = _manifest_with_top_level_io()
    del raw["inputs"]
    del raw["outputs"]
    del raw["secrets"]
    raw["exec"]["inputs"] = [
        {"name": "canonical", "type": "string", "label": "Canonical", "required": True},
    ]
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        parse_worker_manifest(raw)
    assert not any(issubclass(w.category, DeprecationWarning) for w in caught), (
        "no lift means no deprecation warning"
    )
