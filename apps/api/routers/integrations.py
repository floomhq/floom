"""Integration catalog + trigger-catalog proxy routes.

``GET /integrations/catalog`` (paged/searchable Composio app catalog),
``GET /integrations/catalog/{slug}/tools`` (toolkit tools for the Browse modal),
and ``GET /integrations/triggers`` (trigger catalog, cached one hour). Extracted
verbatim from main.py into an APIRouter.

``composio_client`` is imported lazily inside the handlers (the test suites
purge and re-import it between cases; the lazy import resolves the live,
monkeypatched module at call time). The trigger-catalog cache dict/lock are
module state here; main re-exports them, and because tests mutate the dict's
KEYS (never rebind the name) the shared object stays consistent across reloads.
``_raise_composio_unavailable`` is also re-imported by main for the connections
routes still living there.
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from services.composio import _raise_composio_unavailable

logger = logging.getLogger("floom.api")

integrations_router = APIRouter()


class IntegrationCatalogItem(BaseModel):
    slug: str
    name: str
    logo_url: str
    description: str
    categories: List[str]
    tools_count: int = 0
    triggers_count: int = 0


class IntegrationCatalogResponse(BaseModel):
    items: List[IntegrationCatalogItem]
    page: int
    limit: int
    total_items: int
    total_pages: int
    next_page: Optional[int] = None
    categories: List[str] = []




@integrations_router.get("/integrations/catalog", response_model=IntegrationCatalogResponse)
def integrations_catalog(
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    search: str = Query("", max_length=120),
    category: str = Query("", max_length=200),
    # #919: requires a real auth context — without it, any Bearer token or
    # cookie slipped past the shared-secret middleware check and could
    # enumerate the catalog (and burn Composio quota) unauthenticated.
    auth: AuthContext = Depends(get_auth_context),
) -> IntegrationCatalogResponse:
    """Return the integration catalog, with optional comma-separated category OR-filter.

    When ``category`` contains multiple comma-separated slugs, results from each
    slug are fetched separately and merged (union, de-duplicated by app slug).
    """
    from composio_client import ComposioConfigurationError, list_catalog_apps

    # Split comma-separated categories for OR-merge support.
    category_slugs = [s.strip() for s in category.split(",") if s.strip()] if category.strip() else []

    try:
        if len(category_slugs) <= 1:
            # Simple path: single category or no category.
            single_category = category_slugs[0] if category_slugs else ""
            result = list_catalog_apps(
                page=page,
                limit=limit,
                search=search,
                category=single_category,
            )
        else:
            # Multi-category: fetch each slug and merge (de-duplicated by app slug).
            seen: Dict[str, Any] = {}
            first_error: Exception | None = None
            for slug in category_slugs:
                try:
                    partial = list_catalog_apps(
                        page=1,
                        limit=100,
                        search=search,
                        category=slug,
                    )
                    for item in partial.get("items") or []:
                        if item["slug"] not in seen:
                            seen[item["slug"]] = item
                except ComposioConfigurationError:
                    raise
                except Exception:
                    if first_error is None:
                        first_error = sys.exc_info()[1]
                    logger.warning("Failed to fetch category %s from Composio", slug)
            if first_error is not None and not seen:
                raise first_error

            all_items = list(seen.values())
            total_items = len(all_items)
            total_pages = max(1, (total_items + limit - 1) // limit)
            start = (page - 1) * limit
            page_items = all_items[start : start + limit]
            next_page_num = page + 1 if page < total_pages else None
            all_categories = sorted({cat for item in all_items for cat in (item.get("categories") or [])})
            result = {
                "items": page_items,
                "page": page,
                "limit": limit,
                "total_items": total_items,
                "total_pages": total_pages,
                "next_page": next_page_num,
                "categories": all_categories,
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to load Composio catalog")
        _raise_composio_unavailable(exc)
    return IntegrationCatalogResponse(**result)


class CatalogToolItem(BaseModel):
    name: str
    description: str


@integrations_router.get("/integrations/catalog/{slug}/tools", response_model=List[CatalogToolItem])
def integrations_catalog_tools(
    slug: str,
    limit: int = 100,
    # #919: same auth requirement as the catalog listing above.
    auth: AuthContext = Depends(get_auth_context),
) -> List[CatalogToolItem]:
    """Return up to `limit` tools for a Composio toolkit slug, cached 1 h.

    Designed for the Browse catalog tools modal. Default limit raised to 100
    so the modal can show the full tool list (e.g. Gmail has 85+ tools).
    Returns [] when Composio is unreachable so the UI degrades gracefully.
    """
    from composio_client import list_toolkit_tools
    effective_limit = max(1, min(200, limit))
    try:
        items = list_toolkit_tools(slug, limit=effective_limit)
    except Exception as exc:
        logger.warning("Failed to fetch toolkit tools for %s: %s", slug, exc)
        items = []
    return [CatalogToolItem(**item) for item in items]


_trigger_catalog_cache: Dict[str, Any] = {"expires_at": 0.0, "items": None}
_trigger_catalog_lock = threading.Lock()


def _trigger_item_app_slug(item: Dict[str, Any]) -> str:
    """Extract the app/toolkit slug from a Composio trigger catalog item (lowercased)."""
    toolkit = item.get("toolkit") or item.get("app") or {}
    slug = (
        toolkit.get("slug")
        or item.get("toolkit_slug")
        or item.get("app_name")
        or item.get("app")
        or ""
    )
    if isinstance(slug, dict):
        slug = slug.get("slug") or ""
    return str(slug).lower()


@integrations_router.get("/integrations/triggers")
def list_integration_triggers(
    app: Optional[str] = Query(None, description="Filter by app slug (e.g. 'gmail')"),
    auth: AuthContext = Depends(get_auth_context),
):
    """Proxy Composio's trigger catalog, cached for one hour.

    Pass ?app=<slug> to return only triggers for that integration.
    Filtering happens on the cached full catalog so no extra Composio call is
    made per-app — the cache is always populated from the full list.
    """
    now = time.monotonic()
    with _trigger_catalog_lock:
        if _trigger_catalog_cache["items"] is not None and now < _trigger_catalog_cache["expires_at"]:
            items = _trigger_catalog_cache["items"]
            if app:
                app_lower = app.lower()
                items = [
                    item for item in items
                    if _trigger_item_app_slug(item) == app_lower
                ]
            return {"items": items}

    try:
        from composio_client import list_triggers
        items = list_triggers()
    except Exception as exc:
        logger.exception("Failed to fetch Composio trigger catalog")
        _raise_composio_unavailable(exc)

    with _trigger_catalog_lock:
        _trigger_catalog_cache["items"] = items
        _trigger_catalog_cache["expires_at"] = now + 3600

    if app:
        app_lower = app.lower()
        items = [item for item in items if _trigger_item_app_slug(item) == app_lower]
    return {"items": items}
