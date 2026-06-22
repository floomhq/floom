from __future__ import annotations

"""Marketplace live layer — reviews, community submissions (moderated), and
hire→run records. Cloud-owned; all DB access uses the Supabase service-role
client (RLS forces service-role-only, see migration 0048). Auth via the engine
AuthContext; admin gated by MARKETPLACE_ADMIN_USER_IDS.

The hire→run provisioning itself reuses the existing engine path
(/api/workers/draft-and-create) from the landing /templates/hire page; this
module only records the hire so cards can show "you've hired this"."""

import asyncio
import logging
import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api.config import get_supabase_service_client

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/marketplace", tags=["marketplace"])

ItemKind = Literal["worker", "workspace"]
Source = Literal["first_party", "community"]


def _is_admin(user_id: str) -> bool:
    ids = {x.strip() for x in os.getenv("MARKETPLACE_ADMIN_USER_IDS", "").split(",") if x.strip()}
    return str(user_id) in ids


async def _db(fn):
    """Run a blocking supabase-py call off the event loop."""
    return await asyncio.to_thread(fn)


# ── reviews ────────────────────────────────────────────────────────────────

class ReviewIn(BaseModel):
    item_kind: ItemKind
    item_slug: str = Field(min_length=1, max_length=200)
    source: Source = "first_party"
    rating: int = Field(ge=1, le=5)
    body: str = Field(min_length=1, max_length=2000)


@router.get("/reviews/summary")
async def reviews_summary(items: str = Query("", description="comma list of kind:source:slug")):
    """Public-safe aggregate: { "worker:first_party:slug": {avg, count} }."""
    keys = [k for k in (items.split(",") if items else []) if k.count(":") == 2]
    if not keys:
        return {}
    sb = get_supabase_service_client()
    rows = await _db(
        lambda: sb.table("marketplace_reviews")
        .select("item_kind,item_slug,source,rating")
        .eq("status", "visible")
        .execute()
    )
    agg: dict[str, dict[str, float]] = {}
    for r in rows.data or []:
        key = f"{r['item_kind']}:{r['source']}:{r['item_slug']}"
        if key not in keys:
            continue
        a = agg.setdefault(key, {"sum": 0.0, "count": 0.0})
        a["sum"] += float(r["rating"])
        a["count"] += 1
    return {
        k: {"avg": round(v["sum"] / v["count"], 1), "count": int(v["count"])}
        for k, v in agg.items()
    }


@router.get("/reviews")
async def list_reviews(
    item_kind: ItemKind,
    item_slug: str,
    source: Source = "first_party",
    limit: int = Query(50, ge=1, le=200),
):
    sb = get_supabase_service_client()
    rows = await _db(
        lambda: sb.table("marketplace_reviews")
        .select("id,rating,body,created_at")
        .eq("item_kind", item_kind)
        .eq("item_slug", item_slug)
        .eq("source", source)
        .eq("status", "visible")
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return {"reviews": rows.data or []}


@router.post("/reviews")
async def create_review(body: ReviewIn, auth: AuthContext = Depends(get_auth_context)):
    sb = get_supabase_service_client()
    row = {
        "item_kind": body.item_kind,
        "item_slug": body.item_slug,
        "source": body.source,
        "user_id": auth.user_id,
        "rating": body.rating,
        "body": body.body,
        "status": "visible",
    }
    res = await _db(
        lambda: sb.table("marketplace_reviews")
        .upsert(row, on_conflict="item_kind,item_slug,source,user_id")
        .execute()
    )
    return {"review": (res.data or [None])[0]}


# ── hire records ─────────────────────────────────────────────────────────

class HireIn(BaseModel):
    item_kind: ItemKind
    item_slug: str = Field(min_length=1, max_length=200)
    source: Source = "first_party"
    worker_ids: list[str] = Field(default_factory=list)
    first_run_ids: list[str] = Field(default_factory=list)
    status: Literal["provisioning", "ready", "failed"] = "ready"
    error: str | None = None


@router.post("/hires")
async def record_hire(body: HireIn, auth: AuthContext = Depends(get_auth_context)):
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        raise HTTPException(status_code=400, detail="no active workspace")
    sb = get_supabase_service_client()
    row = {
        "user_id": auth.user_id,
        "workspace_id": workspace_id,
        "item_kind": body.item_kind,
        "item_slug": body.item_slug,
        "source": body.source,
        "worker_ids": body.worker_ids,
        "first_run_ids": body.first_run_ids,
        "status": body.status,
        "error": body.error,
    }
    res = await _db(
        lambda: sb.table("marketplace_hires")
        .upsert(row, on_conflict="workspace_id,item_kind,item_slug,source")
        .execute()
    )
    return {"hire": (res.data or [None])[0]}


# ── community submissions (moderated) ──────────────────────────────────────

class SubmissionIn(BaseModel):
    item_kind: ItemKind
    title: str = Field(min_length=2, max_length=120)
    slug: str | None = Field(default=None, max_length=200)
    summary: str = Field(min_length=2, max_length=600)
    category: str = Field(min_length=2, max_length=40)
    tools: list[str] = Field(default_factory=list)
    display: dict[str, Any] = Field(default_factory=dict)
    bundle: dict[str, Any] = Field(default_factory=dict)
    source_worker_id: str | None = None


@router.post("/submissions")
async def create_submission(body: SubmissionIn, auth: AuthContext = Depends(get_auth_context)):
    sb = get_supabase_service_client()
    row = {
        "submitter_user_id": auth.user_id,
        "submitter_workspace_id": get_active_workspace_id(),
        "item_kind": body.item_kind,
        "source_worker_id": body.source_worker_id,
        "title": body.title,
        "slug": body.slug,
        "summary": body.summary,
        "category": body.category,
        "tools_json": body.tools,
        "display_json": body.display,
        "bundle_json": body.bundle,
        "status": "pending",
    }
    res = await _db(lambda: sb.table("marketplace_submissions").insert(row).execute())
    return {"submission": (res.data or [None])[0]}


@router.get("/community")
async def list_community(item_kind: ItemKind | None = None):
    """Approved community items, public-safe display payloads only."""
    sb = get_supabase_service_client()

    def q():
        b = (
            sb.table("marketplace_submissions")
            .select("id,item_kind,slug,title,summary,category,tools_json,display_json,published_at")
            .eq("status", "approved")
            .order("published_at", desc=True)
        )
        if item_kind:
            b = b.eq("item_kind", item_kind)
        return b.execute()

    rows = await _db(q)
    return {"items": rows.data or []}


@router.get("/submissions")
async def list_submissions(
    status: str = Query("pending"),
    auth: AuthContext = Depends(get_auth_context),
):
    if not _is_admin(auth.user_id):
        raise HTTPException(status_code=403, detail="not a marketplace moderator")
    sb = get_supabase_service_client()
    rows = await _db(
        lambda: sb.table("marketplace_submissions")
        .select("*")
        .eq("status", status)
        .order("created_at", desc=True)
        .execute()
    )
    return {"submissions": rows.data or []}


class ModerateIn(BaseModel):
    status: Literal["approved", "rejected", "archived"]
    moderator_note: str | None = Field(default=None, max_length=2000)


@router.patch("/submissions/{submission_id}")
async def moderate_submission(
    submission_id: str,
    body: ModerateIn,
    auth: AuthContext = Depends(get_auth_context),
):
    if not _is_admin(auth.user_id):
        raise HTTPException(status_code=403, detail="not a marketplace moderator")
    sb = get_supabase_service_client()
    patch: dict[str, Any] = {
        "status": body.status,
        "moderator_note": body.moderator_note,
        "reviewed_by": auth.user_id,
        "reviewed_at": "now()",
    }
    if body.status == "approved":
        patch["published_at"] = "now()"
    res = await _db(
        lambda: sb.table("marketplace_submissions").update(patch).eq("id", submission_id).execute()
    )
    return {"submission": (res.data or [None])[0]}
