"""Git-backed workspace issues.

Workspace issues are a purely git-backed workspace feature: each issue is a file
in the workspace git repo, the same source of truth as workers, contexts, and
workspace instructions. There is no GitHub Issues integration, no provider sync,
and no new database table.

Layout, relative to the git workspace root (services.git_service._git_workspace):

  .floom/issues/ISSUE-0001.md              — YAML frontmatter + markdown body
  .floom/issues/ISSUE-0001.comments.ndjson — append-only comment log (NDJSON)

Because every workspace has its own git root, the issue id namespace is
per-workspace and is preserved through workspace export/import and the cloud
bundle flow automatically (same git path as every other workspace asset).

This module is intentionally dependency-light: it imports git_ops and the
git_service resolution/commit helpers lazily, never ``main``, so it stays
importable and unit-testable in isolation (mirrors the other services helpers).
"""

from __future__ import annotations

import json
import re
import secrets
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Asset types supported in the MVP plus the ones the schema is intentionally kept
# open for. Workspace-wide issues bind to none of these.
KNOWN_ASSET_TYPES = ("worker", "context", "run", "connection", "approval", "mcp")
ISSUE_STATUSES = ("open", "closed")

_ISSUES_SUBDIR = (".floom", "issues")
_ISSUE_ID_RE = re.compile(r"^ISSUE-\d{4,}$")
_ISSUE_FILE_RE = re.compile(r"^ISSUE-(\d+)\.md$")
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)

# Field order written into the YAML frontmatter (keeps files human-readable and
# diffs stable across edits).
_FRONTMATTER_ORDER = (
    "id",
    "status",
    "title",
    "asset_type",
    "asset_id",
    "source",
    "labels",
    "created_by",
    "created_at",
    "updated_at",
)


class IssueError(Exception):
    """Raised for invalid issue input (mapped to HTTP 400 by the router)."""


class IssueNotFound(Exception):
    """Raised when an issue id does not resolve to a file."""


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------

def _issues_dir(workspace: Path) -> Path:
    return workspace.joinpath(*_ISSUES_SUBDIR)


def _validate_issue_id(issue_id: str) -> str:
    issue_id = (issue_id or "").strip()
    if not _ISSUE_ID_RE.fullmatch(issue_id):
        raise IssueError(f"Invalid issue id: {issue_id!r} (expected ISSUE-NNNN)")
    return issue_id


def _issue_md_rel(issue_id: str) -> str:
    return "/".join((*_ISSUES_SUBDIR, f"{issue_id}.md"))


def _issue_comments_rel(issue_id: str) -> str:
    return "/".join((*_ISSUES_SUBDIR, f"{issue_id}.comments.ndjson"))


# ---------------------------------------------------------------------------
# Frontmatter (de)serialization
# ---------------------------------------------------------------------------

def _split_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    """Return (frontmatter dict, body) for an issue markdown file."""
    import yaml as _yaml

    match = _FRONTMATTER_RE.match(text)
    if not match:
        return {}, text.strip()
    meta = _yaml.safe_load(match.group(1)) or {}
    if not isinstance(meta, dict):
        meta = {}
    return meta, match.group(2).strip()


def _serialize_issue(meta: Dict[str, Any], body: str) -> str:
    import yaml as _yaml

    ordered: Dict[str, Any] = {}
    for key in _FRONTMATTER_ORDER:
        if key in meta and meta[key] is not None:
            ordered[key] = meta[key]
    # Preserve any forward-compatible keys not in the known order.
    for key, value in meta.items():
        if key not in ordered and value is not None:
            ordered[key] = value
    fm = _yaml.safe_dump(
        ordered, sort_keys=False, allow_unicode=True, default_flow_style=False
    ).strip()
    return f"---\n{fm}\n---\n\n{(body or '').strip()}\n"


def _normalize_labels(labels: Optional[List[str]]) -> List[str]:
    if not labels:
        return []
    out: List[str] = []
    for raw in labels:
        label = str(raw).strip()
        if label and label not in out:
            out.append(label)
    return out


def _validate_asset_binding(
    asset_type: Optional[str], asset_id: Optional[str]
) -> Tuple[Optional[str], Optional[str]]:
    asset_type = (asset_type or "").strip() or None
    asset_id = (asset_id or "").strip() or None
    if bool(asset_type) != bool(asset_id):
        raise IssueError("asset_type and asset_id must be provided together")
    if asset_type and asset_type not in KNOWN_ASSET_TYPES:
        raise IssueError(
            f"Unsupported asset_type {asset_type!r} "
            f"(expected one of {', '.join(KNOWN_ASSET_TYPES)})"
        )
    return asset_type, asset_id


def _issue_to_dict(meta: Dict[str, Any], body: str, comment_count: int) -> Dict[str, Any]:
    return {
        "id": str(meta.get("id") or ""),
        "status": str(meta.get("status") or "open"),
        "title": str(meta.get("title") or ""),
        "body": body,
        "asset_type": meta.get("asset_type"),
        "asset_id": meta.get("asset_id"),
        "source": meta.get("source"),
        "labels": _normalize_labels(meta.get("labels")),
        "created_by": meta.get("created_by"),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
        "comment_count": comment_count,
    }


# ---------------------------------------------------------------------------
# Git commit helper
# ---------------------------------------------------------------------------

def _commit_paths(
    workspace: Path,
    rel_paths: List[str],
    message: str,
    author_name: str,
    author_email: str,
) -> None:
    import git_ops as _git_ops
    from services.git_service import _ensure_git_workspace_ready, _git_ops_lock

    with _git_ops_lock:
        _ensure_git_workspace_ready(workspace)
        _git_ops.commit_paths(workspace, rel_paths, message, author_name, author_email)
        _git_ops.push_background(workspace)


def _next_issue_id(issues_dir: Path) -> str:
    """Return the next free per-workspace issue id (ISSUE-NNNN), no collisions."""
    highest = 0
    if issues_dir.is_dir():
        for child in issues_dir.iterdir():
            match = _ISSUE_FILE_RE.match(child.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return f"ISSUE-{highest + 1:04d}"


def _read_comments(workspace: Path, issue_id: str) -> List[Dict[str, Any]]:
    path = workspace / _issue_comments_rel(issue_id)
    if not path.is_file():
        return []
    comments: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            comments.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return comments


def _load_issue(workspace: Path, issue_id: str) -> Tuple[Dict[str, Any], str]:
    path = workspace / _issue_md_rel(issue_id)
    if not path.is_file():
        raise IssueNotFound(issue_id)
    meta, body = _split_frontmatter(path.read_text(encoding="utf-8"))
    return meta, body


# ---------------------------------------------------------------------------
# Public service API
# ---------------------------------------------------------------------------

def create_issue(
    *,
    title: str,
    body: str = "",
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
    source: Optional[str] = None,
    labels: Optional[List[str]] = None,
    created_by: str,
    author_name: str = "Floom",
    author_email: str = "workeros@local",
) -> Dict[str, Any]:
    title = (title or "").strip()
    if not title:
        raise IssueError("title is required")
    asset_type, asset_id = _validate_asset_binding(asset_type, asset_id)

    from db import now_iso
    from services.git_service import _ensure_git_workspace_ready, _git_ops_lock, _git_workspace

    import git_ops as _git_ops

    workspace = _git_workspace()
    issues_dir = _issues_dir(workspace)

    now = now_iso()
    meta = {
        "status": "open",
        "title": title,
        "asset_type": asset_type,
        "asset_id": asset_id,
        "source": (source or "").strip() or None,
        "labels": _normalize_labels(labels),
        "created_by": created_by,
        "created_at": now,
        "updated_at": now,
    }

    # Generate the id and write under the same lock as the commit so concurrent
    # creates never collide on ISSUE-NNNN.
    with _git_ops_lock:
        _ensure_git_workspace_ready(workspace)
        issues_dir.mkdir(parents=True, exist_ok=True)
        issue_id = _next_issue_id(issues_dir)
        meta = {"id": issue_id, **meta}
        md_path = workspace / _issue_md_rel(issue_id)
        md_path.write_text(_serialize_issue(meta, body), encoding="utf-8")
        _git_ops.commit_paths(
            workspace,
            [_issue_md_rel(issue_id)],
            f"issues: create {issue_id} {title}",
            author_name,
            author_email,
        )
        _git_ops.push_background(workspace)

    return _issue_to_dict(meta, (body or "").strip(), 0)


def list_issues(
    *,
    status: Optional[str] = None,
    label: Optional[str] = None,
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    from services.git_service import _git_workspace

    workspace = _git_workspace()
    issues_dir = _issues_dir(workspace)
    if not issues_dir.is_dir():
        return []

    status = (status or "").strip() or None
    label = (label or "").strip() or None
    asset_type = (asset_type or "").strip() or None
    asset_id = (asset_id or "").strip() or None

    results: List[Dict[str, Any]] = []
    for child in sorted(issues_dir.iterdir()):
        match = _ISSUE_FILE_RE.match(child.name)
        if not match:
            continue
        meta, body = _split_frontmatter(child.read_text(encoding="utf-8"))
        issue_id = str(meta.get("id") or child.name[:-3])
        labels = _normalize_labels(meta.get("labels"))
        if status and str(meta.get("status") or "open") != status:
            continue
        if label and label not in labels:
            continue
        if asset_type and (meta.get("asset_type") or None) != asset_type:
            continue
        if asset_id and (meta.get("asset_id") or None) != asset_id:
            continue
        results.append(
            _issue_to_dict(meta, body, len(_read_comments(workspace, issue_id)))
        )
    return results


def get_issue(issue_id: str) -> Dict[str, Any]:
    from services.git_service import _git_workspace

    issue_id = _validate_issue_id(issue_id)
    workspace = _git_workspace()
    meta, body = _load_issue(workspace, issue_id)
    comments = _read_comments(workspace, issue_id)
    issue = _issue_to_dict(meta, body, len(comments))
    issue["comments"] = comments
    return issue


def update_issue(
    issue_id: str,
    *,
    title: Optional[str] = None,
    body: Optional[str] = None,
    status: Optional[str] = None,
    labels: Optional[List[str]] = None,
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
    clear_asset: bool = False,
    author_name: str = "Floom",
    author_email: str = "workeros@local",
) -> Dict[str, Any]:
    from db import now_iso
    from services.git_service import _git_workspace

    issue_id = _validate_issue_id(issue_id)
    workspace = _git_workspace()
    meta, current_body = _load_issue(workspace, issue_id)

    if title is not None:
        new_title = title.strip()
        if not new_title:
            raise IssueError("title cannot be empty")
        meta["title"] = new_title
    if status is not None:
        status = status.strip()
        if status not in ISSUE_STATUSES:
            raise IssueError(
                f"Invalid status {status!r} (expected one of {', '.join(ISSUE_STATUSES)})"
            )
        meta["status"] = status
    if labels is not None:
        meta["labels"] = _normalize_labels(labels)
    if clear_asset:
        meta["asset_type"] = None
        meta["asset_id"] = None
    elif asset_type is not None or asset_id is not None:
        bound_type, bound_id = _validate_asset_binding(asset_type, asset_id)
        meta["asset_type"] = bound_type
        meta["asset_id"] = bound_id
    if body is not None:
        current_body = body

    meta["updated_at"] = now_iso()
    md_path = workspace / _issue_md_rel(issue_id)
    md_path.write_text(_serialize_issue(meta, current_body), encoding="utf-8")
    _commit_paths(
        workspace,
        [_issue_md_rel(issue_id)],
        f"issues: update {issue_id}",
        author_name,
        author_email,
    )

    return _issue_to_dict(
        meta, current_body.strip(), len(_read_comments(workspace, issue_id))
    )


def close_issue(
    issue_id: str, *, author_name: str = "Floom", author_email: str = "workeros@local"
) -> Dict[str, Any]:
    return update_issue(
        issue_id, status="closed", author_name=author_name, author_email=author_email
    )


def reopen_issue(
    issue_id: str, *, author_name: str = "Floom", author_email: str = "workeros@local"
) -> Dict[str, Any]:
    return update_issue(
        issue_id, status="open", author_name=author_name, author_email=author_email
    )


def add_comment(
    issue_id: str,
    *,
    body: str,
    created_by: str,
    author_name: str = "Floom",
    author_email: str = "workeros@local",
) -> Dict[str, Any]:
    from db import now_iso
    from services.git_service import _git_workspace

    issue_id = _validate_issue_id(issue_id)
    body = (body or "").strip()
    if not body:
        raise IssueError("comment body is required")

    workspace = _git_workspace()
    meta, issue_body = _load_issue(workspace, issue_id)

    comment = {
        "id": f"cmt_{secrets.token_hex(8)}",
        "body": body,
        "created_by": created_by,
        "created_at": now_iso(),
    }
    comments_path = workspace / _issue_comments_rel(issue_id)
    with comments_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(comment, ensure_ascii=False) + "\n")

    # Touch the issue so updated_at reflects the new activity.
    meta["updated_at"] = comment["created_at"]
    md_path = workspace / _issue_md_rel(issue_id)
    md_path.write_text(_serialize_issue(meta, issue_body), encoding="utf-8")

    _commit_paths(
        workspace,
        [_issue_comments_rel(issue_id), _issue_md_rel(issue_id)],
        f"issues: comment on {issue_id}",
        author_name,
        author_email,
    )
    return comment
