"""Drift-guard: email design tokens must stay in sync with globals.css :root.

Parses the :root block of web/app/globals.css (strips comments first, stops
before html.dark) and asserts that each email_tokens constant equals its
mirrored CSS custom property.

Also checks that rendered email HTML contains no stale hex values.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
GLOBALS_CSS = ROOT / "web" / "app" / "globals.css"

# ---------------------------------------------------------------------------
# Import email_tokens directly — no heavy transitive deps required.
# ---------------------------------------------------------------------------
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from apps.api import email_tokens as T  # noqa: E402


# ---------------------------------------------------------------------------
# CSS parsing helpers
# ---------------------------------------------------------------------------

def _load_root_block() -> str:
    """Return only the :root { ... } block from globals.css.

    Steps:
    1. Strip /* */ block comments (comments contain stale hex like #3E6FE0
       and #6B7280 which must not be matched as token values).
    2. Locate the :root { selector and extract text up to its matching closing
       brace, stopping before the html.dark block.
    """
    css = GLOBALS_CSS.read_text(encoding="utf-8")

    # Step 1: strip block comments
    css_no_comments = re.sub(r"/\*.*?\*/", "", css, flags=re.DOTALL)

    # Step 2: find :root { ... } — take everything between the first :root {
    # and its matching closing brace, but stop at html.dark to avoid bleeding
    # into the dark block (which has --accent #5B8DEF).
    root_match = re.search(r":root\s*\{", css_no_comments)
    if not root_match:
        raise AssertionError("globals.css has no :root { block — file structure changed")

    start = root_match.end()
    # Find closing brace at depth 1
    depth = 1
    pos = start
    while pos < len(css_no_comments) and depth > 0:
        ch = css_no_comments[pos]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        pos += 1
    root_block = css_no_comments[start : pos - 1]

    # Extra guard: cut at html.dark if it somehow leaked in
    dark_idx = root_block.find("html.dark")
    if dark_idx != -1:
        root_block = root_block[:dark_idx]

    return root_block


def _parse_var(root_block: str, var_name: str) -> str:
    """Extract the value of a CSS custom property from the :root block.

    Uses an exact match on the property name so e.g. ``--muted`` cannot
    accidentally satisfy ``--muted-text``.  Returns the trimmed value
    (without the trailing semicolon).

    Raises AssertionError if the variable is absent.
    """
    # Match: --var-name: <value>;
    pattern = re.compile(
        r"(?<![a-zA-Z0-9-])" + re.escape(var_name) + r"\s*:\s*([^;]+);",
    )
    match = pattern.search(root_block)
    if not match:
        raise AssertionError(
            f"globals.css :root missing {var_name} — token contract changed"
        )
    return match.group(1).strip()


def _norm(value: str) -> str:
    """Normalize for comparison: collapse whitespace, lowercase hex."""
    v = re.sub(r"\s+", " ", value).strip()
    # Lowercase hex colors: #RRGGBB or rgba(...) hex components
    v = re.sub(r"#([0-9A-Fa-f]{3,8})", lambda m: "#" + m.group(1).lower(), v)
    return v


# ---------------------------------------------------------------------------
# Token parity assertions
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def root_block() -> str:
    return _load_root_block()


def test_bg_app_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--bg-app")
    assert _norm(T.BG_APP) == _norm(css_val), (
        f"BG_APP mismatch: email_tokens={T.BG_APP!r} vs globals.css --bg-app={css_val!r}"
    )


def test_bg_card_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--bg-card")
    assert _norm(T.BG_CARD) == _norm(css_val), (
        f"BG_CARD mismatch: email_tokens={T.BG_CARD!r} vs globals.css --bg-card={css_val!r}"
    )


def test_bg_band_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--bg-2")
    assert _norm(T.BG_BAND) == _norm(css_val), (
        f"BG_BAND mismatch: email_tokens={T.BG_BAND!r} vs globals.css --bg-2={css_val!r}"
    )


def test_ink_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--text-primary")
    assert _norm(T.INK) == _norm(css_val), (
        f"INK mismatch: email_tokens={T.INK!r} vs globals.css --text-primary={css_val!r}"
    )


def test_muted_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--muted-text")
    assert _norm(T.MUTED) == _norm(css_val), (
        f"MUTED mismatch: email_tokens={T.MUTED!r} vs globals.css --muted-text={css_val!r}"
    )


def test_accent_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--accent")
    assert _norm(T.ACCENT) == _norm(css_val), (
        f"ACCENT mismatch: email_tokens={T.ACCENT!r} vs globals.css --accent={css_val!r}"
    )


def test_radius_card_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--radius-card")
    assert _norm(T.RADIUS_CARD) == _norm(css_val), (
        f"RADIUS_CARD mismatch: email_tokens={T.RADIUS_CARD!r} vs globals.css --radius-card={css_val!r}"
    )


def test_radius_button_parity(root_block: str) -> None:
    css_val = _parse_var(root_block, "--radius-button")
    assert _norm(T.RADIUS_BUTTON) == _norm(css_val), (
        f"RADIUS_BUTTON mismatch: email_tokens={T.RADIUS_BUTTON!r} vs globals.css --radius-button={css_val!r}"
    )


# ---------------------------------------------------------------------------
# Regression guard: stale hex values must not appear in rendered email HTML
# ---------------------------------------------------------------------------

def _try_import_builder():
    """Import build_welcome_email; xfail if heavy deps (submodule) are absent."""
    try:
        from apps.api.email_service import build_welcome_email
        return build_welcome_email
    except Exception as exc:
        pytest.xfail(
            f"Cannot import email_service (likely missing engine submodule): {exc}"
        )


def test_rendered_welcome_email_no_stale_hex() -> None:
    """Rendered welcome email HTML must not contain stale drift hex values."""
    build_welcome_email = _try_import_builder()
    email = build_welcome_email(
        to="test@example.com",
        dashboard_url="https://workeros.floom.dev",
    )
    html = email.html

    assert "#3E6FE0" not in html, (
        "Stale hex #3E6FE0 found in rendered welcome email — old accent value leaked in"
    )
    assert "#6B7280" not in html, (
        "Stale hex #6B7280 found in rendered welcome email — old muted text value leaked in"
    )
