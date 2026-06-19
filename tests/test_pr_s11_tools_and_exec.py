"""PR S11 tests: simplified exec.entry model + tools-on-by-default + /system/metrics.

Six test families:
  1. exec.entry: SKILL.md infers agent mode.
  2. exec.entry: run.py infers script mode (.sh / .js variants too).
  3. exec.entry must end in .md/.py/.sh/.js (validation error otherwise).
  4. disable_tools remains compatible when an unavailable tool is named.
  5. Default tools include builtins (list_dir, read_file, etc.).
  6. /system/metrics returns the expected shape and respects x-floom-secret.
"""

import importlib
import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Path / import setup
# ---------------------------------------------------------------------------

API_DIR = Path(__file__).resolve().parents[1] / "apps" / "api"
sys.path.insert(0, str(API_DIR))


def _manifest(exec_block: dict, **extra) -> dict:
    data = {
        "schema_version": "0.3",
        "name": "pr-s11-worker",
        "title": "PR S11 Worker",
        "description": "Test worker for PR S11.",
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


# ---------------------------------------------------------------------------
# Family 1: entry: SKILL.md -> agent mode
# ---------------------------------------------------------------------------

def test_entry_skill_md_infers_agent_mode():
    from models import parse_worker_manifest, WorkerContract

    contract = parse_worker_manifest(
        _manifest({"entry": "SKILL.md", "runtime": "skill"})
    )
    assert isinstance(contract, WorkerContract)
    assert contract.exec.entry == "SKILL.md"
    assert contract.exec.mode == "agent"


def test_entry_skill_md_with_legacy_mode_alias_still_agent():
    """If both entry and mode are present, entry suffix is the source of truth."""
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest({"entry": "SKILL.md", "mode": "agent", "runtime": "skill"})
    )
    assert contract.exec.mode == "agent"


# ---------------------------------------------------------------------------
# Family 2: entry: run.py / .sh / .js -> script mode
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("entry", ["run.py", "run.sh", "main.js", "worker.PY"])
def test_entry_script_suffix_infers_script_mode(entry):
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest(
            {
                "entry": entry,
                "runtime": "python311",
                "command": f"python {entry}",
            }
        )
    )
    assert contract.exec.entry == entry
    assert contract.exec.mode == "pure-script"


def test_entry_run_py_routes_to_e2b_driver():
    from models import parse_worker_manifest, worker_contract_to_worker_config
    from runner_sandbox import get_driver, AgentDriver, E2BSandboxDriver

    contract = parse_worker_manifest(
        _manifest(
            {
                "entry": "run.py",
                "runtime": "python311",
                "command": "python run.py",
            }
        )
    )
    config = worker_contract_to_worker_config(contract, "pr-s11-worker")
    driver = get_driver(config.runtime.runner, config=config)
    assert isinstance(driver, E2BSandboxDriver)
    assert not isinstance(driver, AgentDriver)


def test_entry_skill_md_routes_to_agent_driver():
    from models import parse_worker_manifest, worker_contract_to_worker_config
    from runner_sandbox import get_driver, AgentDriver

    contract = parse_worker_manifest(
        _manifest({"entry": "SKILL.md", "runtime": "skill"})
    )
    config = worker_contract_to_worker_config(contract, "pr-s11-worker")
    driver = get_driver(config.runtime.runner, config=config)
    assert isinstance(driver, AgentDriver)


# ---------------------------------------------------------------------------
# Engine #211: exec.command defaults from exec.entry for script modes when the
# author (often the LLM) omits it, instead of raising a validation error that
# 502s the draft-and-create / draft-from-prompt flow.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "entry,expected_command",
    [
        ("run.py", "python run.py"),
        ("worker.PY", "python worker.PY"),
        ("run.sh", "bash run.sh"),
        ("main.js", "node main.js"),
    ],
)
def test_pure_script_missing_command_defaults_from_entry(entry, expected_command):
    """exec.mode=pure-script + entry + NO command -> command defaulted (no 502)."""
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest({"entry": entry, "mode": "pure-script", "runtime": "python311"})
    )
    assert contract.exec.mode == "pure-script"
    assert contract.exec.command == expected_command


def test_pure_script_missing_command_defaults_without_explicit_mode():
    """entry=run.py alone (mode inferred pure-script) + NO command -> defaulted."""
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest({"entry": "run.py", "runtime": "python311"})
    )
    assert contract.exec.mode == "pure-script"
    assert contract.exec.command == "python run.py"


def test_hybrid_missing_command_defaults_from_entry():
    """Legacy mode=hybrid + entry=run.py + NO command -> normalized + defaulted."""
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest({"entry": "run.py", "mode": "hybrid", "runtime": "python311"})
    )
    # hybrid + .py entry normalizes to pure-script.
    assert contract.exec.mode == "pure-script"
    assert contract.exec.command == "python run.py"


def test_explicit_command_is_preserved_not_overwritten():
    """A provided command must survive untouched."""
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest(
            {"entry": "run.py", "mode": "pure-script", "runtime": "python311",
             "command": "python run.py --flag"}
        )
    )
    assert contract.exec.command == "python run.py --flag"


# ---------------------------------------------------------------------------
# Family 3: invalid entry suffix raises a validation error
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("entry", ["run.txt", "Dockerfile", "config.yml", "data.json", ""])
def test_entry_invalid_suffix_raises(entry):
    from models import parse_worker_manifest

    with pytest.raises(ValidationError):
        parse_worker_manifest(
            _manifest({"entry": entry, "runtime": "python311", "command": "python run.py"})
        )


def test_legacy_mode_only_still_supported_for_backcompat():
    """Manifests without `entry` still parse via the legacy `mode` derivation path."""
    from models import parse_worker_manifest

    contract = parse_worker_manifest(
        _manifest({"mode": "pure-script", "runtime": "python311", "command": "python run.py"})
    )
    assert contract.exec.mode == "pure-script"
    # The validator backfills `entry` so downstream code sees a uniform shape.
    assert contract.exec.entry == "run.py"


# ---------------------------------------------------------------------------
# Family 4 + 5: agent tool list and disable_tools opt-out
# ---------------------------------------------------------------------------

def _agent_driver_tools(disable_tools=None, connections=None):
    """Build a minimal WorkerConfig and call AgentDriver._tool_schemas directly."""
    from models import (
        parse_worker_manifest,
        worker_contract_to_worker_config,
    )
    from runner_sandbox.agent_driver import AgentDriver

    exec_block = {"entry": "SKILL.md", "runtime": "skill"}
    if disable_tools is not None:
        exec_block["disable_tools"] = disable_tools
    manifest = _manifest(exec_block)
    if connections:
        manifest["connections"] = connections
    contract = parse_worker_manifest(manifest)
    config = worker_contract_to_worker_config(contract, "pr-s11-worker")
    driver = AgentDriver()
    return driver._tool_schemas(config)


def _tool_names(tools):
    names = []
    for tool in tools:
        if tool.get("type") and tool["type"] != "function":
            names.append(tool["type"])
        else:
            fn = tool.get("function") or {}
            names.append(fn.get("name"))
    return names


def test_default_tools_include_builtins():
    tools = _agent_driver_tools()
    names = _tool_names(tools)
    assert "list_dir" in names
    assert "read_file" in names
    assert "write_output" in names
    assert "finish_with_outputs" in names
    assert "run_command" in names
    assert "invoke_worker" in names
    assert "log" in names
    assert "web_search" in names


def test_disable_tools_removes_web_search():
    tools = _agent_driver_tools(disable_tools=["web_search"])
    names = _tool_names(tools)
    assert "web_search" not in names
    assert "list_dir" in names
    assert "write_output" in names
    assert "finish_with_outputs" in names


def test_disable_tools_removes_builtin():
    tools = _agent_driver_tools(disable_tools=["run_command"])
    names = _tool_names(tools)
    assert "run_command" not in names
    assert "finish_with_outputs" in names


def test_disable_tools_removes_composio_by_app_slug():
    tools = _agent_driver_tools(disable_tools=["gmail"], connections=["gmail", "slack"])
    names = _tool_names(tools)
    assert "composio__gmail__execute" not in names
    assert "composio__slack__execute" in names


def test_connections_produce_composio_tools_by_default():
    tools = _agent_driver_tools(connections=["gmail"])
    names = _tool_names(tools)
    assert "composio__gmail__execute" in names


# ---------------------------------------------------------------------------
# Family 6: /system/metrics endpoint
# ---------------------------------------------------------------------------

def _load_api(monkeypatch, tmp_path):
    workers_dir = tmp_path / "workers"
    workers_dir.mkdir()
    db_path = tmp_path / "floom.db"
    monkeypatch.setenv("FLOOM_DB", str(db_path))
    monkeypatch.setenv("FLOOM_WORKERS_DIR", str(workers_dir))
    monkeypatch.setenv("FLOOM_SECRET", "test-secret-s11")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    for name in [
        "main",
        "db",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    ]:
        sys.modules.pop(name, None)
    sys.modules["scheduler"] = types.SimpleNamespace(
        start_scheduler=lambda: None,
        stop_scheduler=lambda: None,
    )
    return importlib.import_module("main")


def test_system_metrics_returns_expected_shape(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    resp = client.get(
        "/system/metrics",
        headers={"x-floom-secret": "test-secret-s11"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    expected_keys = {
        "workers_count",
        "runs_total",
        "runs_7d",
        "runs_failed_7d",
        "connections_count",
        "secrets_count",
        "active_triggers",
        "drafts_last_hour",
        "cancel_flag_db_read_errors",
        "uptime_seconds",
    }
    assert set(body.keys()) == expected_keys
    # All counters are non-negative ints.
    for key in expected_keys:
        assert isinstance(body[key], int)
        assert body[key] >= 0


def test_system_metrics_requires_x_floom_secret(monkeypatch, tmp_path):
    main = _load_api(monkeypatch, tmp_path)
    client = TestClient(main.app)
    # No header -> 401.
    resp = client.get("/system/metrics")
    assert resp.status_code == 401, resp.text
    # Wrong header -> 401.
    resp = client.get("/system/metrics", headers={"x-floom-secret": "wrong"})
    assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------------------
# Family bonus: stock workers still parse after the migration
# ---------------------------------------------------------------------------

def test_all_stock_workers_parse_with_new_entry_field():
    """Every committed worker.yml in workers/ must parse under the new schema."""
    import yaml
    from models import parse_worker_manifest, WorkerContract

    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "workers/*/worker.yml"],
        capture_output=True,
        text=True,
        check=True,
    )
    yml_files = [root / line for line in result.stdout.splitlines() if line.strip()]
    assert len(yml_files) >= 5, f"expected stock workers, found {yml_files}"

    for path in yml_files:
        raw = yaml.safe_load(path.read_text())
        contract = parse_worker_manifest(raw)
        assert isinstance(contract, WorkerContract), path
        # Entry is present and matches a known suffix.
        assert contract.exec.entry, f"{path} missing exec.entry"
        assert contract.exec.entry.lower().endswith((".md", ".py", ".sh", ".js")), (
            f"{path} has invalid entry suffix: {contract.exec.entry}"
        )
