"""Public base-URL resolvers (env-driven).

Pure helpers that resolve the externally-visible base URLs for the API, the
frontend, and short links from environment variables, with production defaults.
No application state — safe to import anywhere.

Note: the near-duplicate pairs below (_api_public_base / _public_api_base_url and
_frontend_public_base / _frontend_base_url) are preserved verbatim from main.py;
they read slightly different env-var precedences and have distinct call sites, so
they are intentionally not consolidated here.
"""

from __future__ import annotations

import os


def _short_link_base_url() -> str:
    return (os.environ.get("WORKEROS_SHORT_LINK_BASE_URL") or "http://localhost:3000/s").rstrip("/")


def _public_api_base_url() -> str:
    raw = (
        os.environ.get("WORKEROS_PUBLIC_API_URL")
        or os.environ.get("WORKEROS_API_URL")
        or os.environ.get("WORKERS_API_URL")
        or "http://localhost:8000"
    )
    return raw.rstrip("/")


def _frontend_base_url() -> str:
    return (os.environ.get("WORKERS_FRONTEND_URL") or "http://localhost:3000").rstrip("/")


def _api_public_base() -> str:
    return (os.environ.get("WORKEROS_API_BASE") or "http://localhost:8000").rstrip("/")


def _frontend_public_base() -> str:
    return (os.environ.get("WORKERS_FRONTEND_URL") or "http://localhost:3000").rstrip("/")
