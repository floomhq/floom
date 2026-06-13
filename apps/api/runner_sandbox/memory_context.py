"""Runtime helpers for worker memory packs."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Optional

from contexts import context_dir, set_context_metadata
from models import default_worker_memory_context_name


def memory_enabled(config: Optional[Any]) -> bool:
    memory = getattr(config, "memory", None)
    return bool(getattr(memory, "enabled", False))


def memory_context_name(config: Any) -> str:
    memory = getattr(config, "memory", None)
    configured = getattr(memory, "context", None)
    if configured:
        return str(configured)
    return default_worker_memory_context_name(str(getattr(config, "id", "worker")))


def ensure_memory_context_pack(
    *,
    config: Optional[Any],
    user_id: Optional[str],
    log_fn: Callable[[str, str], None],
) -> str | None:
    if not config or not memory_enabled(config):
        return None

    name = memory_context_name(config)
    root = context_dir(name)
    root.mkdir(parents=True, exist_ok=True)
    memory_file = Path(root) / "MEMORY.md"
    if not memory_file.exists():
        memory_file.write_text("# Worker memory\n\n", encoding="utf-8")
    try:
        set_context_metadata(
            name,
            writeable=True,
            owner_id=user_id,
            sensitive=True,
            category="memory",
        )
    except Exception as exc:  # noqa: BLE001 - metadata failure must not block runs
        log_fn(f"[memory] Failed to update memory metadata for {name!r}: {exc}", "warning")
    log_fn(f"[memory] Memory pack {name!r} ready", "debug")
    return name

