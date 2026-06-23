"""Workspace issues route group (#1781).

Git-backed workspace issues stored under ``.floom/issues/`` in the workspace git
repo. No GitHub Issues, no provider sync, no database table — the service writes
files and commits them through the existing workspace git helpers.

Endpoints:
  GET   /workspace/issues?status=&label=&asset_type=&asset_id=
  GET   /workspace/issues/{id}
  POST  /workspace/issues
  POST  /workspace/issues/{id}/comments
  PATCH /workspace/issues/{id}

Auth is the standard workspace auth context; any workspace member may track and
comment on issues (the operating-record loop is not admin-only). Domain logic
lives in services.workspace_issues; this layer maps validation/not-found errors
to HTTP status codes.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import AuthContext, get_auth_context
from models import (
    WorkspaceIssueComment,
    WorkspaceIssueCommentRequest,
    WorkspaceIssueCreateRequest,
    WorkspaceIssueDetail,
    WorkspaceIssueOut,
    WorkspaceIssuesResponse,
    WorkspaceIssueUpdateRequest,
)
from services import workspace_issues as _issues
from services.git_service import _git_author

workspace_issues_router = APIRouter()


@workspace_issues_router.get("/workspace/issues", response_model=WorkspaceIssuesResponse)
def list_workspace_issues(
    status: Optional[str] = Query(None),
    label: Optional[str] = Query(None),
    asset_type: Optional[str] = Query(None),
    asset_id: Optional[str] = Query(None),
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssuesResponse:
    issues = _issues.list_issues(
        status=status, label=label, asset_type=asset_type, asset_id=asset_id
    )
    return WorkspaceIssuesResponse(issues=[WorkspaceIssueOut(**i) for i in issues])


@workspace_issues_router.get(
    "/workspace/issues/{issue_id}", response_model=WorkspaceIssueDetail
)
def get_workspace_issue(
    issue_id: str,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssueDetail:
    try:
        issue = _issues.get_issue(issue_id)
    except _issues.IssueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except _issues.IssueNotFound as exc:
        raise HTTPException(status_code=404, detail=f"Issue not found: {issue_id}") from exc
    return WorkspaceIssueDetail(
        comments=[WorkspaceIssueComment(**c) for c in issue.pop("comments", [])],
        **issue,
    )


@workspace_issues_router.post(
    "/workspace/issues", response_model=WorkspaceIssueOut, status_code=201
)
def create_workspace_issue(
    payload: WorkspaceIssueCreateRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssueOut:
    author_name, author_email = _git_author(auth)
    try:
        issue = _issues.create_issue(
            title=payload.title,
            body=payload.body,
            asset_type=payload.asset_type,
            asset_id=payload.asset_id,
            source=payload.source,
            labels=payload.labels,
            created_by=auth.user_id,
            author_name=author_name,
            author_email=author_email,
        )
    except _issues.IssueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return WorkspaceIssueOut(**issue)


@workspace_issues_router.patch(
    "/workspace/issues/{issue_id}", response_model=WorkspaceIssueOut
)
def update_workspace_issue(
    issue_id: str,
    payload: WorkspaceIssueUpdateRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssueOut:
    author_name, author_email = _git_author(auth)
    try:
        issue = _issues.update_issue(
            issue_id,
            title=payload.title,
            body=payload.body,
            status=payload.status,
            labels=payload.labels,
            asset_type=payload.asset_type,
            asset_id=payload.asset_id,
            clear_asset=payload.clear_asset,
            author_name=author_name,
            author_email=author_email,
        )
    except _issues.IssueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except _issues.IssueNotFound as exc:
        raise HTTPException(status_code=404, detail=f"Issue not found: {issue_id}") from exc
    return WorkspaceIssueOut(**issue)


@workspace_issues_router.post(
    "/workspace/issues/{issue_id}/comments",
    response_model=WorkspaceIssueComment,
    status_code=201,
)
def comment_on_workspace_issue(
    issue_id: str,
    payload: WorkspaceIssueCommentRequest,
    auth: AuthContext = Depends(get_auth_context),
) -> WorkspaceIssueComment:
    author_name, author_email = _git_author(auth)
    try:
        comment = _issues.add_comment(
            issue_id,
            body=payload.body,
            created_by=auth.user_id,
            author_name=author_name,
            author_email=author_email,
        )
    except _issues.IssueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except _issues.IssueNotFound as exc:
        raise HTTPException(status_code=404, detail=f"Issue not found: {issue_id}") from exc
    return WorkspaceIssueComment(**comment)
