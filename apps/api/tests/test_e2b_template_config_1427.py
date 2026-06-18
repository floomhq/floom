"""#1427 - configured E2B templates are selected by runtime kind."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _config(runtime_type: str, *, resources=None):
    from models import WorkerConfig, WorkerRuntime, WorkerTrigger

    return WorkerConfig(
        id=f"{runtime_type}-worker",
        name=f"{runtime_type} Worker",
        trigger=WorkerTrigger(type="manual"),
        runtime=WorkerRuntime(type=runtime_type, command="python run.py"),
        memory=False,
        resources=resources or {},
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


def test_memory_specific_template_overrides_runtime_template(monkeypatch):
    from runner_sandbox.e2b_driver import _e2b_template_for_config

    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_ID", "tpl-python-fast")
    monkeypatch.setenv("WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_2048", "tpl-python-2gb")

    assert _e2b_template_for_config(_config("python311", resources={"memory_mb": 2048})) == "tpl-python-2gb"


def test_worker_template_cache_key_can_select_cached_template(monkeypatch, tmp_path):
    import json

    from runner_sandbox.e2b_driver import _e2b_template_for_run, _worker_template_cache_key

    worker_dir = tmp_path / "worker"
    worker_dir.mkdir()
    (worker_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    config = _config("python311", resources={"memory_mb": 2048})
    cache_key = _worker_template_cache_key(worker_dir, config)
    monkeypatch.setenv("WORKEROS_E2B_TEMPLATE_CACHE_JSON", json.dumps({cache_key: "tpl-worker-cached"}))
    logs: list[tuple[str, str]] = []

    assert _e2b_template_for_run(worker_dir, config, log_fn=lambda msg, level="info": logs.append((level, msg))) == "tpl-worker-cached"
    assert any("cached worker template" in msg for _level, msg in logs)


def test_worker_resources_are_clamped_by_operator_policy(monkeypatch):
    from models import WorkerResources

    monkeypatch.setenv("WORKEROS_MAX_WORKER_MEMORY_MB", "1024")
    monkeypatch.setenv("WORKEROS_MAX_WORKER_CPU_COUNT", "2")

    resources = WorkerResources(memory_mb=4096, cpu_count=8)

    assert resources.memory_mb == 1024
    assert resources.cpu_count == 2


def test_schema_03_accepts_exec_resources_alias():
    from models import parse_worker_manifest, worker_contract_to_worker_config

    contract = parse_worker_manifest(
        {
            "schema_version": "0.3",
            "name": "heavy-worker",
            "title": "Heavy Worker",
            "description": "Loads a large model.",
            "version": "0.1.0",
            "entrypoint": "run.py",
            "exec": {
                "runtime": "python311",
                "runner": "e2b",
                "entry": "run.py",
                "command": "python run.py",
                "resources": {"memory_mb": 2048, "cpu_count": 2},
            },
            "trigger": {"type": "manual"},
        }
    )

    config = worker_contract_to_worker_config(contract, "heavy-worker")

    assert config.resources.memory_mb == 2048
    assert config.resources.cpu_count == 2


def test_node_template_builder_defaults_to_2gb(monkeypatch):
    captured: dict[str, object] = {}

    class FakeTemplate:
        def from_node_image(self, _image):
            return self

        def apt_install(self, _packages):
            return self

        def npm_install(self, _packages):
            return self

        @staticmethod
        def build(_template, **kwargs):
            captured.update(kwargs)
            return {"template_id": "tpl-node"}

    fake_e2b = types.SimpleNamespace(
        Template=FakeTemplate,
        default_build_logger=lambda: None,
    )
    monkeypatch.setitem(sys.modules, "e2b", fake_e2b)
    monkeypatch.delenv("WORKEROS_E2B_TEMPLATE_MEMORY_MB", raising=False)

    module_path = Path(__file__).resolve().parents[3] / "ops" / "e2b" / "node-base" / "template.py"
    spec = importlib.util.spec_from_file_location("node_template_under_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    module.build_template()

    assert captured["memory_mb"] == 2048
    assert captured["cpu_count"] == 2
