"""Issue #189: /integrations/catalog was ~50% flaky on first load because the
Composio catalog fetch is a single GET with no retry. Cold-start / transient
rate-limit -> "Could not load integrations".

The fetch is now wrapped in a retry-once-after-250ms helper. A first-call
failure followed by a second-call success must yield the catalog, not an error.
"""

import os
import sys
import tempfile
from unittest.mock import patch

API_DIR = os.path.join(os.path.dirname(__file__), "..", "apps", "api")
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

os.environ.setdefault("FLOOM_DB", tempfile.NamedTemporaryFile(suffix=".db", delete=False).name)
os.environ.setdefault("COMPOSIO_API_KEY", "test-composio-key")

import requests  # noqa: E402

import composio_client  # noqa: E402


_GOOD_TOOLKITS = {
    "items": [
        {"slug": "gmail", "name": "Gmail", "meta": {"logo": "https://x/gmail.png"}},
        {"slug": "slack", "name": "Slack", "meta": {"logo": "https://x/slack.png"}},
    ],
    "total_items": 2,
    "total_pages": 1,
    "current_page": 1,
    "next_cursor": None,
}


def _clear_catalog_cache():
    with composio_client._catalog_cache_lock:
        composio_client._catalog_cache.clear()


def test_first_call_fails_second_succeeds_returns_catalog():
    _clear_catalog_cache()
    calls = {"n": 0}

    def fake_get(path, **params):
        calls["n"] += 1
        if calls["n"] == 1:
            raise requests.ConnectionError("cold start / transient")
        return _GOOD_TOOLKITS

    # Avoid actually sleeping 250ms in the test.
    with patch.object(composio_client, "_get", side_effect=fake_get), \
            patch.object(composio_client.time, "sleep") as mock_sleep:
        result = composio_client.list_catalog_apps(page=1, limit=30)

    assert calls["n"] == 2, "fetch must be retried exactly once"
    mock_sleep.assert_called_once_with(composio_client._CATALOG_RETRY_DELAY_SECONDS)
    slugs = [item["slug"] for item in result["items"]]
    assert "gmail" in slugs and "slack" in slugs
    assert result["total_items"] == 2


def test_first_call_succeeds_no_retry():
    _clear_catalog_cache()
    calls = {"n": 0}

    def fake_get(path, **params):
        calls["n"] += 1
        return _GOOD_TOOLKITS

    with patch.object(composio_client, "_get", side_effect=fake_get), \
            patch.object(composio_client.time, "sleep") as mock_sleep:
        result = composio_client.list_catalog_apps(page=1, limit=30)

    assert calls["n"] == 1, "no retry when the first call succeeds"
    mock_sleep.assert_not_called()
    assert result["total_items"] == 2


def test_both_calls_fail_raises():
    _clear_catalog_cache()

    def fake_get(path, **params):
        raise requests.ConnectionError("persistent outage")

    with patch.object(composio_client, "_get", side_effect=fake_get), \
            patch.object(composio_client.time, "sleep"):
        try:
            composio_client.list_catalog_apps(page=1, limit=30)
            raised = False
        except requests.RequestException:
            raised = True

    assert raised, "a persistent failure must still propagate (handler maps to 502)"


def test_catalog_endpoint_recovers_after_one_failure():
    """End-to-end through the FastAPI route: first fetch fails, retry succeeds,
    endpoint returns 200 instead of 502 'Could not load integrations'."""
    _clear_catalog_cache()
    from fastapi.testclient import TestClient
    from main import app

    # #919 made this endpoint require an auth context, so the request now
    # exercises the auth provider. Sibling tests in the full suite leave a
    # cached provider/repositories pair behind that can point at a torn-down
    # DB ("no such table: users" on the dev-mode fallback). Reset both caches
    # and make sure the active FLOOM_DB has its schema.
    import db
    from auth.factory import get_auth_provider

    get_auth_provider.cache_clear()
    db.get_repositories.cache_clear()
    db.init_db()

    # A sibling test/conftest may set FLOOM_SECRET in this process; send the
    # active value so auth passes regardless of whether a secret is configured.
    secret = os.environ.get("FLOOM_SECRET", "")
    headers = {"x-floom-secret": secret} if secret else {}

    calls = {"n": 0}

    def fake_get(path, **params):
        calls["n"] += 1
        if calls["n"] == 1:
            raise requests.ConnectionError("cold start")
        return _GOOD_TOOLKITS

    client = TestClient(app)
    with patch.object(composio_client, "_get", side_effect=fake_get), \
            patch.object(composio_client.time, "sleep"):
        resp = client.get("/integrations/catalog", params={"limit": 30}, headers=headers)

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total_items"] == 2
