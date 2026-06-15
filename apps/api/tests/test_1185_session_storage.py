"""#1185 — OSS API secret must not be persisted in localStorage.

The fix moves the secret from localStorage to sessionStorage (cleared on
tab/browser close) and migrates any existing localStorage values on read.

This test verifies the component source no longer calls localStorage.setItem
for the secret key and uses sessionStorage.setItem instead.
"""
from __future__ import annotations

import sys
from pathlib import Path


def test_cli_command_panel_uses_session_storage(tmp_path):
    """CliCommandPanel.tsx must use sessionStorage, not localStorage, for the secret."""
    panel = Path(__file__).resolve().parents[2] / "web" / "components" / "CliCommandPanel.tsx"
    assert panel.exists(), f"CliCommandPanel.tsx not found at {panel}"
    src = panel.read_text()

    # Must NOT write the secret to localStorage
    assert "localStorage.setItem" not in src, (
        "#1185 regression: secret is still written to localStorage. "
        "Must use sessionStorage only."
    )
    # Must use sessionStorage for writing
    assert "sessionStorage.setItem" in src, (
        "#1185: sessionStorage.setItem not found — secret is not being stored in sessionStorage."
    )
    # Must also purge legacy localStorage keys on clear
    assert "SECRET_LEGACY_LS_KEYS" in src or "localStorage.removeItem" in src, (
        "#1185: legacy localStorage cleanup is missing."
    )
