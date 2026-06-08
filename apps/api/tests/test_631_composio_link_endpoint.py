"""Tests for #631 — Composio /connected_accounts breaking change.

Composio deprecated POST /connected_accounts for managed OAuth auth configs
in June 2026. The new endpoint is POST /connected_accounts/link with a flat
payload shape. composio_client.initiate_connection was using the old endpoint,
causing all OAuth connection flows to return HTTP 400 and surface as
"Unable to reach the integration provider" in the UI.

Run:
    cd apps/api && python -m pytest tests/test_631_composio_link_endpoint.py -v
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

CLIENT_SRC = (API_DIR / "composio_client.py").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Source-level checks — verify the endpoint and payload shape
# ---------------------------------------------------------------------------

def test_631_uses_link_endpoint_not_deprecated():
    """`initiate_connection` must call /connected_accounts/link, not the
    deprecated /connected_accounts endpoint."""
    func_idx = CLIENT_SRC.find("def initiate_connection(")
    func_body = CLIENT_SRC[func_idx: func_idx + 1200]

    assert "/connected_accounts/link" in func_body, (
        "#631: initiate_connection must POST to /connected_accounts/link — "
        "the old /connected_accounts endpoint was deprecated by Composio for "
        "managed OAuth auth configs (June 2026 breaking change)"
    )


def test_631_deprecated_endpoint_not_used():
    """The old /connected_accounts endpoint (without /link) must not be used
    for connection initiation."""
    func_idx = CLIENT_SRC.find("def initiate_connection(")
    func_body = CLIENT_SRC[func_idx: func_idx + 1200]

    # Must not have the bare "/connected_accounts" call (only /connected_accounts/link is OK)
    bare = func_body.replace("/connected_accounts/link", "").replace("/connected_accounts/", "")
    assert '"/connected_accounts"' not in bare and "'/connected_accounts'" not in bare, (
        "#631: the deprecated POST /connected_accounts endpoint must not be called "
        "inside initiate_connection"
    )


def test_631_payload_uses_flat_auth_config_id():
    """New endpoint requires flat `auth_config_id` key, not nested
    `auth_config: {id: ...}` from the old endpoint."""
    func_idx = CLIENT_SRC.find("def initiate_connection(")
    func_body = CLIENT_SRC[func_idx: func_idx + 1200]

    assert '"auth_config_id"' in func_body, (
        "#631: payload must use flat 'auth_config_id' key for the new endpoint, "
        "not the old nested 'auth_config: {\"id\": ...}' shape"
    )
    assert '"auth_config": {' not in func_body, (
        "#631: nested auth_config dict must be removed from initiate_connection payload"
    )


def test_631_payload_uses_redirect_url_not_callback_url():
    """New endpoint uses `redirect_url` field, not `callback_url`."""
    func_idx = CLIENT_SRC.find("def initiate_connection(")
    func_body = CLIENT_SRC[func_idx: func_idx + 1200]

    assert '"redirect_url"' in func_body, (
        "#631: new endpoint expects 'redirect_url' not 'callback_url'"
    )
    assert '"callback_url"' not in func_body, (
        "#631: old 'callback_url' field must be removed from the payload"
    )


# ---------------------------------------------------------------------------
# Functional tests — mock _post and verify correct args are passed
# ---------------------------------------------------------------------------

def test_631_initiate_connection_calls_link_endpoint():
    """initiate_connection must call _post with /connected_accounts/link."""
    import composio_client

    fake_response = {
        "connected_account_id": "ca_test123",
        "redirect_url": "https://connect.composio.dev/link/lk_test",
    }

    with (
        patch.object(composio_client, "_resolve_auth_config_id", return_value="ac_testid"),
        patch.object(composio_client, "_post", return_value=fake_response) as mock_post,
    ):
        result = composio_client.initiate_connection(
            "googlecalendar",
            "http://localhost:3000/connections/callback",
            user_id="test-user",
        )

    mock_post.assert_called_once()
    path, payload = mock_post.call_args[0]
    assert path == "/connected_accounts/link", (
        f"Must POST to /connected_accounts/link, got {path!r}"
    )
    assert payload["auth_config_id"] == "ac_testid"
    assert payload["user_id"] == "test-user"
    assert payload["redirect_url"] == "http://localhost:3000/connections/callback"


def test_631_initiate_connection_returns_correct_fields():
    """Return value must include composio_connection_id and redirect_url."""
    import composio_client

    with (
        patch.object(composio_client, "_resolve_auth_config_id", return_value="ac_testid"),
        patch.object(composio_client, "_post", return_value={
            "connected_account_id": "ca_abc123",
            "redirect_url": "https://connect.composio.dev/link/lk_xyz",
        }),
    ):
        result = composio_client.initiate_connection(
            "googlecalendar", "http://localhost:3000/connections/callback", user_id="u1"
        )

    assert result["composio_connection_id"] == "ca_abc123"
    assert result["redirect_url"] == "https://connect.composio.dev/link/lk_xyz"
