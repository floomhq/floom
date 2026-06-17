"""#1416 - public worker-authoring docs match the script runtime contract."""

from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
API_DIR = REPO_ROOT / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

CANONICAL_DOCS = [
    REPO_ROOT / "docs" / "AUTHORING.md",
    REPO_ROOT / "docs" / "AGENT-COOKBOOK.md",
    REPO_ROOT / "docs" / "SPEC.md",
]


def test_canonical_worker_docs_do_not_advertise_legacy_context_contract():
    combined = "\n".join(path.read_text(encoding="utf-8") for path in CANONICAL_DOCS)

    forbidden = [
        "def run(inputs, context)",
        "run(inputs, context)",
        "context.write_output",
        "context.approve",
        "Each worker exposes a `run(inputs, context)` function",
    ]
    for phrase in forbidden:
        assert phrase not in combined

    assert "inputs.json" in combined
    assert "result.json" in combined


def test_default_run_py_stub_uses_file_protocol_and_executes(tmp_path):
    import services.worker_serialize as worker_serialize
    import services.run_authoring as run_authoring

    stub = worker_serialize._DEFAULT_RUN_PY_STUB
    assert "inputs.json" in stub
    assert "result.json" in stub
    assert "def run(" not in stub
    assert run_authoring._PLACEHOLDER_RUN_PY_MARKER in stub

    ast.parse(stub)
    (tmp_path / "run.py").write_text(stub, encoding="utf-8")
    (tmp_path / "inputs.json").write_text("{}", encoding="utf-8")
    subprocess.run([sys.executable, "run.py"], cwd=tmp_path, check=True, timeout=30)

    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "success"
    assert result["outputs"] == {}
