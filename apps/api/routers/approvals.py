"""Human-approval routes: run approvals, destructive-action gates, agent-tool
approvals, and the public (signed-link) reviewer surface.

The 12 approval routes — operator list/count, the public review flow
(get/artifact-download/approve/reject + screenshot uploads), the authed
approve/reject of runs, destructive-delete actions, and agent-tool approvals —
with their request/response models, annotation sanitizers, and the approval
serializers (artifact shaping, terminal-status publish, public-link HMAC token,
typed/public approval loaders, destructive-delete executor). Extracted verbatim
from main.py.

Dependency surface is fully services/leaf: services.run_access (run visibility +
artifact serving), services.worker_access (_delete_worker_impl), services.uploads
(_store_uploaded_blob), services.sse_streaming (_sse_publish), core.urls
(_frontend_base_url), core.utils (row_to_dict). db/run_service are imported
lazily inside handlers (purged modules). AuthContext/get_auth_context/get_repos
are route-signature imports; the router is purged in lockstep with main by the
approval test fixtures. main re-exports the route handlers + ApproveRequest/
RejectRequest that chat_service imports.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import (
    APIRouter,
    Body,
    Depends,
    File,
    HTTPException,
    Path,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from core.urls import _frontend_base_url
from core.utils import row_to_dict
from db import Repositories, get_repos
from models import ActionResponse, RunStatus
from services.run_access import (
    _artifact_file_response,
    _get_visible_run,
    _is_sensitive_artifact_row,
)
from services.sse_streaming import _sse_publish
from services.uploads import _store_uploaded_blob
from services.worker_access import _delete_worker_impl

logger = logging.getLogger("floom.api")

approvals_router = APIRouter()

_ANNOTATION_MAX_TEXT_ITEMS = 200
_ANNOTATION_MAX_IMAGE_ITEMS = 30
_ANNOTATION_MAX_PINS_PER_IMAGE = 50
_ANNOTATION_MAX_STR = 8000
_ANNOTATION_MAX_JSON_BYTES = 256 * 1024


def _clean_annotation_str(value: Any, *, limit: int = _ANNOTATION_MAX_STR) -> str:
    if not isinstance(value, str):
        return ""
    # Strip control chars (defense-in-depth — this text is rendered back to the
    # owner) but keep newlines/tabs which are legitimate in a comment.
    cleaned = "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32)
    return cleaned[:limit].strip()


def _safe_annotation_image_url(value: Any) -> Optional[str]:
    """Only accept image refs that point at OUR content-addressed upload store.

    The reviewer can only attach images they uploaded through the approval-scoped
    upload endpoints, which return `/uploads/<sha256>?download_token=...`. We
    refuse arbitrary http(s) URLs so a persisted annotation can never become an
    SSRF vector or an off-site beacon when the owner later views the feedback.
    """
    from files import is_sha256
    if not isinstance(value, str):
        return None
    ref = value.strip()
    if not ref.startswith("/uploads/"):
        return None
    path_part = ref.split("?", 1)[0]
    file_id = path_part[len("/uploads/"):]
    if not is_sha256(file_id):
        return None
    return ref[:_ANNOTATION_MAX_STR]


def _sanitize_annotations(raw: Any) -> Optional[Dict[str, Any]]:
    """Coerce reviewer-supplied annotations into a bounded, safe shape.

    Returns None when there is no usable content (so we don't persist `{}`).
    Shape:
      {"text":  [{"quote", "comment"}],
       "images":[{"url", "caption", "pins":[{"x","y","comment"}]}]}
    """
    if not isinstance(raw, dict):
        return None

    text_out: list[Dict[str, Any]] = []
    for item in (raw.get("text") or [])[:_ANNOTATION_MAX_TEXT_ITEMS]:
        if not isinstance(item, dict):
            continue
        quote = _clean_annotation_str(item.get("quote"))
        comment = _clean_annotation_str(item.get("comment"))
        if not quote and not comment:
            continue
        text_out.append({"quote": quote, "comment": comment})

    images_out: list[Dict[str, Any]] = []
    for item in (raw.get("images") or [])[:_ANNOTATION_MAX_IMAGE_ITEMS]:
        if not isinstance(item, dict):
            continue
        url = _safe_annotation_image_url(item.get("url"))
        if not url:
            continue
        caption = _clean_annotation_str(item.get("caption"))
        pins_out: list[Dict[str, Any]] = []
        for pin in (item.get("pins") or [])[:_ANNOTATION_MAX_PINS_PER_IMAGE]:
            if not isinstance(pin, dict):
                continue
            try:
                x = float(pin.get("x"))
                y = float(pin.get("y"))
            except (TypeError, ValueError):
                continue
            # Pins are normalized 0..1 coordinates over the image.
            x = min(1.0, max(0.0, x))
            y = min(1.0, max(0.0, y))
            pins_out.append({
                "x": round(x, 4),
                "y": round(y, 4),
                "comment": _clean_annotation_str(pin.get("comment")),
            })
        images_out.append({"url": url, "caption": caption, "pins": pins_out})

    if not text_out and not images_out:
        return None
    return {"text": text_out, "images": images_out}


def _annotations_json_or_none(raw: Any) -> Optional[str]:
    """Sanitize + serialize annotations to a JSON string, or None.

    Enforces a hard byte ceiling on the serialized blob as a final backstop.
    """
    sanitized = _sanitize_annotations(raw)
    if sanitized is None:
        return None
    encoded = json.dumps(sanitized, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _ANNOTATION_MAX_JSON_BYTES:
        raise HTTPException(status_code=400, detail="Annotations payload is too large")
    return encoded


class ApproveRequest(BaseModel):
    edited_output: Optional[Dict[str, Any]] = None
    annotations: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None  # #769: optional plain-text approve comment


class RejectRequest(BaseModel):
    reason: Optional[str] = None
    annotations: Optional[Dict[str, Any]] = None


@approvals_router.get("/approvals")
def list_approvals(
    status: Optional[str] = Query(None, description="Filter by status (default: pending)"),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """List approval requests for the authenticated user."""
    from db import get_db
    status_filter = (status or "pending").lower()
    if status_filter == "pending":
        rows = repos.approvals.list_pending(owner_id=auth.user_id)
    else:
        # For non-pending statuses, query directly
        with get_db() as conn:
            rows = [
                dict(row)
                for row in conn.execute(
                    """
                    SELECT a.*, w.name AS worker_name
                    FROM approvals a
                    LEFT JOIN workers w ON w.id = a.worker_id
                    WHERE a.owner_id = ? AND a.status = ?
                    ORDER BY a.created_at DESC
                    """,
                    (auth.user_id, status_filter),
                ).fetchall()
            ]
    return [_approval_response(dict(row), repos) for row in rows]


@approvals_router.get("/approvals/count")
def count_pending_approvals(
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Return count of pending approvals for the authenticated user."""
    count = repos.approvals.count_pending(owner_id=auth.user_id)
    return {"pending": count}


def _approval_artifacts_for_response(
    approval: Dict[str, Any],
    repos: Repositories,
) -> list[Dict[str, Any]]:
    owner_id = str(approval.get("owner_id") or "")
    run_id = str(approval.get("run_id") or "")
    if not owner_id or not run_id:
        return []
    try:
        rows = repos.runs.list_artifacts(user_id=owner_id, run_id=run_id)
    except Exception:
        logger.exception("Failed to load approval artifacts for run %s", run_id)
        return []
    artifacts: list[Dict[str, Any]] = []
    for row in rows:
        if _is_sensitive_artifact_row(row):
            continue
        art = row_to_dict(row)
        artifacts.append(
            {
                "id": art.get("id"),
                "run_id": art.get("run_id"),
                "name": art.get("name"),
                "type": art.get("type"),
                "path": art.get("path"),
                "relative_path": art.get("relative_path"),
                "size_bytes": art.get("size_bytes"),
                "created_at": art.get("created_at"),
            }
        )
    return artifacts


def _approval_response(
    approval: Dict[str, Any],
    repos: Repositories,
) -> Dict[str, Any]:
    response = dict(approval)
    response["artifacts"] = _approval_artifacts_for_response(response, repos)
    # X4: surface the structured reviewer feedback (highlight+comment / screenshot
    # pins) as a parsed object so the owner sees it on the run/approval, not just
    # the free-text reason. The raw JSON column is dropped from the response.
    raw_annotations = response.pop("annotations_json", None)
    parsed_annotations: Optional[Dict[str, Any]] = None
    if raw_annotations:
        try:
            parsed_annotations = json.loads(raw_annotations)
        except Exception:
            parsed_annotations = None
    response["annotations"] = parsed_annotations
    # #792: surface the typed preview payload as a parsed object (email/records/
    # tasks) so the UI can render a rich preview; drop the raw JSON column.
    raw_preview_payload = response.pop("preview_payload_json", None)
    parsed_preview_payload: Optional[Any] = None
    if raw_preview_payload:
        try:
            parsed_preview_payload = json.loads(raw_preview_payload)
        except Exception:
            parsed_preview_payload = None
    response["preview_payload"] = parsed_preview_payload
    # expires_at (#798) + preview_type (#792) pass through from the row as-is.
    # Standalone share/review link for the authenticated owner. The token is the
    # same deterministic HMAC the /approvals/public/* routes verify, so the owner
    # can copy this URL to open the approval full-page (no app chrome) or share it
    # with an external approver. Mirrors the chat tool's `link` field.
    response["public_link"] = (
        f"{_frontend_base_url()}/approvals/review"
        f"?id={response.get('id')}&token={_approval_public_token(dict(approval))}"
    )
    return response


def _publish_approval_terminal_status(
    run_id: str,
    decision: str,
    user_id: str,
    repos: Repositories,
    *,
    follow_up_run_id: str | None = None,
) -> None:
    """Publish a terminal `status` SSE event for an approve/reject decision.

    The original run has just transitioned off PENDING_APPROVAL to COMPLETED.
    Live SSE consumers (the run page) track `type:"status"` events; the
    `approval_decided` event alone does not move their status, so without this
    the UI would never observe the run leaving pending_approval.
    """
    completed_at: str | None = None
    try:
        run_row = repos.runs.get(user_id=user_id, run_id=run_id)
        if run_row is not None:
            completed_at = row_to_dict(run_row).get("completed_at")
    except Exception:
        completed_at = None
    event: Dict[str, Any] = {
        "type": "status",
        "run_id": run_id,
        "status": decision,
        "completed_at": completed_at,
    }
    if follow_up_run_id is not None:
        event["follow_up_run_id"] = follow_up_run_id
    _sse_publish(run_id, event)


def _approval_public_payload(approval: Dict[str, Any]) -> str:
    return ".".join(
        str(approval.get(key) or "")
        for key in ("id", "run_id", "owner_id")
    )


def _approval_public_token(approval: Dict[str, Any]) -> str:
    # #998: never sign/verify a public share token with a public constant —
    # a missing secret would let anyone forge share links. Fail closed.
    secret = (os.environ.get("FLOOM_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Server signing secret not configured")
    return hmac.new(
        secret.encode("utf-8"),
        _approval_public_payload(approval).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


# F3 (2026-06-03): the public approval endpoints must NOT leak which approval
# ids exist. Returning 404 for "no such approval" but 401 for "exists but bad
# token" is an existence oracle: an attacker can enumerate valid approval ids by
# diffing the status codes. We return the SAME response for both — a missing
# approval and a present-but-wrong-token approval are indistinguishable. We also
# always run an HMAC comparison (against a dummy expected value when the row is
# missing) so the two paths do roughly the same work and don't open a coarse
# timing oracle either.
_PUBLIC_APPROVAL_DENIED = HTTPException(
    status_code=401, detail="Invalid or expired approval link"
)


def _load_public_approval(
    approval_id: str,
    token: str,
    repos: Repositories,
) -> Dict[str, Any]:
    approval = repos.approvals.get_public(approval_id=approval_id)
    if approval is None:
        # Burn an equivalent HMAC compare so a missing approval and a
        # present-but-wrong-token approval are indistinguishable (no oracle).
        hmac.compare_digest(token or "", "0" * 64)
        raise _PUBLIC_APPROVAL_DENIED
    expected = _approval_public_token(dict(approval))
    if not token or not hmac.compare_digest(token, expected):
        # Identical response to the not-found case — no existence oracle.
        raise _PUBLIC_APPROVAL_DENIED
    return dict(approval)


def _public_approval_response(approval: Dict[str, Any], repos: Repositories) -> Dict[str, Any]:
    public = _approval_response(approval, repos)
    public.pop("owner_id", None)
    # The owner-only share link (and its token) is not echoed back to external
    # signed-link approvers — they already hold the token they arrived with.
    public.pop("public_link", None)
    return public




class PublicApprovalDecisionRequest(BaseModel):
    reason: str | None = None
    edited_output: Dict[str, Any] | None = None
    annotations: Dict[str, Any] | None = None


@approvals_router.get("/approvals/public/{approval_id}")
def get_public_approval(
    approval_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
):
    """Return one approval for a signed standalone review link."""
    approval = _load_public_approval(approval_id, token, repos)
    return _public_approval_response(approval, repos)


@approvals_router.get("/approvals/public/{approval_id}/artifacts/{artifact_id}/download")
def download_public_approval_artifact(
    approval_id: str,
    artifact_id: str,
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
):
    """Download a non-sensitive run artifact from a signed standalone approval link."""
    approval = _load_public_approval(approval_id, token, repos)
    owner_id = str(approval.get("owner_id") or "")
    run_id = str(approval.get("run_id") or "")
    row = next(
        (
            artifact
            for artifact in repos.runs.list_artifacts(user_id=owner_id, run_id=run_id)
            if artifact["id"] == artifact_id
        ),
        None,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return _artifact_file_response(row)


@approvals_router.post("/approvals/public/{approval_id}/approve", response_model=ActionResponse)
def approve_public_approval(
    approval_id: str,
    body: PublicApprovalDecisionRequest = Body(default_factory=PublicApprovalDecisionRequest),
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Approve from a signed standalone link without requiring app navigation."""
    approval = _load_public_approval(approval_id, token, repos)
    auth = AuthContext(user_id=str(approval["owner_id"]), email=None, scopes=("approval",))
    decision_input: Dict[str, Any] = {}
    try:
        decision_input = json.loads(approval.get("decision_input_json") or "{}")
    except Exception:
        pass
    if decision_input.get("kind") == "destructive_delete":
        result = approve_destructive_action(
            approval_id,
            auth,
            repos,
            annotations=body.annotations,
            reason=body.reason,  # #769: was dropped on the public destructive-delete path
        )
        return ActionResponse(status=str(result.get("status") or "approved"), run_id=str(approval["run_id"]))
    if decision_input.get("kind") == "agent_tool":
        return approve_agent_tool_approval(
            approval_id,
            # #769: forward the public approver's plain-text reason (was dropped)
            ApproveRequest(edited_output=body.edited_output, annotations=body.annotations, reason=body.reason),
            auth,
            repos,
        )
    return approve_run(
        str(approval["run_id"]),
        ApproveRequest(edited_output=body.edited_output, annotations=body.annotations, reason=body.reason),
        auth,
        repos,
    )


@approvals_router.post("/approvals/public/{approval_id}/reject", response_model=ActionResponse)
def reject_public_approval(
    approval_id: str,
    body: PublicApprovalDecisionRequest = Body(default_factory=PublicApprovalDecisionRequest),
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Reject from a signed standalone link without requiring app navigation."""
    approval = _load_public_approval(approval_id, token, repos)
    auth = AuthContext(user_id=str(approval["owner_id"]), email=None, scopes=("approval",))
    decision_input: Dict[str, Any] = {}
    try:
        decision_input = json.loads(approval.get("decision_input_json") or "{}")
    except Exception:
        pass
    if decision_input.get("kind") == "destructive_delete":
        result = reject_destructive_action(
            approval_id,
            RejectRequest(reason=body.reason, annotations=body.annotations),
            auth,
            repos,
        )
        return ActionResponse(status=str(result.get("status") or "rejected"), run_id=str(approval["run_id"]))
    if decision_input.get("kind") == "agent_tool":
        return reject_agent_tool_approval(
            approval_id,
            RejectRequest(reason=body.reason, annotations=body.annotations),
            auth,
            repos,
        )
    return reject_run(
        str(approval["run_id"]),
        RejectRequest(reason=body.reason, annotations=body.annotations),
        auth,
        repos,
    )


# X4: screenshot uploads attached to a review. Both endpoints store the blob
# under the APPROVAL OWNER's user_id so the resulting `/uploads/<sha>` ref is
# readable by the owner when they later view the annotations on the run — even
# when an external signed-link reviewer did the upload. The same extension /
# size / quota gates as `/uploads` apply, and `allowed_media_prefixes` pins the
# upload to images so a reviewer can't smuggle in a non-image blob here.
@approvals_router.post("/approvals/{approval_id}/uploads")
async def upload_approval_screenshot(
    approval_id: str,
    request: Request,
    file: UploadFile = File(...),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Authed owner uploads a review screenshot for one of their approvals."""
    approval = repos.approvals.get(owner_id=auth.user_id, approval_id=approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return await _store_uploaded_blob(
        request,
        file,
        auth.user_id or "anonymous",
        allowed_media_prefixes=("image/",),
    )


@approvals_router.post("/approvals/public/{approval_id}/uploads")
async def upload_public_approval_screenshot(
    approval_id: str,
    request: Request,
    file: UploadFile = File(...),
    token: str = Query(..., min_length=16),
    repos: Repositories = Depends(get_repos),
) -> Dict[str, Any]:
    """Signed-link (no-auth) reviewer uploads a review screenshot.

    The link IS the credential: a valid per-approval HMAC token unlocks the
    upload, and the blob is owned by the approval owner so they can read it back.
    """
    approval = _load_public_approval(approval_id, token, repos)
    owner_id = str(approval.get("owner_id") or "")
    return await _store_uploaded_blob(
        request,
        file,
        owner_id or "anonymous",
        allowed_media_prefixes=("image/",),
    )


def _load_typed_approval(
    approval_id: str,
    user_id: str,
    expected_kind: str,
    repos: Repositories,
) -> Dict[str, Any]:
    """Fetch an approval by ID and validate ownership, pending status, and kind.

    Raises HTTPException(404/409/400) on any check failure so callers only need
    to handle the happy path. Returns the approval row dict.
    """
    approval = repos.approvals.get(owner_id=user_id, approval_id=approval_id)
    if approval is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    if approval.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval already decided")
    decision_input: Dict[str, Any] = {}
    try:
        decision_input = json.loads(approval.get("decision_input_json") or "{}")
    except Exception:
        pass
    if decision_input.get("kind") != expected_kind:
        raise HTTPException(
            status_code=400,
            detail=f"This approval has kind={decision_input.get('kind')!r}, expected {expected_kind!r}.",
        )
    return approval


@approvals_router.post("/runs/{run_id}/approve", response_model=ActionResponse)
def approve_run(
    run_id: str,
    body: ApproveRequest = Body(default_factory=ApproveRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Approve a PENDING_APPROVAL run and spawn a follow-up execution run.

    The follow-up run receives all original inputs merged with:
      - decision: "approved"
      - approved_output: the (optionally edited) proposed output
    """
    from db import now_iso
    from run_service import create_run, start_run
    run_row = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if row_to_dict(run_row).get("status") != RunStatus.PENDING_APPROVAL.value:
        raise HTTPException(status_code=409, detail="Run is not awaiting approval")

    approval_row = repos.approvals.get_by_run_id(run_id=run_id)
    if approval_row is None:
        raise HTTPException(status_code=404, detail="Approval record not found")
    if approval_row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval already decided")

    # Reject agent-tool approvals — they must use POST /approvals/{id}/approve
    # to avoid spawning a follow-up run while the in-process polling loop also
    # resumes the original agent (double execution).
    _di: Dict[str, Any] = {}
    try:
        _di = json.loads(approval_row.get("decision_input_json") or "{}")
    except Exception:
        pass
    if _di.get("kind") == "agent_tool":
        raise HTTPException(
            status_code=400,
            detail="This approval was created by request_approval(). Use POST /approvals/{approval_id}/approve instead.",
        )

    # Load original inputs
    original_inputs: Dict[str, Any] = {}
    raw_decision_input = approval_row.get("decision_input_json")
    if raw_decision_input:
        try:
            original_inputs = json.loads(raw_decision_input)
        except Exception:
            original_inputs = {}

    # Load proposed output
    run_data = row_to_dict(run_row)
    proposed_output: Dict[str, Any] = {}
    raw_output = run_data.get("output_json")
    if raw_output:
        try:
            proposed_output = json.loads(raw_output)
        except Exception:
            proposed_output = {}

    # Build follow-up inputs
    edited_output = body.edited_output if body.edited_output is not None else proposed_output
    follow_up_inputs = {
        **original_inputs,
        "decision": "approved",
        "approved_output": edited_output,
    }

    # Create the follow-up run
    worker_id = run_data["worker_id"]
    try:
        follow_up_run_id = create_run(
            worker_id,
            follow_up_inputs,
            trigger_source="approval",
            user_id=auth.user_id,
            repos=repos,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to spawn follow-up run: {exc}") from exc

    decided_at = now_iso()
    edited_output_json = json.dumps(edited_output) if body.edited_output is not None else None
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=run_id,
        decided_at=decided_at,
        edited_output_json=edited_output_json,
        follow_up_run_id=follow_up_run_id,
        annotations_json=annotations_json,
        reason=getattr(body, "reason", None),  # #769
    )

    # 1.5.1: transition the ORIGINAL run off pending_approval to a terminal
    # state. Without this the original run is stuck at pending_approval forever
    # (zombie approval); the decision is recorded in the approvals table.
    repos.runs.update_status(
        user_id=auth.user_id,
        run_id=run_id,
        status=RunStatus.COMPLETED.value,
    )

    # Kick off the follow-up run
    start_run(follow_up_run_id, worker_id, follow_up_inputs, user_id=auth.user_id, repos=repos)

    # Broadcast the decision
    _sse_publish(run_id, {
        "type": "approval_decided",
        "run_id": run_id,
        "decision": "approved",
        "follow_up_run_id": follow_up_run_id,
    })

    # Emit a terminal status event so live SSE consumers (the run page) observe
    # the original run leaving pending_approval. The frontend tracks
    # `type:"status"` events; without this it never sees the resolution.
    _publish_approval_terminal_status(
        run_id, "approved", auth.user_id, repos, follow_up_run_id=follow_up_run_id
    )

    return ActionResponse(status="approved", run_id=follow_up_run_id)


@approvals_router.post("/runs/{run_id}/reject", response_model=ActionResponse)
def reject_run(
    run_id: str,
    body: RejectRequest = Body(default_factory=RejectRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Reject a PENDING_APPROVAL run. No follow-up run is spawned."""
    from db import now_iso
    run_row = _get_visible_run(run_id, user_id=auth.user_id, repos=repos)
    if run_row is None:
        raise HTTPException(status_code=404, detail="Run not found")
    if row_to_dict(run_row).get("status") != RunStatus.PENDING_APPROVAL.value:
        raise HTTPException(status_code=409, detail="Run is not awaiting approval")

    approval_row = repos.approvals.get_by_run_id(run_id=run_id)
    if approval_row is None:
        raise HTTPException(status_code=404, detail="Approval record not found")
    if approval_row.get("status") != "pending":
        raise HTTPException(status_code=409, detail="Approval already decided")

    _di_r: Dict[str, Any] = {}
    try:
        _di_r = json.loads(approval_row.get("decision_input_json") or "{}")
    except Exception:
        pass
    if _di_r.get("kind") == "agent_tool":
        raise HTTPException(
            status_code=400,
            detail="This approval was created by request_approval(). Use POST /approvals/{approval_id}/reject instead.",
        )

    decided_at = now_iso()
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=run_id,
        decided_at=decided_at,
        reason=body.reason,
        annotations_json=annotations_json,
    )

    # 1.5.1: transition the ORIGINAL run off pending_approval to a terminal
    # state so it is not stuck forever (zombie approval). The rejection itself
    # is recorded in the approvals table (status='rejected' + reason).
    repos.runs.update_status(
        user_id=auth.user_id,
        run_id=run_id,
        status=RunStatus.COMPLETED.value,
    )

    _sse_publish(run_id, {
        "type": "approval_decided",
        "run_id": run_id,
        "decision": "rejected",
        "reason": body.reason,
    })

    # Emit a terminal status event so live SSE consumers (the run page) observe
    # the original run leaving pending_approval. The frontend tracks
    # `type:"status"` events; without this it never sees the resolution.
    _publish_approval_terminal_status(run_id, "rejected", auth.user_id, repos)

    return ActionResponse(status="rejected", run_id=run_id)


# ---------------------------------------------------------------------------
# Destructive-action approvals (kind=destructive_delete)
# ---------------------------------------------------------------------------
# When a sandboxed worker issues DELETE, the middleware queues an approval
# instead of executing immediately. The operator decides here.

import re as _re_action

_RE_DELETE_WORKER = _re_action.compile(r"^/workers/([^/]+)$")
_RE_DELETE_CONTEXT = _re_action.compile(r"^/contexts/([^/]+)$")
_RE_DELETE_CONTEXT_FILE = _re_action.compile(r"^/contexts/([^/]+)/files/(.+)$")


def _execute_destructive_delete(path: str, owner_id: str, repos: Repositories) -> str:
    """Execute a pre-approved destructive delete and return a description."""
    m = _RE_DELETE_WORKER.match(path)
    if m:
        worker_id = m.group(1)
        _delete_worker_impl(worker_id, owner_id, repos)
        return f"Worker '{worker_id}' deleted"

    m = _RE_DELETE_CONTEXT.match(path)
    if m:
        name = m.group(1)
        ctx = repos.contexts.get(owner_id=owner_id, name=name) if hasattr(repos, "contexts") else None
        if ctx is None:
            raise HTTPException(status_code=404, detail=f"Brain pack '{name}' not found")
        repos.contexts.delete(owner_id=owner_id, name=name)
        return f"Brain pack '{name}' deleted"

    m = _RE_DELETE_CONTEXT_FILE.match(path)
    if m:
        name, file_path = m.group(1), m.group(2)
        from worker_registry import WORKERS_DIR  # noqa: PLC0415
        context_dir = WORKERS_DIR.parent / "contexts" / name
        target = context_dir / file_path
        if not target.exists():
            raise HTTPException(status_code=404, detail=f"File '{file_path}' not found in brain pack '{name}'")
        target.unlink()
        return f"File '{file_path}' deleted from brain pack '{name}'"

    raise HTTPException(
        status_code=422,
        detail=f"Approved delete path '{path}' could not be matched to a known resource type.",
    )


class ApproveActionRequest(BaseModel):
    annotations: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None  # #769: optional plain-text approve comment


@approvals_router.post("/approvals/{approval_id}/approve-action")
def approve_destructive_action(
    approval_id: str,
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
    body: ApproveActionRequest = Body(default_factory=ApproveActionRequest),
    annotations: Optional[Dict[str, Any]] = None,
    reason: Optional[str] = None,
):
    """Approve and execute a sandboxed-worker DELETE request.

    Only works for approvals created by the run-token middleware (kind=destructive_delete).
    The optional `annotations`/`reason` keywords let the public-link forwarder
    pass reviewer feedback without a request body; the route body carries them
    for authed callers.
    """
    from db import now_iso
    approval = _load_typed_approval(approval_id, auth.user_id, "destructive_delete", repos)
    decision_input: Dict[str, Any] = json.loads(approval.get("decision_input_json") or "{}")
    path = decision_input.get("path", "")
    description = _execute_destructive_delete(path, auth.user_id, repos)

    annotations_json = _annotations_json_or_none(
        annotations if annotations is not None else body.annotations
    )
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        decided_at=now_iso(),
        annotations_json=annotations_json,
        # #769: forward the approve reason for the destructive-delete path too
        # (mirrors reject_destructive_action; was previously dropped).
        reason=reason if reason is not None else getattr(body, "reason", None),
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "decision": "approved",
        "detail": description,
    })

    return {"status": "approved", "executed": path, "detail": description}


@approvals_router.post("/approvals/{approval_id}/reject-action")
def reject_destructive_action(
    approval_id: str,
    body: RejectRequest = Body(default_factory=RejectRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
):
    """Reject a sandboxed-worker DELETE request without executing it."""
    from db import now_iso
    approval = _load_typed_approval(approval_id, auth.user_id, "destructive_delete", repos)
    decision_input: Dict[str, Any] = json.loads(approval.get("decision_input_json") or "{}")
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        decided_at=now_iso(),
        reason=body.reason,
        annotations_json=annotations_json,
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "decision": "rejected",
        "reason": body.reason,
    })

    return {"status": "rejected", "path": decision_input.get("path", ""), "reason": body.reason}


@approvals_router.post("/approvals/{approval_id}/approve", response_model=ActionResponse)
def approve_agent_tool_approval(
    approval_id: str,
    body: ApproveRequest = Body(default_factory=ApproveRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Approve a mid-run agent-tool approval (kind=agent_tool).

    Does NOT spawn a new run. Flips the approval record to 'approved' so the
    in-process polling loop in agent_driver can resume the run in-place.
    Any edited_output is stored and returned to the agent by the polling loop.
    """
    from db import now_iso
    approval = _load_typed_approval(approval_id, auth.user_id, "agent_tool", repos)
    edited_output_json = json.dumps(body.edited_output) if body.edited_output is not None else None
    repos.approvals.approve(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        approval_id=approval_id,
        decided_at=now_iso(),
        edited_output_json=edited_output_json,
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "approval_id": approval_id,
        "decision": "approved",
    })

    return ActionResponse(status="approved", run_id=str(approval["run_id"]))


@approvals_router.post("/approvals/{approval_id}/reject", response_model=ActionResponse)
def reject_agent_tool_approval(
    approval_id: str,
    body: RejectRequest = Body(default_factory=RejectRequest),
    auth: AuthContext = Depends(get_auth_context),
    repos: Repositories = Depends(get_repos),
) -> ActionResponse:
    """Reject a mid-run agent-tool approval (kind=agent_tool).

    Does NOT affect run status directly — the polling loop in agent_driver
    picks up the 'rejected' status and resumes with approved=False.
    """
    from db import now_iso
    approval = _load_typed_approval(approval_id, auth.user_id, "agent_tool", repos)
    annotations_json = _annotations_json_or_none(getattr(body, "annotations", None))
    repos.approvals.reject(
        owner_id=auth.user_id,
        run_id=approval["run_id"],
        approval_id=approval_id,
        decided_at=now_iso(),
        reason=body.reason,
        annotations_json=annotations_json,
    )

    _sse_publish(approval["run_id"], {
        "type": "approval_decided",
        "run_id": approval["run_id"],
        "approval_id": approval_id,
        "decision": "rejected",
    })

    return ActionResponse(status="rejected", run_id=str(approval["run_id"]))
