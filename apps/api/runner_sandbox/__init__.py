"""Sandbox driver dispatch for Workeros.

the operator 2026-05-26: cut the local in-process runner. E2B is the only sandbox.
The malicious-bundle audit landed at 45/100 against the in-process runner
(full host secret exfil, no real timeout, no memory limit, no network egress
enforcement). Rather than reinvent sandboxing in 300+ lines of subprocess +
rlimit + seccomp code, delegate to E2B. ~$15/month for 100 runs/day at 30s
avg, cheaper than Zapier Pro.

Agent-mode workers use AgentDriver (LLM tool loop on the API host).
Pure-script workers run inside E2B.
"""

from .base import SandboxDriver
from .agent_driver import AgentDriver
from .e2b_driver import E2BSandboxDriver
from models import WorkerConfig


def _resolve_mode_from_entry(entry: str | None) -> str | None:
    """Derive execution mode from the entry-point file suffix (PR S11).

    `.md`            -> agent mode (SKILL.md loop with tools via AgentDriver).
    `.py`/`.sh`/`.js`-> pure-script mode (exec the file inside E2B sandbox).
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
    """Return the correct sandbox driver for a worker.

    Routing priority (PR S11):
      1. entrypoint suffix — `.md` -> AgentDriver, `.py/.sh/.js` -> E2BSandboxDriver.
      2. runtime.mode field — `agent` / `pure-script` (backwards compat).
      3. Default: AgentDriver (agent-mode workers are the common case).

    The `runner` parameter is accepted for backwards compat but ignored for
    pure-script dispatch (always E2B).
    """
    if config and config.runtime:
        inferred = _resolve_mode_from_entry(config.runtime.entrypoint)
        mode = inferred or config.runtime.mode or "agent"
        if mode == "agent":
            return AgentDriver()
        if mode != "pure-script":
            raise ValueError(f"Unknown exec mode: {mode!r}. Must be 'agent' or 'pure-script'.")

    return E2BSandboxDriver()


__all__ = [
    "SandboxDriver",
    "AgentDriver",
    "E2BSandboxDriver",
    "get_driver",
]
