#!/usr/bin/env python3
"""Tests for WorkerContract runtime projection used by discovery and DB migration."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import WorkerContract, parse_worker_manifest, worker_contract_to_worker_config  # noqa: E402


class WorkerContractProjectionTest(unittest.TestCase):
    def test_skill_runtime_contract_keeps_runtime_entrypoint_and_optional_command(self):
        raw = yaml.safe_load((ROOT / "workers" / "research_brief" / "worker.yml").read_text())
        parsed = parse_worker_manifest(raw)
        self.assertIsInstance(parsed, WorkerContract)

        config = worker_contract_to_worker_config(parsed, "research_brief")

        self.assertEqual(config.runtime.type, "skill")
        self.assertEqual(config.runtime.entrypoint, "SKILL.md")
        self.assertIsNone(config.runtime.command)
        self.assertEqual(config.outputs[0].name, "brief")

    def test_code_runtime_contract_still_projects_to_local_runner(self):
        raw = yaml.safe_load((ROOT / "workers" / "input_types_test" / "worker.yml").read_text())
        parsed = parse_worker_manifest(raw)
        self.assertIsInstance(parsed, WorkerContract)

        config = worker_contract_to_worker_config(parsed, "input_types_test")

        self.assertEqual(config.runtime.type, "python311")
        self.assertEqual(config.runtime.runner, "local")
        self.assertEqual(config.runtime.entrypoint, "run.py")
        self.assertEqual(config.runtime.command, "python run.py")


if __name__ == "__main__":
    unittest.main()
