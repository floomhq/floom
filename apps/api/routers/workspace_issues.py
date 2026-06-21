"""Workspace issues routes — GitHub-Issues-backed workspace operating loop.

Endpoints (issue #1773 MVP):

  GET   /workspace/issues?state=&asset_type=&asset_id=   list + filter
  POST  /workspace/issues                                create
  POST  /workspace/issues/{number}/comments              comment
  PATCH /workspace/issues/{number}                       title/body/state/labels

GitHub Issues are the source of truth; the projection + marker logic lives in
``services.workspace_issues``. When GitHub is not connected these return a 400
with an actionable message rather than failing silently (acceptance criteria).
``services`` deps resolve db/git_ops lazily; ``github_api`` is imported lazily
inside the service layer so module-purging fixtures stay happy.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from auth import AuthContext, get_auth_context
from services.workspace_issues import (
    GitHubNotConnected,
    WorkspaceIssue,
    comment_on_issue,
    create_workspace_issue,
    list_workspace_issues,
    update_workspace_issue,
)

logger = logging.getLogger("floom.api")

workspace_issues_router = APIRouter()


class _CreateIssueRequest(BaseModel):
    title: str
    body: Optional[str] = None
    asset_type: Optional[str] = None
    asset_id: Optional[str] = None
    source: Optional[str] = None
    labels: Optional[List[str]] = None


class _CommentRequest(BaseModel):
    body: str


class _UpdateIssueRequest(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    state: Optional[str] = None
    labels: Optional[List[str]] = None


def _github_error(exc: BaseException) -> HTTPException:
    """Map a GitHub API failure to a safe HTTP error (never echo token/URL)."""
    from github_api import GitHubAPIError

    if isinstance(exc, GitHubAPIError):
        status = getattr(exc, "status", 0) or 502
        if status in (401, 403):
            return HTTPException(status_code=400, detail="GitHub authentication failed — check the token's 'repo' scope.")
        if status == 404:
            return HTTPException(status_code=404, detail="GitHub issue or repository not found.")
        logger.warning("GitHub issues API error (status=%s)", status)
        return HTTPException(status_code=502, detail="GitHub request failed. Please retry.")
    logger.exception("Workspace issues operation failed")
    return HTTPException(status_code=500, detail="Workspace issue operation failed.")


@workspace_issues_router.get("/workspace/issues", response_model=List[WorkspaceIssue])
def list_issues(
    auth: AuthContext = Depends(get_auth_context),
    state: str = Query("all"),
    asset_type: Optional[str] = Query(None),
    asset_id: Optional[str] = Query(None),
) -> List[WorkspaceIssue]:
    """List workspace issues, optionally filtered by asset binding."""
    try:
        return list_workspace_issues(auth.user_id, state=state, asset_type=asset_type, asset_id=asset_id)
    except GitHubNotConnected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — mapped to a safe HTTP error
        raise _github_error(exc) from exc


@workspace_issues_router.post("/workspace/issues", response_model=WorkspaceIssue, status_code=201)
def create_issue(
    payload: _CreateIssueRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssue:
    """Create a GitHub-backed workspace issue, optionally bound to an asset."""
    try:
        return create_workspace_issue(
            auth.user_id,
            title=payload.title,
            body=payload.body,
            asset_type=payload.asset_type,
            asset_id=payload.asset_id,
            source=payload.source,
            labels=payload.labels,
        )
    except GitHubNotConnected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise _github_error(exc) from exc


@workspace_issues_router.post("/workspace/issues/{number}/comments", status_code=201)
def add_comment(
    number: int,
    payload: _CommentRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> dict:
    """Comment on a workspace issue."""
    try:
        return comment_on_issue(auth.user_id, number, payload.body)
    except GitHubNotConnected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise _github_error(exc) from exc


@workspace_issues_router.patch("/workspace/issues/{number}", response_model=WorkspaceIssue)
def patch_issue(
    number: int,
    payload: _UpdateIssueRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssue:
    """Update an issue's title/body/state/labels (state is open|closed)."""
    if payload.state is not None and payload.state not in ("open", "closed"):
        raise HTTPException(status_code=400, detail="state must be 'open' or 'closed'")
    try:
        return update_workspace_issue(
            auth.user_id,
            number,
            title=payload.title,
            body=payload.body,
            state=payload.state,
            labels=payload.labels,
        )
    except GitHubNotConnected as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise _github_error(exc) from exc
