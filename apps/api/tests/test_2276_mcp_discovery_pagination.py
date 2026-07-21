"""Regression coverage for scalable MCP discovery tools (#2276)."""

import asyncio

from starlette.requests import Request

import main
from routers import integrations


def _reset_trigger_cache() -> None:
    integrations._trigger_catalog_cache.update({"expires_at": 0.0, "items": None})


def test_triggers_list_default_is_compact_paginated_and_filterable(monkeypatch):
    triggers = [
        {
            "id": "gmail-new-message",
            "name": "New message",
            "description": "New message\nreceived",
            "toolkit": {"slug": "gmail"},
            "config": {"properties": {"mailbox": {"type": "string"}}},
        },
        {
            "id": "slack-new-message",
            "name": "New Slack message",
            "description": "New Slack message",
            "toolkit": {"slug": "slack"},
            "config": {"properties": {"channel": {"type": "string"}}},
        },
        {
            "id": "gmail-new-thread",
            "name": "New thread",
            "description": "New thread",
            "toolkit": {"slug": "gmail"},
            "config": {"properties": {"label": {"type": "string"}}},
        },
    ]
    monkeypatch.setattr("composio_client.list_triggers", lambda: triggers)
    _reset_trigger_cache()

    first = integrations.list_integration_triggers(app="gmail", limit=1, offset=0, verbose=False, auth=None)
    second = integrations.list_integration_triggers(app="gmail", limit=1, offset=1, verbose=False, auth=None)

    assert first == {
        "items": [{
            "id": "gmail-new-message",
            "name": "New message",
            "description": "New message received",
            "toolkit": "gmail",
        }],
        "limit": 1,
        "offset": 0,
        "total_items": 2,
        "next_offset": 1,
    }
    assert second["items"][0]["id"] == "gmail-new-thread"
    assert second["next_offset"] is None
    assert "config" not in first["items"][0]

    verbose = integrations.list_integration_triggers(app="gmail", limit=1, offset=0, verbose=True, auth=None)
    assert verbose["items"][0]["config"]["properties"]["mailbox"]["type"] == "string"


def test_integrations_catalog_reaches_page_two_and_searches(monkeypatch):
    calls = []

    def fake_list_catalog_apps(*, page, limit, search, category):
        calls.append({"page": page, "limit": limit, "search": search, "category": category})
        item = {
            "slug": "notion" if search == "notion" else f"page-{page}",
            "name": "Notion" if search == "notion" else f"Page {page}",
            "logo_url": "https://example.test/logo.png",
            "description": "Known integration",
            "categories": ["productivity"],
            "tools_count": 10,
            "triggers_count": 2,
        }
        return {
            "items": [item],
            "page": page,
            "limit": limit,
            "total_items": 1048 if not search else 1,
            "total_pages": 35 if not search else 1,
            "next_page": page + 1 if not search else None,
            "categories": ["productivity"],
        }

    monkeypatch.setattr("composio_client.list_catalog_apps", fake_list_catalog_apps)
    integrations._catalog_cache.clear()

    page_two = integrations.integrations_catalog(page=2, limit=30, search="", category="", auth=None)
    search = integrations.integrations_catalog(page=1, limit=30, search="notion", category="productivity", auth=None)

    assert page_two.page == 2
    assert page_two.items[0].slug == "page-2"
    assert search.items[0].slug == "notion"
    assert calls == [
        {"page": 2, "limit": 30, "search": "", "category": ""},
        {"page": 1, "limit": 30, "search": "notion", "category": "productivity"},
    ]


def test_mcp_discovery_schemas_and_dispatch_forward_parameters(monkeypatch):
    tools = {tool["name"]: tool for tool in main._MCP_DEFAULT_TOOLS}
    trigger_props = tools["triggers.list"]["inputSchema"]["properties"]
    catalog_props = tools["integrations.catalog"]["inputSchema"]["properties"]
    assert {"app", "limit", "offset", "verbose"} <= trigger_props.keys()
    assert {"page", "limit", "search", "category"} <= catalog_props.keys()

    calls = []

    async def fake_api_call(method, path, request, *, params=None, body=None):
        calls.append((method, path, params))
        return {"items": []}, 200

    monkeypatch.setattr(main, "_api_call", fake_api_call)
    request = Request({"type": "http", "method": "POST", "path": "/mcp-tools/serve", "headers": []})
    auth = main.AuthContext(user_id="owner", role="admin", auth_method="secret", scopes=("admin",))

    asyncio.run(main._mcp_dispatch(
        "triggers.list",
        {"app": "gmail", "limit": 7, "offset": 14, "verbose": True},
        auth,
        None,
        request,
    ))
    asyncio.run(main._mcp_dispatch(
        "integrations.catalog",
        {"page": 2, "limit": 30, "search": "notion", "category": "productivity"},
        auth,
        None,
        request,
    ))

    assert calls == [
        ("GET", "/integrations/triggers", {
            "worker_id": None, "app": "gmail", "limit": 7, "offset": 14, "verbose": True,
        }),
        ("GET", "/integrations/catalog", {
            "page": 2, "limit": 30, "search": "notion", "category": "productivity",
        }),
    ]
