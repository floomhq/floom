"""Tests for the #1007 WhatsApp binding-persistence seam.

A host (workeros-cloud) registers a ``WhatsAppBindingStore`` via
``set_whatsapp_binding_store`` instead of monkeypatching the private
``_whatsapp_*`` helpers.  These tests prove:

  1. when a store is registered the three engine helpers delegate to it;
  2. a reference captured at import time (the way main.py imports
     ``_whatsapp_create_claim``) still delegates — the failure mode that the
     old ``setattr`` rebind could not fix;
  3. store exceptions on the read/reset paths fail soft (return None);
  4. with no store registered the engine falls back to local SQLite.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple

import pytest

import channels.whatsapp as wa
# Capture at import time exactly like apps/api/main.py:18388-18389 does.
from channels.whatsapp import _whatsapp_create_claim as captured_create_claim


class FakeStore:
    """In-memory WhatsAppBindingStore that records calls."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self.info_result: Optional[Tuple[str, str]] = ("user-cloud", "ws-cloud")
        self.reset_result: Optional[str] = "https://cloud/c/reset-token"

    def binding_info(self, wa_id: str) -> Optional[Tuple[str, str]]:
        self.calls.append(("binding_info", (wa_id,)))
        return self.info_result

    def create_claim(self, wa_id: str, profile_name: str = "") -> Dict[str, str]:
        self.calls.append(("create_claim", (wa_id, profile_name)))
        return {
            "wa_id": wa._normalize_whatsapp_wa_id(wa_id),
            "claim_token": "cloud-token",
            "claim_url": "https://cloud/claim",
            "claim_expires_at": "2099-01-01T00:00:00+00:00",
            "status": "pending",
        }

    def reset_to_pending(self, wa_id: str) -> Optional[str]:
        self.calls.append(("reset_to_pending", (wa_id,)))
        return self.reset_result


@pytest.fixture(autouse=True)
def _reset_store():
    """Always clear the registered store so tests never leak into each other."""
    wa.set_whatsapp_binding_store(None)
    try:
        yield
    finally:
        wa.set_whatsapp_binding_store(None)


def test_registered_store_receives_all_three_operations():
    store = FakeStore()
    wa.set_whatsapp_binding_store(store)

    assert wa._whatsapp_binding_info("+49 170 111-1111") == ("user-cloud", "ws-cloud")
    # The user-id-only shim must route through the same store.
    assert wa._whatsapp_binding_user_id("491701111111") == "user-cloud"
    claim = wa._whatsapp_create_claim("491701111111", "Alice")
    assert claim["claim_token"] == "cloud-token"
    assert wa._reset_binding_to_pending("491701111111") == "https://cloud/c/reset-token"

    kinds = [c[0] for c in store.calls]
    assert kinds == ["binding_info", "binding_info", "create_claim", "reset_to_pending"]
    # profile_name is forwarded to the store.
    assert ("create_claim", ("491701111111", "Alice")) in store.calls


def test_import_time_captured_reference_still_delegates():
    """Reproduces the main.py rebind bug: a symbol imported at module load
    must still hit a store registered LATER (resolution is per-call)."""
    store = FakeStore()
    wa.set_whatsapp_binding_store(store)

    result = captured_create_claim("491702222222", "Bob")

    assert result["claim_token"] == "cloud-token"
    assert ("create_claim", ("491702222222", "Bob")) in store.calls


def test_read_path_fails_soft_when_store_raises():
    class Boom(FakeStore):
        def binding_info(self, wa_id: str):
            raise RuntimeError("supabase down")

        def reset_to_pending(self, wa_id: str):
            raise RuntimeError("supabase down")

    wa.set_whatsapp_binding_store(Boom())
    # Reads/resets degrade to None rather than crashing the webhook handler.
    assert wa._whatsapp_binding_info("491701111111") is None
    assert wa._reset_binding_to_pending("491701111111") is None


def test_falls_back_to_local_sqlite_when_unset(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOOM_DB", str(tmp_path / "floom.db"))
    import db

    db.init_db()
    # No store registered (autouse fixture cleared it) -> local SQLite path.
    claim = wa._whatsapp_create_claim("491703333333", "Carol")
    assert claim["status"] == "pending"
    assert claim["claim_token"]  # a real token was minted into SQLite
    assert claim["wa_id"] == "491703333333"
    # A freshly-created claim is pending (not active) -> binding_info is None.
    assert wa._whatsapp_binding_info("491703333333") is None
