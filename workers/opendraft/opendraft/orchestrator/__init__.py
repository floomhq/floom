"""Adaptive orchestrator for agent pipeline."""

import importlib


def __getattr__(name):
    """Lazy import to avoid circular imports."""
    if name == "engine":
        return importlib.import_module(".engine", __name__)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
