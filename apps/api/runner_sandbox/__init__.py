"""Sandbox driver dispatch for Workeros."""

from .base import SandboxDriver
from .agent_driver import AgentDriver
from .local import LocalSandboxDriver
from .e2b_driver import E2BSandboxDriver
<<<<<<< HEAD
from models import WorkerConfig
=======
from .skill_driver import SkillRuntimeDriver
>>>>>>> origin/main


def get_driver(runner: str = "local", config: WorkerConfig | None = None) -> SandboxDriver:
    """Return the sandbox driver for the given runner name.

<<<<<<< HEAD
    Agent-mode workers always use AgentDriver. Pure-script workers use
    runner: "local" (default) | "e2b".
=======
    runner: "local" (default) | "e2b" | "skill*"
>>>>>>> origin/main
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


<<<<<<< HEAD
__all__ = ["SandboxDriver", "AgentDriver", "LocalSandboxDriver", "E2BSandboxDriver", "get_driver"]
=======
__all__ = ["SandboxDriver", "LocalSandboxDriver", "E2BSandboxDriver", "SkillRuntimeDriver", "get_driver"]
>>>>>>> origin/main
