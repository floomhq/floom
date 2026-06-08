"""Tests for fixes made during the 2026-06-08 testing session.

Covers:
  #589 — RunStatus.ERROR stale reference caused GET /runs/{id} to 500
  #590 — _run_visible_to_api visibility gap (Emily vs /runs inconsistency)
  #586 — Proxy 502 when backend unreachable
  #591 — PUBLIC_STOCK_WORKER_IDS missing demo workers

Run from repo root:
    cd apps/api && python3 -m pytest tests/test_session_fixes.py -v
"""
from __future__ import annotations

from pathlib import Path

MAIN_PY = Path(__file__).resolve().parents[1] / "main.py"
MAIN_SRC = MAIN_PY.read_text(encoding="utf-8")
MODELS_PY = Path(__file__).resolve().parents[1] / "models.py"
MODELS_SRC = MODELS_PY.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# #589 — RunStatus.ERROR must not be referenced anywhere in main.py
# ---------------------------------------------------------------------------

def test_589_run_status_error_not_referenced():
    """RunStatus.ERROR was removed from the enum but a stale reference in
    get_run caused every GET /runs/{id} call to raise AttributeError → 500.
    Verify the reference is gone."""
    assert "RunStatus.ERROR" not in MAIN_SRC, (
        "RunStatus.ERROR is referenced in main.py but does not exist in the "
        "RunStatus enum. Remove the reference or restore the enum member."
    )


def test_589_run_status_enum_has_no_error_member():
    """The RunStatus enum in models.py must not define an ERROR member."""
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from models import RunStatus
    assert not hasattr(RunStatus, "ERROR"), (
        "RunStatus.ERROR exists in models.py but is not a valid run status. "
        "Remove it or add it back with a real value."
    )


def test_589_terminal_statuses_in_get_run():
    """get_run must compute _terminal_statuses without RunStatus.ERROR."""
    lines = MAIN_SRC.splitlines()
    terminal_lines = [l for l in lines if "_terminal_statuses" in l and "RunStatus." in l]
    assert terminal_lines, "get_run must define _terminal_statuses"
    for line in terminal_lines:
        assert "RunStatus.ERROR" not in line, (
            f"_terminal_statuses still references RunStatus.ERROR: {line!r}"
        )


# ---------------------------------------------------------------------------
# #590 — _run_visible_to_api must use ownership not the hidden-worker filter
# ---------------------------------------------------------------------------

def test_590_run_visible_uses_system_worker_ids():
    """_run_visible_to_api must check _SYSTEM_WORKER_IDS, not the old
    _worker_hidden_from_api pattern, so Emily and /runs are consistent."""
    assert "_SYSTEM_WORKER_IDS" in MAIN_SRC, (
        "_SYSTEM_WORKER_IDS must be defined in main.py to enumerate "
        "background/infra workers whose runs are hidden from /runs"
    )


def test_590_system_worker_ids_contains_expected_workers():
    """Known system workers must be in _SYSTEM_WORKER_IDS."""
    # Find the frozenset definition
    import ast, re
    match = re.search(
        r'_SYSTEM_WORKER_IDS\s*=\s*frozenset\(\{([^}]+)\}\)',
        MAIN_SRC,
        re.DOTALL,
    )
    assert match, "_SYSTEM_WORKER_IDS frozenset definition not found in main.py"
    contents = match.group(1)
    for expected in ("workspace-agent", "worker-author", "slack-listener", "whatsapp-listener"):
        assert expected in contents, (
            f"{expected!r} must be in _SYSTEM_WORKER_IDS — it is a high-volume "
            "background worker whose runs should not flood the /runs list"
        )


def test_590_run_visible_checks_db_ownership():
    """_run_visible_to_api must use _get_db_worker (ownership check), not only
    _get_visible_worker (which applied the hidden-worker filter and caused the
    Emily/UI visibility gap)."""
    # Find the _run_visible_to_api function body
    lines = MAIN_SRC.splitlines()
    start = next(
        (i for i, l in enumerate(lines) if "def _run_visible_to_api" in l), None
    )
    assert start is not None, "_run_visible_to_api not found in main.py"
    # Grab the next 30 lines (function body)
    body = "\n".join(lines[start : start + 30])
    assert "_get_db_worker" in body, (
        "_run_visible_to_api must call _get_db_worker to check ownership "
        "directly, so runs for user-owned non-system workers are visible"
    )
    assert "_SYSTEM_WORKER_IDS" in body, (
        "_run_visible_to_api must gate on _SYSTEM_WORKER_IDS before the "
        "ownership check"
    )


# ---------------------------------------------------------------------------
# #590 — PUBLIC_STOCK_WORKER_IDS must include all demo workers
# ---------------------------------------------------------------------------

def _public_stock_ids_block() -> str:
    """Extract the PUBLIC_STOCK_WORKER_IDS frozenset contents from main.py."""
    lines = MAIN_SRC.splitlines()
    start = next(
        (i for i, l in enumerate(lines)
         if "PUBLIC_STOCK_WORKER_IDS" in l and "=" in l and "not in" not in l),
        None,
    )
    if start is None:
        return ""
    # Collect until the closing parenthesis depth returns to 0
    depth = 0
    contents: list[str] = []
    for line in lines[start:]:
        contents.append(line)
        depth += line.count("(") - line.count(")")
        if depth <= 0 and len(contents) > 1:
            break
    return "\n".join(contents)


def test_590_topic_explainer_is_public():
    """topic-explainer is shipped as a demo worker and must be in
    PUBLIC_STOCK_WORKER_IDS so its runs appear in /runs."""
    block = _public_stock_ids_block()
    assert block, "PUBLIC_STOCK_WORKER_IDS not found in main.py"
    assert "topic-explainer" in block, (
        "topic-explainer is a demo worker committed to the repo but was "
        "missing from PUBLIC_STOCK_WORKER_IDS — its runs were invisible in /runs"
    )


def test_590_kugelaudio_workers_are_public():
    """kugelaudio workers have is_example:true in their worker.yml and must
    be in PUBLIC_STOCK_WORKER_IDS."""
    block = _public_stock_ids_block()
    assert block, "PUBLIC_STOCK_WORKER_IDS not found in main.py"
    for worker in ("kugelaudio-bug-intake", "kugelaudio-meeting-pipeline"):
        assert worker in block, (
            f"{worker!r} has is_example:true in its worker.yml but is missing "
            "from PUBLIC_STOCK_WORKER_IDS"
        )


# ---------------------------------------------------------------------------
# #586 — Proxy route must catch network errors and return 502
# ---------------------------------------------------------------------------

def test_586_proxy_has_try_catch():
    """The proxy route handler must wrap the upstream fetch in a try/except
    so ECONNREFUSED returns a 502 instead of a Next.js 500 crash page."""
    proxy_path = (
        Path(__file__).resolve().parents[2]
        / "web" / "app" / "api" / "proxy" / "[...path]" / "route.ts"
    )
    assert proxy_path.exists(), f"Proxy route not found at {proxy_path}"
    src = proxy_path.read_text(encoding="utf-8")

    assert "try {" in src and "catch" in src, (
        "Proxy route.ts must wrap fetch(upstreamUrl) in a try/catch block"
    )
    assert "502" in src, (
        "Proxy route.ts must return HTTP 502 when the upstream fetch fails"
    )
    assert "Could not reach the API server" in src, (
        "Proxy route.ts must return a human-readable error message on 502"
    )
