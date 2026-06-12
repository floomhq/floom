"""Cost estimator unit tests (#793/#795 foundation)."""
from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from cost import estimate_cost_usd, usd_per_mtok


def test_zero_or_none_tokens_cost_nothing():
    assert estimate_cost_usd(None) == 0.0
    assert estimate_cost_usd(0) == 0.0
    assert estimate_cost_usd(-5) == 0.0


def test_estimate_scales_with_tokens():
    rate = usd_per_mtok()
    assert estimate_cost_usd(1_000_000) == round(rate, 6)
    assert estimate_cost_usd(500_000) == round(rate / 2, 6)


def test_rate_env_override(monkeypatch):
    monkeypatch.setenv("WORKEROS_USD_PER_MTOK", "10")
    assert usd_per_mtok() == 10.0
    assert estimate_cost_usd(1_000_000) == 10.0


def test_transcript_extraction_best_effort(monkeypatch, tmp_path):
    import cost as cost_mod
    from runner_utils import ARTIFACTS_DIR  # noqa

    # missing transcript → None (pure-script run), never raises
    assert cost_mod.total_tokens_from_transcript("nonexistent-run") is None
