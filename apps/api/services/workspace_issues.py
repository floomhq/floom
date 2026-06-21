"""Workspace issues: a thin GitHub-Issues-backed operating loop for a workspace.

GitHub Issues are the source of truth. Floom keeps no separate issue database;
it projects each GitHub issue into a ``WorkspaceIssue`` view and binds it to a
concrete workspace asset (worker, context file, run, ...) via a hidden,
versioned metadata marker embedded in the issue body:

    <!-- floom:issue
    version: 1
    workspace_id: ws_...
    asset_type: worker
    asset_id: gmail-inbox-manager
    source: run_failure
    -->

The marker is parsed back out to recover the binding, so the issue stays the
canonical record even when edited on GitHub. Labels (``floom``, ``workspace``,
the asset type, ...) are applied alongside the marker for GitHub-native
filtering and as a fallback when a marker is missing or from an older version.

The PAT and target repository come from the workspace's existing GitHub
connection (``services.git_service._git_cfg_get``); no new configuration is
introduced. When GitHub is not connected, operations raise
``GitHubNotConnected`` with an actionable message instead of failing silently.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel

# Marker format version. Bump only on a breaking change to the marker layout so
# older issues stay parseable; parse_metadata_marker tolerates unknown versions.
MARKER_VERSION = 1

_MARKER_OPEN = "<!-- floom:issue"
_MARKER_CLOSE = "-->"
# Matches the whole marker block (and any surrounding blank lines) so it can be
# stripped from the body shown to users and re-emitted cleanly on update.
_MARKER_RE = re.compile(
    r"\n*<!--\s*floom:issue\b(?P<inner>.*?)-->\s*",
    re.DOTALL | re.IGNORECASE,
)

# Asset types supported on day one (issue #1773 MVP scope). Others are accepted
# but flagged so callers can decide how strict to be; the marker itself is open.
SUPPORTED_ASSET_TYPES = ("worker", "context", "run", "connection", "approval", "mcp")

# Labels every Floom-created issue carries, for GitHub-native filtering.
BASE_LABELS = ("floom", "workspace")


class GitHubNotConnected(Exception):
    """Raised when the workspace has no usable GitHub repo connection."""


class WorkspaceIssue(BaseModel):
    """A GitHub issue projected into Floom's workspace/asset model."""

    id: str
    workspace_id: Optional[str] = None
    github_issue_number: int
    github_url: str
    title: str
    body: Optional[str] = None
    state: str = "open"
    labels: List[str] = []
    asset_type: Optional[str] = None
    asset_id: Optional[str] = None
    source: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Metadata marker (versioned, stable)
# ---------------------------------------------------------------------------

def build_metadata_marker(
    workspace_id: Optional[str] = None,
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
    source: Optional[str] = None,
) -> str:
    """Render the hidden ``floom:issue`` marker block.

    Always includes ``version`` so the layout can evolve. Empty fields are
    omitted to keep the block compact and forward-compatible.
    """
    lines = [f"version: {MARKER_VERSION}"]
    for key, value in (
        ("workspace_id", workspace_id),
        ("asset_type", asset_type),
        ("asset_id", asset_id),
        ("source", source),
    ):
        if value is not None and str(value).strip():
            lines.append(f"{key}: {str(value).strip()}")
    inner = "\n".join(lines)
    return f"{_MARKER_OPEN}\n{inner}\n{_MARKER_CLOSE}"


def parse_metadata_marker(body: Optional[str]) -> Optional[Dict[str, Any]]:
    """Extract the marker fields from an issue body, or None if absent.

    Tolerant of unknown ``version`` values and extra keys so newer issues
    remain readable by older code and vice versa.
    """
    if not body:
        return None
    match = _MARKER_RE.search(body)
    if not match:
        return None
    fields: Dict[str, Any] = {}
    for line in match.group("inner").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip().lower()
        value = value.strip()
        if not key:
            continue
        if key == "version":
            try:
                fields["version"] = int(value)
            except ValueError:
                fields["version"] = value
        else:
            fields[key] = value
    return fields or None


def strip_metadata_marker(body: Optional[str]) -> str:
    """Return the issue body with the marker block removed, for display."""
    if not body:
        return ""
    return _MARKER_RE.sub("\n", body).strip()


def compose_issue_body(
    body: Optional[str],
    workspace_id: Optional[str] = None,
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
    source: Optional[str] = None,
) -> str:
    """Append a fresh marker to a (marker-stripped) body."""
    clean = strip_metadata_marker(body)
    marker = build_metadata_marker(workspace_id, asset_type, asset_id, source)
    return f"{clean}\n\n{marker}" if clean else marker


# ---------------------------------------------------------------------------
# Labels + projection
# ---------------------------------------------------------------------------

def derive_labels(asset_type: Optional[str], extra: Optional[List[str]] = None) -> List[str]:
    """Build the label set for a Floom-created issue (deduped, order-stable)."""
    labels: List[str] = list(BASE_LABELS)
    if asset_type:
        labels.append(str(asset_type).strip().lower())
    for label in extra or []:
        cleaned = str(label).strip()
        if cleaned:
            labels.append(cleaned)
    seen: set[str] = set()
    out: List[str] = []
    for label in labels:
        if label not in seen:
            seen.add(label)
            out.append(label)
    return out


def project_issue(raw: Dict[str, Any], workspace_id: Optional[str] = None) -> WorkspaceIssue:
    """Project a raw GitHub issue dict into a WorkspaceIssue.

    Asset binding is recovered from the body marker first; when the marker is
    missing (e.g. an issue created outside Floom) the asset_type falls back to a
    recognised label so externally-filed issues still classify.
    """
    number = int(raw.get("number") or 0)
    body = raw.get("body")
    marker = parse_metadata_marker(body) or {}
    labels = [
        (lab.get("name") if isinstance(lab, dict) else str(lab))
        for lab in (raw.get("labels") or [])
    ]
    labels = [str(lab) for lab in labels if lab]

    asset_type = marker.get("asset_type")
    if not asset_type:
        asset_type = next((lab for lab in labels if lab in SUPPORTED_ASSET_TYPES), None)

    user = raw.get("user") or {}
    return WorkspaceIssue(
        id=f"issue_{number}",
        workspace_id=marker.get("workspace_id") or workspace_id,
        github_issue_number=number,
        github_url=raw.get("html_url") or "",
        title=raw.get("title") or "",
        body=strip_metadata_marker(body),
        state=raw.get("state") or "open",
        labels=labels,
        asset_type=asset_type,
        asset_id=marker.get("asset_id"),
        source=marker.get("source"),
        created_by=user.get("login") if isinstance(user, dict) else None,
        created_at=raw.get("created_at"),
        updated_at=raw.get("updated_at"),
    )


# ---------------------------------------------------------------------------
# GitHub connection resolution
# ---------------------------------------------------------------------------

def resolve_connection(user_id: str) -> tuple[str, str]:
    """Return ``(pat, repo_full_name)`` for the workspace, or raise.

    Raises GitHubNotConnected with an actionable message when no PAT or linked
    repo is configured, so the UI/agent can explain what is missing.
    """
    from services.git_service import _git_cfg_get

    cfg = _git_cfg_get(user_id) or {}
    pat = cfg.get("github_pat")
    repo = cfg.get("repo_full_name")
    if not pat:
        raise GitHubNotConnected(
            "GitHub is not connected for this workspace. Connect a GitHub token "
            "in Settings → GitHub before using workspace issues."
        )
    if not repo:
        raise GitHubNotConnected(
            "No GitHub repository is linked to this workspace. Link a repo in "
            "Settings → GitHub before using workspace issues."
        )
    return str(pat), str(repo)


# ---------------------------------------------------------------------------
# High-level operations (shared by the HTTP router and Emily's tools)
# ---------------------------------------------------------------------------

def list_workspace_issues(
    user_id: str,
    state: str = "all",
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
) -> List[WorkspaceIssue]:
    """List workspace issues, optionally filtered by asset binding."""
    import github_api as _gh
    from services.git_service import _git_workspace_key

    pat, repo = resolve_connection(user_id)
    workspace_id = _git_workspace_key(user_id)
    # Only Floom-tracked issues by default; keeps the view scoped to the
    # workspace loop rather than every issue in the repo.
    raw = _gh.list_issues(pat, repo, state=state, labels=["floom"])
    issues = [project_issue(item, workspace_id) for item in raw]
    if asset_type:
        issues = [i for i in issues if i.asset_type == asset_type]
    if asset_id:
        issues = [i for i in issues if i.asset_id == asset_id]
    return issues


def create_workspace_issue(
    user_id: str,
    title: str,
    body: Optional[str] = None,
    asset_type: Optional[str] = None,
    asset_id: Optional[str] = None,
    source: Optional[str] = None,
    labels: Optional[List[str]] = None,
) -> WorkspaceIssue:
    """Create a GitHub-backed workspace issue with marker + labels."""
    import github_api as _gh
    from services.git_service import _git_workspace_key

    title = (title or "").strip()
    if not title:
        raise ValueError("Issue title cannot be empty")

    pat, repo = resolve_connection(user_id)
    workspace_id = _git_workspace_key(user_id)
    full_body = compose_issue_body(body, workspace_id, asset_type, asset_id, source)
    created = _gh.create_issue(
        pat, repo, title, full_body, derive_labels(asset_type, labels)
    )
    return project_issue(created, workspace_id)


def comment_on_issue(user_id: str, number: int, body: str) -> Dict[str, Any]:
    """Add a comment to a workspace issue."""
    import github_api as _gh

    if not (body or "").strip():
        raise ValueError("Comment body cannot be empty")
    pat, repo = resolve_connection(user_id)
    comment = _gh.create_issue_comment(pat, repo, int(number), body)
    return {"id": comment.get("id"), "url": comment.get("html_url")}


def update_workspace_issue(
    user_id: str,
    number: int,
    title: Optional[str] = None,
    body: Optional[str] = None,
    state: Optional[str] = None,
    labels: Optional[List[str]] = None,
) -> WorkspaceIssue:
    """Patch an issue's title/body/state/labels and re-project it.

    When body is updated the existing asset marker is preserved so the binding
    survives edits made through Floom.
    """
    import github_api as _gh
    from services.git_service import _git_workspace_key

    pat, repo = resolve_connection(user_id)
    workspace_id = _git_workspace_key(user_id)

    new_body: Optional[str] = None
    if body is not None:
        existing = parse_metadata_marker(_gh.get_issue(pat, repo, int(number)).get("body")) or {}
        new_body = compose_issue_body(
            body,
            existing.get("workspace_id") or workspace_id,
            existing.get("asset_type"),
            existing.get("asset_id"),
            existing.get("source"),
        )
    updated = _gh.update_issue(
        pat, repo, int(number), title=title, body=new_body, state=state, labels=labels
    )
    return project_issue(updated, workspace_id)
