"""Run cost accounting (#793 spend cap, #795 approval cost-so-far).

Tokens are emitted by the agent driver as a ``{"type":"usage","total_tokens":N}``
row in the run's transcript. There is no per-model billing integration, so cost
is an ESTIMATE: tokens x a single blended USD/Mtok rate. The rate is tunable via
``WORKEROS_USD_PER_MTOK`` (default below). Always surface it as an estimate.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

# Blended estimate across input+output for the default gpt-5.x chat models, in
# USD per 1,000,000 tokens. Deliberately a single rate — good enough for budget
# caps and "cost so far" hints, not for billing. Override via env.
_DEFAULT_USD_PER_MTOK = 5.0


def usd_per_mtok() -> float:
    raw = (os.environ.get("WORKEROS_USD_PER_MTOK") or "").strip()
    if raw:
        try:
            return float(raw)
        except ValueError:
            pass
    return _DEFAULT_USD_PER_MTOK


def estimate_cost_usd(total_tokens: Optional[int]) -> float:
    """Rough USD estimate for a token count. 0 when tokens are unknown/zero."""
    if not total_tokens or total_tokens <= 0:
        return 0.0
    return round((float(total_tokens) / 1_000_000.0) * usd_per_mtok(), 6)


def total_tokens_from_transcript(run_id: str) -> Optional[int]:
    """Read the run's transcript artifact and return total_tokens, or None.

    Best-effort: pure-script (non-agent) runs have no transcript / no LLM
    tokens and return None. Never raises.
    """
    row = _usage_row_from_transcript(run_id)
    if row is None:
        return None
    tokens = row.get("total_tokens")
    return int(tokens) if isinstance(tokens, int) else None


def cost_usd_from_transcript(run_id: str) -> Optional[float]:
    """Trace-derived (Track A §A2) per-run cost when the usage row carries a
    summed ``total_cost_usd`` from the AI generations; else None.

    This is the real, model-aware cost summed from each ``$ai_generation``,
    NOT the single blended-rate estimate. Callers fall back to
    ``estimate_cost_usd(total_tokens)`` when this returns None.
    """
    row = _usage_row_from_transcript(run_id)
    if row is None:
        return None
    cost = row.get("total_cost_usd")
    try:
        return round(float(cost), 8) if cost is not None else None
    except (TypeError, ValueError):
        return None


def resolved_cost_usd_from_transcript(run_id: str) -> Optional[float]:
    """Best cost for a run: trace-derived if present, else blended estimate.

    The single source the run-cost persistence + PostHog run events should use
    so they agree. None only when there is no usage at all (pure-script runs).
    """
    derived = cost_usd_from_transcript(run_id)
    if derived is not None:
        return derived
    tokens = total_tokens_from_transcript(run_id)
    if tokens is None:
        return None
    return estimate_cost_usd(tokens)


def _usage_row_from_transcript(run_id: str) -> Optional[dict]:
    """Return the last ``{"type":"usage", ...}`` row from the run transcript.

    Carries ``total_tokens`` and, for agent-mode runs instrumented by Track A,
    ``input_tokens``/``output_tokens``/``total_cost_usd``/``generation_count``.
    Never raises.
    """
    try:
        from runner_utils import ARTIFACTS_DIR

        run_dir = (ARTIFACTS_DIR / run_id).resolve()
        if not str(run_dir).startswith(str(ARTIFACTS_DIR.resolve())):
            return None
        for name in ("outputs/transcript.jsonl", "transcript.jsonl"):
            path = run_dir / name
            if path.is_file():
                return _scan_usage_row(path)
    except Exception:
        return None
    return None


def _scan_usage_row(path: Path) -> Optional[dict]:
    found: Optional[dict] = None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        if isinstance(row, dict) and row.get("type") == "usage" and isinstance(row.get("total_tokens"), int):
            found = row
    return found


def _scan_usage(path: Path) -> Optional[int]:
    """Back-compat: return only total_tokens from the usage row."""
    row = _scan_usage_row(path)
    if row is None:
        return None
    tokens = row.get("total_tokens")
    return int(tokens) if isinstance(tokens, int) else None
