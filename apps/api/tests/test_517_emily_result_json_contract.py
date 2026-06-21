from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _stub_codegen(monkeypatch, content: str) -> None:
    llm_mod = types.ModuleType("llm")
    llm_mod.provider_credentials_present = lambda _model: True
    codegen_mod = types.ModuleType("codegen_model")
    codegen_mod.codegen_model = lambda: "test-model"
    codegen_mod.chat_completion_codegen = lambda **_kwargs: SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
    )
    monkeypatch.setitem(sys.modules, "llm", llm_mod)
    monkeypatch.setitem(sys.modules, "codegen_model", codegen_mod)


@dataclass
class _DraftFile:
    path: str
    content: str


def _register_generated_run_py(monkeypatch, tmp_path, run_code: str):
    import services.run_authoring as run_authoring

    worker_yml = """
schema_version: "0.3"
name: result-json-contract-smoke
title: Result JSON Contract Smoke
description: Verifies generated run.py writes result.json.
version: "0.1.0"
trigger:
  type: manual
exec:
  runtime: python311
  entry: run.py
  runner: e2b
  inputs: []
  outputs: []
""".strip()
    bundle_path = tmp_path / "bundle.json"
    bundle_path.write_text(
        json.dumps(
            {
                "worker_yml": worker_yml,
                "run_code": run_code,
                "requirements_txt": "",
            }
        ),
        encoding="utf-8",
    )

    registered: list[list[_DraftFile]] = []
    main_mod = types.ModuleType("main")
    main_mod.DraftFile = _DraftFile

    def _register_worker_from_files(files, **_kwargs):
        registered.append(files)
        return "registered-worker"

    main_mod._register_worker_from_files = _register_worker_from_files
    monkeypatch.setitem(sys.modules, "main", main_mod)
    monkeypatch.setattr(run_authoring, "_find_bundle_artifact", lambda *_args: bundle_path)
    monkeypatch.setattr(run_authoring, "_normalize_authored_worker_yml", lambda worker_yml, _log_fn: worker_yml)
    monkeypatch.setattr(
        run_authoring,
        "_backfill_example_input",
        lambda worker_yml, _sample_input, _log_fn: worker_yml,
    )

    logs: list[tuple[str, str]] = []
    created = run_authoring._register_authored_worker(
        run_id="run_result_contract",
        outputs={},
        artifacts=[],
        user_id="user_1",
        repos=SimpleNamespace(),
        log_fn=lambda message, level="info": logs.append((level, message)),
    )
    return created, registered, logs


def test_initial_registration_rejects_outputs_json(monkeypatch, tmp_path):
    created, registered, logs = _register_generated_run_py(
        monkeypatch,
        tmp_path,
        'from pathlib import Path\nPath("outputs.json").write_text("{}")\n',
    )

    assert created is None
    assert registered == []
    assert any("legacy outputs.json" in message for _level, message in logs)


def test_initial_registration_rejects_output_json(monkeypatch, tmp_path):
    created, registered, logs = _register_generated_run_py(
        monkeypatch,
        tmp_path,
        'from pathlib import Path\nPath("output.json").write_text("{}")\n',
    )

    assert created is None
    assert registered == []
    assert any("legacy output.json" in message for _level, message in logs)


def test_initial_registration_rejects_missing_result_json(monkeypatch, tmp_path):
    created, registered, logs = _register_generated_run_py(
        monkeypatch,
        tmp_path,
        'print({"status": "success", "outputs": {"result": "HI"}})\n',
    )

    assert created is None
    assert registered == []
    assert any("does not write result.json" in message for _level, message in logs)


def test_initial_registration_accepts_result_json(monkeypatch, tmp_path):
    created, registered, logs = _register_generated_run_py(
        monkeypatch,
        tmp_path,
        'from pathlib import Path\nPath("result.json").write_text("{}")\n',
    )

    assert created == "registered-worker"
    assert len(registered) == 1
    assert any(file.path == "run.py" and "result.json" in file.content for file in registered[0])
    assert not any(level == "warning" for level, _message in logs)


def test_repair_rejects_legacy_output_json_filenames(monkeypatch):
    import services.run_authoring as run_authoring

    bad_code = """
import json
output_data = {"result": "HI"}
with open("outputs.json", "w") as f:
    json.dump(output_data, f)
with open("output.json", "w") as f:
    json.dump(output_data, f)
print(json.dumps(output_data))
"""
    logs: list[str] = []

    _stub_codegen(monkeypatch, bad_code)

    fixed = run_authoring._repair_run_py(
        run_code="# placeholder",
        failure="placeholder run.py produced no outputs",
        secrets={},
        log_fn=lambda msg, **_kwargs: logs.append(msg),
        intent="uppercase text",
    )

    assert fixed is None
    assert any("legacy outputs.json" in message for message in logs)


def test_repair_accepts_canonical_result_json(monkeypatch):
    import services.run_authoring as run_authoring

    good_code = """
import json
from pathlib import Path

def main():
    inputs = json.loads(Path("inputs.json").read_text(encoding="utf-8"))
    text = str(inputs.get("text", ""))
    Path("result.json").write_text(json.dumps({
        "status": "success",
        "outputs": {"result": text.upper()},
        "artifacts": [],
        "error": None,
    }), encoding="utf-8")

if __name__ == "__main__":
    main()
"""

    _stub_codegen(monkeypatch, good_code)

    fixed = run_authoring._repair_run_py(
        run_code="# placeholder",
        failure="placeholder run.py produced no outputs",
        secrets={},
        log_fn=lambda *_args, **_kwargs: None,
        intent="uppercase text",
    )

    assert fixed is not None
    assert "result.json" in fixed
    assert "outputs.json" not in fixed
    assert "output.json" not in fixed
