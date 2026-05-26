"""Sandbox driver dispatch for Workeros."""

from .base import SandboxDriver
from .agent_driver import AgentDriver
from .local import LocalSandboxDriver
from .e2b_driver import E2BSandboxDriver
from .skill_driver import SkillRuntimeDriver
from models import WorkerConfig


def get_driver(runner: str = "local", config: WorkerConfig | None = None) -> SandboxDriver:
    """Return the sandbox driver for the given runner name.

    Agent-mode workers always use AgentDriver. Pure-script workers use
    runner: "local" (default) | "e2b" | "skill*".
    """
    if config and config.runtime:
        mode = config.runtime.mode or "agent"
        if mode == "agent":
            return AgentDriver()
        if mode != "pure-script":
            raise ValueError(f"Unknown exec mode: {mode!r}. Must be 'agent' or 'pure-script'.")
        runner = config.runtime.runner or runner

    runner = (runner or "local").strip().lower()
    if runner.startswith("skill"):
        return SkillRuntimeDriver()
    if runner == "local":
        return LocalSandboxDriver()
    if runner == "e2b":
        return E2BSandboxDriver()
    raise ValueError(f"Unknown runner: {runner!r}. Must be 'local', 'e2b', or 'skill*'.")


__all__ = [
    "SandboxDriver",
    "AgentDriver",
    "LocalSandboxDriver",
    "E2BSandboxDriver",
    "SkillRuntimeDriver",
    "get_driver",
]
