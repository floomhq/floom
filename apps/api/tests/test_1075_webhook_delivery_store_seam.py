"""#1075 — pluggable webhook delivery-receipt store seam.

`_claim_webhook_delivery` delegates to a registered store (cloud: Supabase) when
one is set, else uses the SQLite default. This lets the managed cloud back
inbound-webhook dedup with a durable, atomic, cross-instance store instead of
the ephemeral per-container SQLite table.
"""

from __future__ import annotations

import sys
import uuid
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


class _FakeStore:
    """In-memory atomic claim store: first (source, id) wins, rest are dupes."""

    def __init__(self):
        self.seen: set[tuple[str, str]] = set()
        self.calls: list[tuple[str, str]] = []

    def claim(self, source: str, delivery_id: str) -> bool:
        self.calls.append((source, delivery_id))
        key = (source, delivery_id)
        if key in self.seen:
            return False
        self.seen.add(key)
        return True


@pytest.fixture
def main_mod():
    import main
    yield main
    main.set_webhook_delivery_store(None)  # never leak the override across tests


def test_registered_store_is_used_and_dedupes(main_mod):
    store = _FakeStore()
    main_mod.set_webhook_delivery_store(store)

    assert main_mod._claim_webhook_delivery("github", "delivery-1") is True
    assert main_mod._claim_webhook_delivery("github", "delivery-1") is False  # redelivery
    assert main_mod._claim_webhook_delivery("github", "delivery-2") is True
    assert store.calls == [
        ("github", "delivery-1"),
        ("github", "delivery-1"),
        ("github", "delivery-2"),
    ]


def test_empty_delivery_id_short_circuits_without_touching_store(main_mod):
    store = _FakeStore()
    main_mod.set_webhook_delivery_store(store)
    # No delivery id to dedupe on -> always claim, store never consulted.
    assert main_mod._claim_webhook_delivery("github", "") is True
    assert store.calls == []


def test_clearing_store_falls_back_to_sqlite_default(main_mod):
    main_mod.set_webhook_delivery_store(None)
    # SQLite default still dedupes: first claim wins, immediate redelivery loses.
    # Use a unique id so the assertion is independent of any receipt already in
    # the shared dev DB (the SQLite fallback persists rows; the FakeStore tests
    # above do not touch the DB).
    delivery_id = f"evt-{uuid.uuid4().hex}"
    assert main_mod._claim_webhook_delivery("composio", delivery_id) is True
    assert main_mod._claim_webhook_delivery("composio", delivery_id) is False
