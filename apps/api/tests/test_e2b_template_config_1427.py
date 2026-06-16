"""#1427 - configured E2B templates are selected by runtime kind."""

from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _config(runtime_type: str):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    return WorkerConfig(
        id=f"{runtime_type}-worker",
        name=f"{runtime_type} Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type=runtime_type, command="python run.py"),
        memory=False,
        outputs=[],
    )


def test_python_template_id_selected_for_python_workers(monkeypatch):
    from runner_sandbox.e2b_driver import _e2b_template_for_config

    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", "tpl-python-fast")
    monkeypatch.setenv("WORKEROS_E2B_NODE_TEMPLATE_ID", "tpl-node-fast")

    assert _e2b_template_for_config(_config("python311")) == "tpl-python-fast"


def test_node_template_id_selected_for_node_workers(monkeypatch):
    from runner_sandbox.e2b_driver import _e2b_template_for_config

    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", "tpl-python-fast")
    monkeypatch.setenv("WORKEROS_E2B_NODE_TEMPLATE_ID", "tpl-node-fast")

    assert _e2b_template_for_config(_config("node20")) == "tpl-node-fast"


def test_default_template_id_fallback(monkeypatch):
    from runner_sandbox.e2b_driver import _e2b_template_for_config

    monkeypatch.delenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", raising=False)
    monkeypatch.delenv("WORKEROS_E2B_NODE_TEMPLATE_ID", raising=False)
    monkeypatch.setenv("WORKEROS_E2B_DEFAULT_TEMPLATE_ID", "tpl-default")

    assert _e2b_template_for_config(_config("python311")) == "tpl-default"
