"""Sandbox driver dispatch for Workeros."""

from .base import SandboxDriver
from .agent_driver import AgentDriver
from .local import LocalSandboxDriver
from .subprocess_driver import SubprocessSandboxDriver
from .e2b_driver import E2BSandboxDriver
from .skill_driver import SkillRuntimeDriver
from models import WorkerConfig


def get_driver(runner: str = "local", config: WorkerConfig | None = None) -> SandboxDriver:
    """Return the sandbox driver for the given runner name.

    Agent-mode workers always use AgentDriver. Pure-script workers use
    runner: "local" (default, subprocess-isolated) | "local-trusted" (in-process,
    legacy) | "e2b" | "skill*".

    Runner routing for pure-script workers:
      - "local"         -> SubprocessSandboxDriver (env-allowlist, resource limits,
                           real timeout, symlink-safe). DEFAULT and RECOMMENDED.
      - "local-trusted" -> LocalSandboxDriver (in-process exec(), full host access,
                           for internal workers that explicitly need it).
      - "e2b"           -> E2BSandboxDriver (fully sandboxed E2B cloud runner).
      - "skill*"        -> SkillRuntimeDriver (LLM-backed skill runner).
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
        # Default: subprocess-based isolated runner with env-allowlist + resource limits
        return SubprocessSandboxDriver()
    if runner == "local-trusted":
        # Legacy in-process runner: use ONLY for workers that explicitly need full host access.
        # No env restriction, no resource limits. Treat as trusted-operator only.
        return LocalSandboxDriver()
    if runner == "e2b":
        return E2BSandboxDriver()
    raise ValueError(
        f"Unknown runner: {runner!r}. Must be 'local', 'local-trusted', 'e2b', or 'skill*'."
    )


__all__ = [
    "SandboxDriver",
    "AgentDriver",
    "LocalSandboxDriver",
    "SubprocessSandboxDriver",
    "E2BSandboxDriver",
    "SkillRuntimeDriver",
    "get_driver",
]
