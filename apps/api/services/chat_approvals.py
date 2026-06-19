"""Agent-tool approval handling: list pending, resolve, approve/reject.

Extracted verbatim from chat_service.py: the workspace-agent approval tools and
the shared decision path (run approvals, destructive-action approvals, agent-tool
approvals). chat_service re-imports these names for backward compatibility. The
approval-backend functions, request models, DB and FastAPI deps are lazy-imported
inside the functions (avoiding an import cycle); _APPROVALS_BASE_URL is lazy-
imported from chat_service (it is shared with the system-prompt builder there).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from core.approval_signing import approval_public_token, try_approval_public_token

logger = logging.getLogger("floom.chat")


def _approval_public_token(row: Any) -> str:
    # Backward-compat shim: the canonical fail-closed mint now lives in
    # core.approval_signing (decoupled from FLOOM_SECRET via
    # WORKEROS_APPROVAL_SIGNING_SECRET). Still fail-closed (503) when no signer —
    # never sign a public share token with a public constant (#998). `row` is a
    # sqlite3.Row or a dict-like supporting __getitem__ on these three keys.
    return approval_public_token({key: row[key] for key in ("id", "run_id", "owner_id")})


def _tool_approvals_list_pending(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Return pending approvals with direct links the operator can open."""
    from chat_service import _APPROVALS_BASE_URL
    from db import get_db as _get_db
    try:
        with _get_db() as conn:
            rows = conn.execute(
                """
                SELECT a.id, a.run_id, a.worker_id, a.owner_id, a.label, a.preview, a.created_at,
                       w.name AS worker_name
                FROM approvals a
                LEFT JOIN workers w ON w.id = a.worker_id
                WHERE a.owner_id = ? AND a.status = 'pending'
                ORDER BY a.created_at ASC
                """,
                (user_id,),
            ).fetchall()
        result = []
        for row in rows:
            approval_id = row["id"]
            # Authoritative, tokenised deep link on the configured public host so
            # Emily surfaces a working link instead of inventing a fake URL.
            # DEGRADE, never raise: when no signer secret is configured (e.g.
            # cloud mode), omit the link rather than 503 the whole pending-list
            # tool — the operator still sees their pending approvals.
            review_url = None
            if approval_id and row["run_id"] and row["owner_id"]:
                token = try_approval_public_token(
                    {"id": approval_id, "run_id": row["run_id"], "owner_id": row["owner_id"]}
                )
                if token:
                    review_url = f"{_APPROVALS_BASE_URL}/approvals/review?id={approval_id}&token={token}"
            result.append({
                "id": approval_id,
                "owner_id": row["owner_id"],
                "worker_id": row["worker_id"],
                "worker_name": row["worker_name"] or row["worker_id"],
                "run_id": row["run_id"],
                "label": row["label"],
                "preview": (row["preview"] or "")[:200] or None,
                "created_at": row["created_at"],
                "review_url": review_url,
            })
        return {"ok": True, "approvals": result, "count": len(result)}
    except Exception as exc:
        logger.exception("approvals__list_pending failed")
        return {"ok": False, "error": str(exc)}


def _resolve_pending_approval_for_actor(
    *, approval_id: Optional[str], run_id: Optional[str], user_id: str
) -> Dict[str, Any]:
    """Find the actor's single pending approval by approval_id or run_id.

    OWNER-SCOPED (#891): only approvals owned by *user_id* are visible; an actor
    can never approve/reject another user's run. Returns
    ``{"ok": True, "approval": <row>}`` on success or ``{"ok": False, ...}`` with
    a model-readable error (not found / not owned / ambiguous / already decided).
    """
    from db import get_db as _get_db

    approval_id = (approval_id or "").strip() or None
    run_id = (run_id or "").strip() or None
    if not approval_id and not run_id:
        return {"ok": False, "error": "approval_id or run_id is required."}

    with _get_db() as conn:
        if approval_id:
            row = conn.execute(
                "SELECT id, run_id, owner_id, status FROM approvals "
                "WHERE id = ? AND owner_id = ? LIMIT 1",
                (approval_id, user_id),
            ).fetchone()
            if row is None:
                # Distinguish "not yours" from "doesn't exist" without leaking
                # another user's approval — both collapse to a single message.
                return {
                    "ok": False,
                    "error": f"No pending approval {approval_id!r} found for you.",
                }
        else:
            rows = conn.execute(
                "SELECT id, run_id, owner_id, status FROM approvals "
                "WHERE run_id = ? AND owner_id = ? ORDER BY created_at DESC",
                (run_id, user_id),
            ).fetchall()
            if not rows:
                return {
                    "ok": False,
                    "error": f"No approval for run {run_id!r} found for you.",
                }
            pending_rows = [r for r in rows if str(r["status"]) == "pending"]
            if not pending_rows:
                return {
                    "ok": False,
                    "error": f"The approval for run {run_id!r} is no longer pending.",
                }
            if len(pending_rows) > 1:
                return {
                    "ok": False,
                    "ambiguous": True,
                    "error": (
                        f"Run {run_id!r} has {len(pending_rows)} pending approvals; "
                        "pass approval_id to choose one."
                    ),
                    "candidates": [str(r["id"]) for r in pending_rows],
                }
            row = pending_rows[0]

    if str(row["status"]) != "pending":
        return {"ok": False, "error": "That approval is no longer pending (already decided)."}
    return {
        "ok": True,
        "approval": {
            "id": str(row["id"]),
            "run_id": str(row["run_id"] or ""),
            "owner_id": str(row["owner_id"] or ""),
        },
    }


def _decide_approval(
    *, decision: str, approval_id: Optional[str], run_id: Optional[str], user_id: str
) -> Dict[str, Any]:
    """Approve or reject the actor's pending approval (#891).

    Reuses the SAME canonical decision functions the HTTP endpoints POST to
    (approve_run/reject_run for run-level approvals, approve/reject agent-tool
    approvals for kind=agent_tool, destructive-action for kind=destructive_delete),
    constructing an owner-scoped AuthContext exactly like the public-link path in
    main.py does. OWNER-SCOPED: the approval is resolved only within the actor's
    own approvals, so an actor can never decide another user's run.
    """
    resolved = _resolve_pending_approval_for_actor(
        approval_id=approval_id, run_id=run_id, user_id=user_id
    )
    if not resolved.get("ok"):
        return resolved
    approval_id = resolved["approval"]["id"]
    target_run_id = resolved["approval"]["run_id"]

    from db import get_repositories
    from main import (
        AuthContext,
        ApproveRequest,
        RejectRequest,
        approve_run,
        reject_run,
        approve_agent_tool_approval,
        reject_agent_tool_approval,
        approve_destructive_action,
        reject_destructive_action,
    )

    repos = get_repositories()
    auth = AuthContext(user_id=user_id, email=None, scopes=("chat", "approval"))

    # Determine the approval kind to route to the correct canonical path,
    # mirroring approve_public_approval/reject_public_approval in main.py.
    kind = ""
    try:
        approval_row = repos.approvals.get(owner_id=user_id, approval_id=approval_id)
        if approval_row is not None:
            kind = (json.loads(approval_row.get("decision_input_json") or "{}") or {}).get("kind") or ""
    except Exception:
        kind = ""

    try:
        if decision == "approved":
            if kind == "destructive_delete":
                result = approve_destructive_action(approval_id, auth, repos)
                status = str((result or {}).get("status") or "approved")
            elif kind == "agent_tool":
                result = approve_agent_tool_approval(approval_id, ApproveRequest(), auth, repos)
                status = getattr(result, "status", "approved")
            else:
                result = approve_run(target_run_id, ApproveRequest(), auth, repos)
                status = getattr(result, "status", "approved")
        else:
            reason = f"Rejected via chat by {user_id}"
            if kind == "destructive_delete":
                result = reject_destructive_action(
                    approval_id, RejectRequest(reason=reason), auth, repos
                )
                status = str((result or {}).get("status") or "rejected")
            elif kind == "agent_tool":
                result = reject_agent_tool_approval(
                    approval_id, RejectRequest(reason=reason), auth, repos
                )
                status = getattr(result, "status", "rejected")
            else:
                result = reject_run(target_run_id, RejectRequest(reason=reason), auth, repos)
                status = getattr(result, "status", "rejected")
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        low = str(detail).lower()
        if "not awaiting approval" in low or "already decided" in low:
            return {"ok": False, "error": "That approval is no longer pending (already decided)."}
        if "not found" in low:
            return {"ok": False, "error": "That approval is no longer available."}
        logger.exception("approvals__%s failed for approval %s", decision, approval_id)
        return {"ok": False, "error": str(detail)}

    return {"ok": True, "status": status, "run_id": target_run_id, "approval_id": approval_id}


def _tool_approvals_approve(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    return _decide_approval(
        decision="approved",
        approval_id=args.get("approval_id"),
        run_id=args.get("run_id"),
        user_id=user_id,
    )


def _tool_approvals_reject(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    return _decide_approval(
        decision="rejected",
        approval_id=args.get("approval_id"),
        run_id=args.get("run_id"),
        user_id=user_id,
    )
