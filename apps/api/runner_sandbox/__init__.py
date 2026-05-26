"""Sandbox driver dispatch for Workeros."""

from .base import SandboxDriver
from .local import LocalSandboxDriver
from .e2b_driver import E2BSandboxDriver
from .skill_driver import SkillRuntimeDriver


def get_driver(runner: str) -> SandboxDriver:
    """Return the sandbox driver for the given runner name.

    runner: "local" (default) | "e2b" | "skill*"
    """
    runner = (runner or "local").strip().lower()
    if runner.startswith("skill"):
        return SkillRuntimeDriver()
    if runner == "local":
        return LocalSandboxDriver()
    if runner == "e2b":
        return E2BSandboxDriver()
    raise ValueError(f"Unknown runner: {runner!r}. Must be 'local', 'e2b', or 'skill*'.")


__all__ = ["SandboxDriver", "LocalSandboxDriver", "E2BSandboxDriver", "SkillRuntimeDriver", "get_driver"]
