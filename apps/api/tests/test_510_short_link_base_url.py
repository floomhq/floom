from __future__ import annotations

import sys
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def test_short_link_base_uses_explicit_override(monkeypatch):
    from core.urls import _short_link_base_url

    monkeypatch.setenv("WORKEROS_SHORT_LINK_BASE_URL", "https://shares.example.test/x/")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workeros.floom.dev")

    assert _short_link_base_url() == "https://shares.example.test/x"


def test_short_link_base_falls_back_to_workers_frontend_url(monkeypatch):
    from core.urls import _short_link_base_url

    monkeypatch.delenv("WORKEROS_SHORT_LINK_BASE_URL", raising=False)
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://workeros.floom.dev/")

    assert _short_link_base_url() == "https://workeros.floom.dev/s"


def test_short_link_base_accepts_legacy_frontend_env(monkeypatch):
    from core.urls import _short_link_base_url

    monkeypatch.delenv("WORKEROS_SHORT_LINK_BASE_URL", raising=False)
    monkeypatch.delenv("WORKERS_FRONTEND_URL", raising=False)
    monkeypatch.setenv("WORKEROS_FRONTEND_URL", "https://workers.floom.dev")

    assert _short_link_base_url() == "https://workers.floom.dev/s"
