#!/usr/bin/env python3
"""Tests for selecting sandbox drivers from worker runtime config."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from models import WorkerConfig, WorkerRuntime, WorkerTrigger  # noqa: E402
from runner_sandbox import SkillRuntimeDriver, get_driver  # noqa: E402
from runner_sandbox.local import LocalSandboxDriver  # noqa: E402
from run_service import _runner_key  # noqa: E402


class RunnerDispatchTest(unittest.TestCase):
    def test_get_driver_selects_skill_for_skill_prefix(self):
        self.assertIsInstance(get_driver("skill"), SkillRuntimeDriver)
        self.assertIsInstance(get_driver("skill.openai"), SkillRuntimeDriver)

    def test_get_driver_keeps_local_code_runtime(self):
        self.assertIsInstance(get_driver("local"), LocalSandboxDriver)

    def test_runner_key_uses_runtime_type_only_for_skill(self):
        skill_config = WorkerConfig(
            id="skill_worker",
            name="Skill Worker",
            trigger=WorkerTrigger(type="manual"),
            runtime=WorkerRuntime(type="skill", entrypoint="SKILL.md", runner="local"),
        )
        code_config = WorkerConfig(
            id="code_worker",
            name="Code Worker",
            trigger=WorkerTrigger(type="manual"),
            runtime=WorkerRuntime(type="python311", entrypoint="run.py", runner="local"),
        )

        self.assertEqual(_runner_key(skill_config), "skill")
        self.assertEqual(_runner_key(code_config), "local")


if __name__ == "__main__":
    unittest.main()
