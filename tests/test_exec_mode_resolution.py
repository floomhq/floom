import sys
import subprocess
from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import WorkerContract, parse_worker_manifest, worker_contract_to_worker_config
from runner_sandbox import AgentDriver, E2BSandboxDriver, get_driver


def manifest(exec_block, **extra):
    data = {
        "schema_version": "0.3",
        "name": "mode-test",
        "title": "Mode Test",
        "description": "Validates execution mode resolution.",
        "version": "0.1.0",
        "targets": ["generic"],
        "exec": {
            "inputs": [],
            "secrets": [],
            "outputs": [],
            **exec_block,
        },
        "trigger": {"type": "manual"},
    }
    data.update(extra)
    return data


def test_legacy_python_command_projects_to_pure_script():
    contract = parse_worker_manifest(
        manifest({"command": "python run.py", "runtime": "python311", "runner": "local"})
    )
    assert isinstance(contract, WorkerContract)
    assert contract.exec.mode == "pure-script"
    config = worker_contract_to_worker_config(contract, "mode-test")
    assert config.runtime.mode == "pure-script"
    assert config.runtime.entrypoint == "run.py"
    assert isinstance(get_driver(config.runtime.runner, config=config), E2BSandboxDriver)


def test_missing_mode_defaults_to_agent_without_script_command():
    contract = parse_worker_manifest(manifest({"runtime": "skill", "runner": "local"}))
    assert isinstance(contract, WorkerContract)
    assert contract.exec.mode == "agent"
    config = worker_contract_to_worker_config(contract, "mode-test")
    assert config.runtime.mode == "agent"
    assert isinstance(get_driver(config.runtime.runner, config=config), AgentDriver)


def test_explicit_modes_select_expected_drivers():
    agent_contract = parse_worker_manifest(
        manifest(
            {"mode": "agent", "command": "python run.py", "runtime": "python311", "runner": "local"},
            entrypoint="SKILL.md",
        )
    )
    agent_config = worker_contract_to_worker_config(agent_contract, "agent-test")
    assert isinstance(get_driver(agent_config.runtime.runner, config=agent_config), AgentDriver)

    e2b_contract = parse_worker_manifest(
        manifest(
            {
                "mode": "pure-script",
                "command": "python run.py",
                "runtime": "python311",
                "runner": "e2b",
            }
        )
    )
    e2b_config = worker_contract_to_worker_config(e2b_contract, "e2b-test")
    assert isinstance(get_driver(e2b_config.runtime.runner, config=e2b_config), E2BSandboxDriver)


def test_invalid_runtime_none_combinations_fail():
    with pytest.raises(ValidationError):
        parse_worker_manifest(
            manifest({"mode": "pure-script", "command": "python run.py", "runtime": "none"})
        )

    with pytest.raises(ValidationError):
        parse_worker_manifest(
            manifest({"mode": "agent", "runtime": "none"}, entrypoint="SKILL.md")
        )


def test_pure_script_without_command_defaults_command_engine_211():
    """Engine #211: pure-script with no command no longer raises.

    The legacy mode-only path derives entry=run.py, and the validator now
    defaults exec.command to `python run.py` instead of 502'ing the
    draft-and-create flow.
    """
    contract = parse_worker_manifest(
        manifest({"mode": "pure-script", "runtime": "python311"})
    )
    assert contract.exec.mode == "pure-script"
    assert contract.exec.entry == "run.py"
    assert contract.exec.command == "python run.py"


def test_stock_worker_migration_dispatch_matrix():
    rows = {}
    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "workers/*/worker.yml"],
        capture_output=True,
        text=True,
        check=True,
    )
    for rel_path in result.stdout.splitlines():
        path = ROOT / rel_path
        contract = parse_worker_manifest(yaml.safe_load(path.read_text()))
        assert isinstance(contract, WorkerContract)
        config = worker_contract_to_worker_config(contract, path.parent.name)
        rows[path.parent.name] = (
            contract.exec.mode,
            type(get_driver(config.runtime.runner, config=config)).__name__,
        )

    assert rows["research_brief"] == ("agent", "AgentDriver")
    assert rows["openblog"] == ("pure-script", "E2BSandboxDriver")
    assert rows["opendraft"] == ("pure-script", "E2BSandboxDriver")
    assert rows["csv_enricher"] == ("pure-script", "E2BSandboxDriver")
