"""Public Review Pack routes (Search Assistant sample-customer pilot)."""

from __future__ import annotations

from typing import Any, Dict, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from auth import AuthContext, get_auth_context
from db import Repositories, get_repos
from services.context_access import _require_context_for_user
from services.review_pack import (
    load_public_feedback,
    load_public_review_pack,
    mint_review_pack_share_link,
    public_pack_projection,
    record_public_feedback,
    _load_pack_document,
    _pack_file_rel,
    _list_feedback_events,
    aggregate_consensus,
    _pack_id_from_rel,
)
from services.share_links import _revoke_standalone_share_link

review_pack_router = APIRouter()


class ReviewPackFeedbackInput(BaseModel):
    password: Optional[str] = None
    job_id: str = Field(min_length=1, max_length=120)
    candidate_id: str = Field(min_length=1, max_length=120)
    reviewer_key: str = Field(min_length=1, max_length=48)
    reviewer_name: str = Field(min_length=1, max_length=120)
    reviewer_role: Optional[str] = Field(default=None, max_length=120)
    verdict: Literal["interested", "maybe", "pass"]
    note: Optional[str] = Field(default=None, max_length=240)


@review_pack_router.get("/review/public/{token}")
def get_public_review_pack(
    token: str,
    password: Optional[str] = Query(default=None),
) -> Dict[str, Any]:
    return load_public_review_pack(token, password)


@review_pack_router.get("/review/public/{token}/feedback")
def get_public_review_pack_feedback(
    token: str,
    reviewer_key: str = Query(..., min_length=1, max_length=48),
    password: Optional[str] = Query(default=None),
) -> Dict[str, Any]:
    return load_public_feedback(token, reviewer_key, password)


@review_pack_router.post("/review/public/{token}/feedback")
def post_public_review_pack_feedback(
    token: str,
    body: ReviewPackFeedbackInput,
) -> Dict[str, Any]:
    return record_public_feedback(
        token,
        password=body.password,
        job_id=body.job_id,
        candidate_id=body.candidate_id,
        reviewer_key=body.reviewer_key,
        reviewer_name=body.reviewer_name,
        reviewer_role=body.reviewer_role,
        verdict=body.verdict,
        note=body.note,
    )


@review_pack_router.post("/contexts/{name}/review-packs/{pack_id}/share-link")
def create_review_pack_share_link(
    name: str,
    pack_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, str]:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id, repos=repos)
    return mint_review_pack_share_link(
        context_name=safe_name,
        pack_id=pack_id,
        owner_id=auth.user_id,
    )


@review_pack_router.delete("/contexts/{name}/review-packs/{pack_id}/share-link")
def revoke_review_pack_share_link(
    name: str,
    pack_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, bool]:
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id, repos=repos)
    rel = f"review-packs/{pack_id}/pack.json"
    return _revoke_standalone_share_link(
        entity_type="review_pack",
        entity_id=safe_name,
        file_path=rel,
        owner_id=auth.user_id,
    )


@review_pack_router.get("/contexts/{name}/review-packs/{pack_id}")
def get_review_pack_summary(
    name: str,
    pack_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Fede dashboard: pack + vote summary."""
    safe_name, _metadata = _require_context_for_user(name, user_id=auth.user_id, repos=repos)
    rel = f"review-packs/{pack_id}/pack.json"
    pack = _load_pack_document(safe_name, rel)
    resolved_pack_id = str(pack.get("id") or _pack_id_from_rel(rel))
    events = _list_feedback_events(safe_name, resolved_pack_id)
    return {
        "pack": public_pack_projection(pack),
        "consensus": aggregate_consensus(events),
        "vote_count": len(events),
    }
