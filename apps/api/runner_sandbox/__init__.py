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


def _resolve_mode_from_entry(entry: str | None) -> str | None:
    """PR S11: derive execution mode from the entry-point file suffix.

    `.md` -> agent mode (SKILL.md loop with tools).
    `.py`, `.sh`, `.js` -> script mode (just exec the file in E2B).
    """
    if not entry:
        return None
    lower = entry.lower()
    if lower.endswith(".md"):
        return "agent"
    if lower.endswith((".py", ".sh", ".js")):
        return "pure-script"
    return None


def get_driver(runner: str = "e2b", config: WorkerConfig | None = None) -> SandboxDriver:
    """Return the sandbox driver. Routes on `entrypoint` suffix (PR S11).

    `entrypoint` ending in `.md` -> AgentDriver. `.py/.sh/.js` -> E2BSandboxDriver.
    Falls back to legacy `mode` field if entrypoint is unset (back-compat).
    Legacy compat: the `runner` parameter is accepted but ignored for pure-script
    (always E2B now). Skill-runtime workers go through SkillRuntimeDriver.
    """
    if config and config.runtime:
        # PR S11: prefer entry-based routing.
        inferred = _resolve_mode_from_entry(config.runtime.entrypoint)
        mode = inferred or config.runtime.mode or "agent"
        if mode == "agent":
            return AgentDriver()
        if mode not in ("pure-script", "hybrid"):
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
