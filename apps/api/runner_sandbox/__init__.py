"""Sandbox driver dispatch for Workeros — E2B-only execution.

Federico 2026-05-26: cut the local in-process runner. E2B is the only sandbox.
The malicious-bundle audit landed at 45/100 against the in-process runner
(full host secret exfil, no real timeout, no memory limit, no network egress
enforcement). Rather than reinvent sandboxing in 300+ lines of subprocess +
rlimit + seccomp code, delegate to E2B. ~$15/month for 100 runs/day at 30s
avg, cheaper than Zapier Pro.

agent-mode workers use AgentDriver (LLM tool loop, separate concern).
pure-script workers always run inside E2B.
"""

from .base import SandboxDriver
from .agent_driver import AgentDriver
from .e2b_driver import E2BSandboxDriver
from .skill_driver import SkillRuntimeDriver
from models import WorkerConfig


def get_driver(runner: str = "e2b", config: WorkerConfig | None = None) -> SandboxDriver:
    """Return the sandbox driver. Pure-script -> E2B; agent-mode -> AgentDriver.

    Legacy compat: the `runner` parameter is accepted but ignored for pure-script
    (always E2B now). Skill-runtime workers go through SkillRuntimeDriver.
    """
    if config and config.runtime:
        mode = config.runtime.mode or "agent"
        if mode == "agent":
            return AgentDriver()
        if mode != "pure-script":
            raise ValueError(f"Unknown exec mode: {mode!r}. Must be 'agent' or 'pure-script'.")

    # Pure-script: always E2B. The `runner` field is informational only.
    runner = (runner or "e2b").strip().lower()
    if runner.startswith("skill"):
        return SkillRuntimeDriver()
    return E2BSandboxDriver()


__all__ = [
    "SandboxDriver",
    "AgentDriver",
    "E2BSandboxDriver",
    "SkillRuntimeDriver",
    "get_driver",
]
