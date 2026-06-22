"""
Regression tests for runner:local → e2b coercion (#620).

`runner: local` was valid before PR #28 removed the in-process executor.
The field validators on WorkerRuntime and WorkerContractExec must silently
coerce legacy "local" declarations to "e2b" so agents/manifests using the
old value don't create workers that fail every run on prod OSS.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import (
    WorkerContractExec,
    WorkerRuntime,
    is_self_hosted_runner,
    parse_worker_manifest,
    worker_contract_to_worker_config,
)


def _manifest(runner: str) -> dict:
    return {
        "schema_version": "0.3",
        "name": "runner-coerce-test",
        "title": "Runner Coerce Test",
        "description": "Verifies runner coercion.",
        "version": "0.1.0",
        "exec": {
            "command": "python run.py",
            "runtime": "python311",
            "runner": runner,
            "inputs": [],
            "outputs": [],
        },
        "trigger": {"type": "manual"},
    }


class TestWorkerRuntimeValidator:
    def test_local_coerced_to_e2b(self):
        rt = WorkerRuntime(
            type="python311",
            entrypoint="run.py",
            runner="local",
            command="python run.py",
        )
        assert rt.runner == "e2b"

    def test_e2b_unchanged(self):
        rt = WorkerRuntime(
            type="python311",
            entrypoint="run.py",
            runner="e2b",
            command="python run.py",
        )
        assert rt.runner == "e2b"

    def test_self_hosted_runner_declaration_allowed(self):
        rt = WorkerRuntime(
            type="python311",
            entrypoint="run.py",
            runner="self-hosted:gpu-box",
            command="python run.py",
        )
        assert rt.runner == "self-hosted:gpu-box"
        assert is_self_hosted_runner(rt.runner)

    def test_invalid_runner_rejected(self):
        with pytest.raises(ValidationError, match="runner must be 'e2b'"):
            WorkerRuntime(
                type="python311",
                entrypoint="run.py",
                runner="docker",
                command="python run.py",
            )


class TestWorkerContractExecValidator:
    def test_local_coerced_to_e2b(self):
        exc = WorkerContractExec(
            runtime="python311",
            runner="local",
            command="python run.py",
        )
        assert exc.runner == "e2b"

    def test_e2b_unchanged(self):
        exc = WorkerContractExec(
            runtime="python311",
            runner="e2b",
            command="python run.py",
        )
        assert exc.runner == "e2b"

    def test_self_hosted_runner_declaration_allowed(self):
        exc = WorkerContractExec(
            runtime="python311",
            runner="self-hosted",
            command="python run.py",
        )
        assert exc.runner == "self-hosted"
        assert is_self_hosted_runner(exc.runner)

    def test_invalid_runner_rejected(self):
        with pytest.raises(ValidationError, match="runner must be 'e2b'"):
            WorkerContractExec(
                runtime="python311",
                runner="kubernetes",
                command="python run.py",
            )


class TestParseManifestRunnerCoercion:
    def test_manifest_runner_local_coerced(self):
        contract = parse_worker_manifest(_manifest("local"))
        assert contract.exec.runner == "e2b", (
            "runner:local in worker.yml must be coerced to e2b at parse time"
        )

    def test_manifest_runner_e2b_unchanged(self):
        contract = parse_worker_manifest(_manifest("e2b"))
        assert contract.exec.runner == "e2b"

    def test_manifest_runner_self_hosted_preserved(self):
        contract = parse_worker_manifest(_manifest("self-hosted:media"))
        assert contract.exec.runner == "self-hosted:media"
        config = worker_contract_to_worker_config(contract, "runner-coerce-test")
        assert config.runtime.runner == "self-hosted:media"

    def test_worker_config_runner_e2b_after_coercion(self):
        contract = parse_worker_manifest(_manifest("local"))
        config = worker_contract_to_worker_config(contract, "runner-coerce-test")
        assert config.runtime.runner == "e2b", (
            "WorkerConfig produced from a runner:local manifest must have runner=e2b"
        )


def test_self_hosted_runner_fails_fast_before_sandbox_dispatch():
    source = (API_DIR / "run_service.py").read_text(encoding="utf-8")
    source = source[source.index("def execute_run("):]
    assert "is_self_hosted_runner(runner)" in source
    assert "self_hosted_runner_unavailable" in source
    gate = source.index("is_self_hosted_runner(runner)")
    assert gate < source.index("get_secrets_for_worker(worker_id")
    assert gate < source.index("_resolve_connections(worker_id")
    assert gate < source.index("driver = get_sandbox_driver")
