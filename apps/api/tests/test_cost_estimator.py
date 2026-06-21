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


def _write_transcript(monkeypatch, tmp_path, run_id, rows):
    import json
    import cost as cost_mod
    import runner_utils

    monkeypatch.setattr(runner_utils, "ARTIFACTS_DIR", tmp_path, raising=False)
    monkeypatch.setattr(cost_mod, "ARTIFACTS_DIR", tmp_path, raising=False)
    run_dir = tmp_path / run_id / "outputs"
    run_dir.mkdir(parents=True)
    (run_dir / "transcript.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows), encoding="utf-8"
    )


def test_trace_derived_cost_preferred_over_blended(monkeypatch, tmp_path):
    """Track A: a usage row carrying total_cost_usd (summed per-generation) is
    used verbatim, NOT recomputed from the single blended rate."""
    import cost as cost_mod

    _write_transcript(
        monkeypatch,
        tmp_path,
        "run-derived",
        [
            {"type": "text", "text": "hi"},
            {
                "type": "usage",
                "total_tokens": 1500,
                "input_tokens": 1000,
                "output_tokens": 500,
                "total_cost_usd": 0.0075,
                "generation_count": 2,
            },
        ],
    )
    assert cost_mod.total_tokens_from_transcript("run-derived") == 1500
    assert cost_mod.cost_usd_from_transcript("run-derived") == 0.0075
    # resolved prefers the derived cost (0.0075), not blended (1500 * rate).
    assert cost_mod.resolved_cost_usd_from_transcript("run-derived") == 0.0075


def test_blended_fallback_when_no_derived_cost(monkeypatch, tmp_path):
    """A legacy usage row (total_tokens only) falls back to the blended estimate."""
    import cost as cost_mod

    _write_transcript(
        monkeypatch,
        tmp_path,
        "run-legacy",
        [{"type": "usage", "total_tokens": 1_000_000}],
    )
    assert cost_mod.cost_usd_from_transcript("run-legacy") is None
    assert cost_mod.resolved_cost_usd_from_transcript("run-legacy") == round(
        cost_mod.usd_per_mtok(), 6
    )


def test_resolved_cost_none_for_pure_script(monkeypatch, tmp_path):
    import cost as cost_mod

    assert cost_mod.resolved_cost_usd_from_transcript("no-such-run") is None
