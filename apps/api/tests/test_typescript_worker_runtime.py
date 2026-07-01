"""TypeScript script-worker contract.

TypeScript workers should use the existing Node/E2B execution path. The backend
must not treat a .ts entrypoint as an agent bundle or fall back to Python.
"""

from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _ts_manifest(runtime: str = "node22", *, command: str | None = None) -> dict:
    exec_block = {
        "entry": "run.ts",
        "runtime": runtime,
        "runner": "e2b",
        "inputs": [],
        "outputs": [],
    }
    if command is not None:
        exec_block["command"] = command
    return {
        "schema_version": "0.3",
        "name": "typescript-worker",
        "title": "TypeScript Worker",
        "description": "Runs a TypeScript entrypoint in the Node sandbox.",
        "version": "0.1.0",
        "exec": exec_block,
        "trigger": {"type": "manual"},
    }


def test_typescript_entry_infers_script_mode_and_default_tsx_command():
    from models import parse_worker_manifest, worker_contract_to_worker_config

    contract = parse_worker_manifest(_ts_manifest())
    config = worker_contract_to_worker_config(contract, "typescript-worker")

    assert contract.exec.mode == "pure-script"
    assert contract.exec.command == "npx --yes tsx run.ts"
    assert config.runtime.entrypoint == "run.ts"
    assert config.runtime.command == "npx --yes tsx run.ts"
    assert config.runtime.mode == "pure-script"


def test_typescript_runtime_alias_uses_node_template_bucket(monkeypatch):
    from models import parse_worker_manifest, worker_contract_to_worker_config
    from runner_sandbox.e2b_driver import _e2b_template_for_config

    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", "tpl-python")
    monkeypatch.setenv("WORKEROS_E2B_NODE_TEMPLATE_ID", "tpl-node")

    contract = parse_worker_manifest(_ts_manifest(runtime="typescript"))
    config = worker_contract_to_worker_config(contract, "typescript-worker")

    assert config.runtime.type == "typescript"
    assert _e2b_template_for_config(config) == "tpl-node"


def test_typescript_entry_dispatches_to_e2b_driver():
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger
    from runner_sandbox import E2BSandboxDriver, get_driver

    config = WorkerConfig(
        id="typescript-worker",
        name="TypeScript Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(
            type="node22",
            entrypoint="run.ts",
            command="npx --yes tsx run.ts",
            runner="e2b",
        ),
        memory=False,
        outputs=[],
    )

    assert isinstance(get_driver(config=config), E2BSandboxDriver)

