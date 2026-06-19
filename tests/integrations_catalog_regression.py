#!/usr/bin/env python3
"""Regression checks for the Composio integrations catalog and OAuth start."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import requests
from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

os.environ.setdefault("FLOOM_DB", tempfile.NamedTemporaryFile(prefix="workeros-test-", suffix=".db").name)

from main import app  # noqa: E402


def assert_ok(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    client = TestClient(app)

    catalog = client.get("/integrations/catalog", params={"limit": 100})
    assert_ok(catalog.status_code == 200, catalog.text)
    catalog_data = catalog.json()
    total_items = catalog_data["total_items"]
    assert_ok(total_items >= 100, f"expected >=100 catalog apps, got {total_items}")
    assert_ok(len(catalog_data["items"]) >= 100, f"expected 100 apps on page, got {len(catalog_data['items'])}")
    assert_ok(all(item["slug"] and item["name"] and item["logo_url"] for item in catalog_data["items"]), "catalog item missing slug/name/logo")

    search = client.get("/integrations/catalog", params={"limit": 30, "search": "gmail"})
    assert_ok(search.status_code == 200, search.text)
    search_data = search.json()
    assert_ok(0 < search_data["total_items"] < total_items, f"search did not narrow results: {search_data['total_items']} vs {total_items}")
    assert_ok(any(item["slug"] == "gmail" for item in search_data["items"]), "gmail search did not include Gmail")

    connect = client.post("/connections", json={"app_name": "gmail"})
    assert_ok(connect.status_code == 200, connect.text)
    connect_data = connect.json()
    redirect_url = connect_data["redirect_url"]
    assert_ok(connect_data["composio_connection_id"].startswith("ca_"), "missing Composio connection id")
    assert_ok(redirect_url.startswith("https://backend.composio.dev/"), redirect_url)

    oauth = requests.get(redirect_url, allow_redirects=True, timeout=20)
    assert_ok(oauth.url.startswith("https://accounts.google.com/") or "composio" in oauth.url, oauth.url)

    print(
        "PASS integrations catalog regression: "
        f"total={total_items}, search_total={search_data['total_items']}, oauth_url={oauth.url[:80]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
