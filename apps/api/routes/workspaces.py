"""HTTP surface for workspace switching.

Mounted under /api by main.py:

  GET  /api/workspaces            -> list user's workspaces + active
  POST /api/workspaces            -> create a new workspace
  POST /api/workspaces/{id}/select-> set active workspace cookie
  POST /api/workspaces/{id}/transfer -> transfer ownership

v1 is intentionally minimal: no invites, no roles, no rename, no delete.
"""

from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.datastructures import UploadFile

from apps.api._engine import ensure_engine_api_path
from apps.api.auth.workspace_context import active_workspace, get_active_workspace_id, get_active_member_role
from apps.api.auth.supabase_provider import ACTIVE_WORKSPACE_COOKIE, ACTIVE_WORKSPACE_HEADER
from apps.api.config import get_cloud_settings
from apps.api.db import workspaces as workspace_repo

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402


router = APIRouter(prefix="/workspaces", tags=["workspaces"])


# 30 days, matching the brief.
_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 3600


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class WorkspaceOut(BaseModel):
    id: str
    name: str
    owner_user_id: str
    created_at: str
    role: str = "admin"  # caller's role: 'admin' for owners, 'admin'/'member' for members


class WorkspaceListResponse(BaseModel):
    workspaces: list[WorkspaceOut]
    active_id: str | None


class CreateShareLinkRequest(BaseModel):
    expires_in_days: int = Field(default=7, ge=1, le=30)
    max_uses: int | None = Field(default=None, ge=1, le=100)


class UpdateWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)


class TransferWorkspaceRequest(BaseModel):
    recipient_user_id: str | None = Field(default=None, min_length=1)
    recipient_email: str | None = Field(default=None, min_length=3, max_length=320)
    confirmation: str = Field(..., min_length=1, max_length=160)


class WorkspaceShareLinkOut(BaseModel):
    id: str
    workspace_id: str
    created_at: str
    expires_at: str | None = None
    revoked_at: str | None = None
    max_uses: int | None = None
    use_count: int = 0
    token: str | None = None
    url: str | None = None


class WorkspaceSharePreviewOut(BaseModel):
    id: str
    workspace_id: str
    workspace_name: str
    created_at: str
    expires_at: str | None = None
    max_uses: int | None = None
    use_count: int = 0


class WorkspaceShareImportResponse(BaseModel):
    source_workspace_id: str
    source_workspace_name: str
    target_workspace_id: str
    workers_imported: list[str] = Field(default_factory=list)
    contexts_imported: list[str] = Field(default_factory=list)
    skipped: list[dict] = Field(default_factory=list)
    id_remaps: dict[str, str] = Field(default_factory=dict)
    required_secrets: list[str] = Field(default_factory=list)
    required_connections: list[str] = Field(default_factory=list)
    workspace_md_present: bool = False


class WorkspaceTransferResponse(BaseModel):
    workspace: WorkspaceOut
    previous_owner_user_id: str
    new_owner_user_id: str
    revoked_api_tokens: int
    revoked_share_links: int = 0
    retained_authority: list[str] = Field(default_factory=list)
    audit_event_id: str


_TRANSFER_RETAINED_AUTHORITY = [
    "workers",
    "runs",
    "connections",
    "secrets",
    "workspace_share_links",
]


def _cookie_domain() -> str | None:
    """Mirror the eTLD+1 logic from routes/auth.py so the active-workspace
    cookie lives on the same scope as the session cookie."""
    settings = get_cloud_settings()
    hostname = urlparse(settings.frontend_url).hostname or urlparse(settings.api_base).hostname
    if not hostname or hostname in {"localhost", "127.0.0.1"}:
        return None
    if hostname.replace(".", "").isdigit():
        return None
    parts = hostname.split(".")
    if len(parts) < 2:
        return None
    return "." + ".".join(parts[-2:])


def _set_active_cookie(response: JSONResponse, workspace_id: str) -> None:
    response.set_cookie(
        key=ACTIVE_WORKSPACE_COOKIE,
        value=workspace_id,
        max_age=_COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        secure=True,
        samesite="lax",
        path="/",
        domain=_cookie_domain(),
    )


def _to_out(row: dict, role: str = "admin") -> WorkspaceOut:
    return WorkspaceOut(
        id=str(row["id"]),
        name=str(row["name"]),
        owner_user_id=str(row["owner_user_id"]),
        created_at=str(row["created_at"]),
        role=role,
    )


def _share_url(token: str) -> str:
    settings = get_cloud_settings()
    return f"{settings.frontend_url.rstrip('/')}/workspace/share/{token}"


def _public_link(row: dict, *, token: str | None = None) -> WorkspaceShareLinkOut:
    return WorkspaceShareLinkOut(
        id=str(row["id"]),
        workspace_id=str(row["workspace_id"]),
        created_at=str(row["created_at"]),
        expires_at=str(row.get("expires_at")) if row.get("expires_at") else None,
        revoked_at=str(row.get("revoked_at")) if row.get("revoked_at") else None,
        max_uses=row.get("max_uses"),
        use_count=int(row.get("use_count") or 0),
        token=token,
        url=_share_url(token) if token else None,
    )


def _validated_share(token: str) -> dict:
    link = workspace_repo.resolve_share_token(token=token)
    if not link:
        raise HTTPException(status_code=404, detail="share link not found")
    if link.get("revoked_at"):
        raise HTTPException(status_code=410, detail="share link revoked")
    expires_at = link.get("expires_at")
    if expires_at:
        try:
            parsed = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
        except ValueError:
            parsed = None
        if parsed and parsed < datetime.now(timezone.utc):
            raise HTTPException(status_code=410, detail="share link expired")
    max_uses = link.get("max_uses")
    use_count = int(link.get("use_count") or 0)
    if max_uses is not None and use_count >= int(max_uses):
        raise HTTPException(status_code=410, detail="share link exhausted")
    return link


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceListResponse:
    owned = workspace_repo.list_for_owner(owner_user_id=auth.user_id)
    member_rows = workspace_repo.list_member_workspaces(user_id=auth.user_id)

    if not owned and not member_rows:
        # Lazy-bootstrap a default workspace for brand-new users.
        owned = [
            workspace_repo.resolve_active_workspace(
                user_id=auth.user_id,
                email=auth.email,
                requested_id=None,
            )
        ]

    # Build combined list: owned workspaces (role='admin') first, then member
    # workspaces (role from workspace_members) in joined-at order.
    all_workspaces: list[WorkspaceOut] = []
    seen_ids: set[str] = set()
    for row in owned:
        ws_id = str(row["id"])
        seen_ids.add(ws_id)
        all_workspaces.append(_to_out(row, role="admin"))
    for row in member_rows:
        ws_id = str(row["id"])
        if ws_id not in seen_ids:  # guard against owner also appearing as member
            seen_ids.add(ws_id)
            all_workspaces.append(_to_out(row, role=str(row.get("role") or "member")))

    token_workspace_id = get_active_workspace_id() if auth.auth_method == "pat" else None
    if token_workspace_id:
        token_role = get_active_member_role() or "member"
        all_workspaces = [
            WorkspaceOut(
                id=ws.id,
                name=ws.name,
                owner_user_id=ws.owner_user_id,
                created_at=ws.created_at,
                role=token_role if ws.id == token_workspace_id else ws.role,
            )
            for ws in all_workspaces
            if ws.id == token_workspace_id
        ]

    requested = (
        (request.headers.get(ACTIVE_WORKSPACE_HEADER) or "").strip()
        or request.cookies.get(ACTIVE_WORKSPACE_COOKIE)
    )
    active_id: str | None = None
    for ws in all_workspaces:
        if requested and ws.id == requested:
            active_id = requested
            break
    if active_id is None and all_workspaces:
        active_id = all_workspaces[0].id

    return WorkspaceListResponse(
        workspaces=all_workspaces,
        active_id=active_id,
    )


@router.post("", response_model=WorkspaceOut)
async def create_workspace(
    payload: CreateWorkspaceRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceOut:
    created = workspace_repo.create(owner_user_id=auth.user_id, name=payload.name)
    return _to_out(created)


@router.post("/{workspace_id}/select")
async def select_workspace(
    workspace_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> JSONResponse:
    token_workspace_id = get_active_workspace_id() if auth.auth_method == "pat" else None
    if token_workspace_id and workspace_id != token_workspace_id:
        raise HTTPException(status_code=403, detail="token is not valid for this workspace")
    workspace = workspace_repo.get(workspace_id=workspace_id)
    if workspace is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    # Allow: owner OR active workspace member.
    is_owner = str(workspace["owner_user_id"]) == auth.user_id
    member_role = workspace_repo.get_member_role(workspace_id=workspace_id, user_id=auth.user_id)
    if not is_owner and member_role is None:
        raise HTTPException(status_code=404, detail="workspace not found")
    role = "admin" if is_owner else (member_role or "member")
    response = JSONResponse(_to_out(workspace, role=role).model_dump())
    _set_active_cookie(response, workspace_id)
    return response


@router.patch("/{workspace_id}", response_model=WorkspaceOut)
async def update_workspace(
    workspace_id: str,
    payload: UpdateWorkspaceRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceOut:
    workspace = workspace_repo.get(workspace_id=workspace_id)
    if workspace is None or str(workspace["owner_user_id"]) != auth.user_id:
        raise HTTPException(status_code=404, detail="workspace not found")
    updated = workspace_repo.rename(workspace_id=workspace_id, name=payload.name.strip())
    return _to_out(updated)


@router.post("/{workspace_id}/transfer", response_model=WorkspaceTransferResponse)
async def transfer_workspace(
    workspace_id: str,
    payload: TransferWorkspaceRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceTransferResponse:
    workspace = workspace_repo.get(workspace_id=workspace_id)
    if workspace is None or str(workspace["owner_user_id"]) != auth.user_id:
        raise HTTPException(status_code=404, detail="workspace not found")

    recipient_fields = [
        bool((payload.recipient_user_id or "").strip()),
        bool((payload.recipient_email or "").strip()),
    ]
    if recipient_fields.count(True) != 1:
        raise HTTPException(status_code=400, detail="provide exactly one recipient")

    required_confirmation = f"TRANSFER {workspace['name']}"
    if payload.confirmation != required_confirmation:
        raise HTTPException(
            status_code=400,
            detail={
                "message": "confirmation text mismatch",
                "required": required_confirmation,
            },
        )

    recipient = workspace_repo.resolve_transfer_recipient(
        recipient_user_id=(payload.recipient_user_id or "").strip() or None,
        recipient_email=(payload.recipient_email or "").strip().lower() or None,
    )
    if recipient is None:
        raise HTTPException(status_code=404, detail="recipient not found")
    recipient_user_id = str(recipient["id"])
    if recipient_user_id == auth.user_id:
        raise HTTPException(status_code=400, detail="recipient already owns workspace")

    try:
        result = workspace_repo.transfer_ownership(
            owner_user_id=auth.user_id,
            workspace_id=workspace_id,
            recipient_user_id=recipient_user_id,
            retained_authority=list(_TRANSFER_RETAINED_AUTHORITY),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="workspace not found") from exc

    return WorkspaceTransferResponse(
        workspace=_to_out(result["workspace"]),
        previous_owner_user_id=str(result["previous_owner_user_id"]),
        new_owner_user_id=str(result["new_owner_user_id"]),
        revoked_api_tokens=int(result["revoked_api_tokens"]),
        revoked_share_links=int(result.get("revoked_share_links") or 0),
        retained_authority=list(result["retained_authority"]),
        audit_event_id=str(result["audit_event_id"]),
    )


@router.post("/{workspace_id}/share-links", response_model=WorkspaceShareLinkOut)
async def create_share_link(
    workspace_id: str,
    payload: CreateShareLinkRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceShareLinkOut:
    expires_at = (datetime.now(timezone.utc) + timedelta(days=payload.expires_in_days)).isoformat()
    try:
        row, token = workspace_repo.create_share_link(
            owner_user_id=auth.user_id,
            workspace_id=workspace_id,
            expires_at=expires_at,
            max_uses=payload.max_uses,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="workspace not found") from exc
    return _public_link(row, token=token)


@router.delete("/{workspace_id}/share-links/{link_id}")
async def revoke_share_link(
    workspace_id: str,
    link_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> dict[str, bool]:
    try:
        revoked = workspace_repo.revoke_share_link(
            owner_user_id=auth.user_id,
            workspace_id=workspace_id,
            link_id=link_id,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="workspace not found") from exc
    if not revoked:
        raise HTTPException(status_code=404, detail="share link not found")
    return {"ok": True}


@router.get("/shares/{token}", response_model=WorkspaceSharePreviewOut)
async def preview_share(token: str) -> WorkspaceSharePreviewOut:
    link = _validated_share(token)
    workspace = link["workspace"]
    return WorkspaceSharePreviewOut(
        id=str(link["id"]),
        workspace_id=str(link["workspace_id"]),
        workspace_name=str(workspace["name"]),
        created_at=str(link["created_at"]),
        expires_at=str(link.get("expires_at")) if link.get("expires_at") else None,
        max_uses=link.get("max_uses"),
        use_count=int(link.get("use_count") or 0),
    )


@router.post("/shares/{token}/import", response_model=WorkspaceShareImportResponse)
async def import_share(
    token: str,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceShareImportResponse:
    target_workspace_id = get_active_workspace_id()
    if not target_workspace_id:
        raise HTTPException(status_code=400, detail="active workspace required")
    link = _validated_share(token)
    source_workspace = link["workspace"]
    source_workspace_id = str(source_workspace["id"])
    source_owner_id = str(source_workspace["owner_user_id"])
    if source_workspace_id == target_workspace_id:
        raise HTTPException(status_code=400, detail="cannot import a workspace into itself")

    import_engine = __import__("main")
    with active_workspace(source_workspace_id):
        export_response = import_engine.export_workspace(
            auth=AuthContext(user_id=source_owner_id, email=None, scopes=()),
            repos=import_engine.get_repositories(),
        )
    payload = bytes(getattr(export_response, "body", b""))
    if not payload:
        raise HTTPException(status_code=500, detail="workspace export failed")

    with active_workspace(target_workspace_id):
        upload = UploadFile(filename="workspace-template.zip", file=io.BytesIO(payload))
        result = await import_engine.import_workspace(
            bundle=upload,
            request=None,
            auth=auth,
            repos=import_engine.get_repositories(),
        )
    workspace_repo.increment_share_use(link_id=str(link["id"]), use_count=int(link.get("use_count") or 0))
    return WorkspaceShareImportResponse(
        source_workspace_id=source_workspace_id,
        source_workspace_name=str(source_workspace["name"]),
        target_workspace_id=target_workspace_id,
        workers_imported=list(result.workers_imported),
        contexts_imported=list(result.contexts_imported),
        skipped=list(result.skipped),
        id_remaps=dict(result.id_remaps),
        required_secrets=list(result.required_secrets),
        required_connections=list(result.required_connections),
        workspace_md_present=bool(result.workspace_md_present),
    )
