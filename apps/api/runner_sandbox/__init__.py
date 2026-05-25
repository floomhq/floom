"""Sandbox driver dispatch for Workeros."""

from .base import SandboxDriver
from .local import LocalSandboxDriver
from .e2b_driver import E2BSandboxDriver


def get_driver(runner: str) -> SandboxDriver:
    """Return the sandbox driver for the given runner name.

    runner: "local" (default) | "e2b"
    """
    runner = (runner or "local").strip().lower()
    if runner == "local":
        return LocalSandboxDriver()
    if runner == "e2b":
        return E2BSandboxDriver()
    raise ValueError(f"Unknown runner: {runner!r}. Must be 'local' or 'e2b'.")


__all__ = ["SandboxDriver", "LocalSandboxDriver", "E2BSandboxDriver", "get_driver"]
