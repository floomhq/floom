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

    def test_code_runtime_contract_projects_to_e2b_runner(self):
        raw = yaml.safe_load(
            """
schema_version: "0.3"
name: script-worker
title: Script Worker
description: Runs a Python script.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs: []
  outputs: []
"""
        )
        parsed = parse_worker_manifest(raw)
        self.assertIsInstance(parsed, WorkerContract)

        config = worker_contract_to_worker_config(parsed, "script-worker")

        self.assertEqual(config.runtime.type, "python311")
        self.assertEqual(config.runtime.runner, "e2b")
        self.assertEqual(config.runtime.entrypoint, "run.py")
        self.assertEqual(config.runtime.command, "python run.py")

    def test_worker_contract_defaults_missing_description_from_title(self):
        raw = yaml.safe_load(
            """
schema_version: "0.3"
name: minimal-script-worker
title: Minimal Script Worker
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs: []
  outputs: []
"""
        )
        parsed = parse_worker_manifest(raw)
        self.assertIsInstance(parsed, WorkerContract)
        self.assertEqual(parsed.description, "Minimal Script Worker")

    def test_worker_contract_projects_contexts(self):
        raw = yaml.safe_load(
            """
schema_version: "0.3"
name: context-worker
title: Context Worker
description: Reads context folders.
version: 0.1.0
exec:
  command: python run.py
  runtime: python311
  runner: e2b
  entry: run.py
  inputs: []
  outputs: []
contexts:
  - knowledge-base
  - name: history
    writeable: true
    source: local
"""
        )
        parsed = parse_worker_manifest(raw)
        self.assertIsInstance(parsed, WorkerContract)

        config = worker_contract_to_worker_config(parsed, "context-worker")

        self.assertEqual(config.contexts[0], "knowledge-base")
        self.assertEqual(config.contexts[1].name, "history")
        self.assertTrue(config.contexts[1].writeable)


if __name__ == "__main__":
    unittest.main()
