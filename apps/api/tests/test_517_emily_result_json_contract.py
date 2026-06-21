from __future__ import annotations

import sys
import types
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
