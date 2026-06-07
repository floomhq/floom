"""Thin GitHub REST API client for WorkerOS git workspace integration.

Uses stdlib urllib only — no extra dependencies.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Optional

GITHUB_API = "https://api.github.com"
WORKEROS_TOPIC = "workeros-workspace"
WORKEROS_NAME_PREFIX = "workeros-"


class GitHubAPIError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


def _call(method: str, path: str, pat: str, body: dict | None = None, timeout: int = 15) -> Any:
    url = f"{GITHUB_API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"token {pat}",
            # mercy-preview header makes GitHub include topics in repo list responses
            "Accept": "application/vnd.github.mercy-preview+json",
            "Content-Type": "application/json",
            "User-Agent": "WorkerOS/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body_bytes = exc.read()
        try:
            msg = json.loads(body_bytes).get("message", body_bytes.decode())
        except Exception:
            msg = body_bytes.decode("utf-8", errors="replace")
        raise GitHubAPIError(msg, exc.code) from exc
    except urllib.error.URLError as exc:
        raise GitHubAPIError(f"Network error: {exc.reason}") from exc


def validate_pat(pat: str) -> dict:
    """Verify PAT is valid and return the authenticated user's info."""
    return _call("GET", "/user", pat)


def list_workeros_repos(pat: str) -> list[dict]:
    """List repos owned by the authed user that look like WorkerOS workspaces.

    Matches by name prefix (workeros-*) OR by the workeros-workspace topic.
    Only returns repos the token owner can push to.
    """
    repos = _call("GET", "/user/repos?per_page=100&type=owner&sort=updated", pat)
    result = []
    for r in repos:
        name: str = r.get("name", "")
        topics: list = r.get("topics") or []
        if name.startswith(WORKEROS_NAME_PREFIX) or WORKEROS_TOPIC in topics:
            result.append(_repo_summary(r))
    return result


def create_workeros_repo(pat: str, name: str) -> dict:
    """Create a new private GitHub repo and tag it with the workeros topic."""
    if not name.startswith(WORKEROS_NAME_PREFIX):
        name = f"{WORKEROS_NAME_PREFIX}{name}"
    repo = _call("POST", "/user/repos", pat, {
        "name": name,
        "private": True,
        "description": "WorkerOS workspace — workers, contexts, and instructions",
        "auto_init": False,
    })
    # Add the topic so future listing picks it up even if name changes
    try:
        _call("PUT", f"/repos/{repo['full_name']}/topics", pat, {"names": [WORKEROS_TOPIC]})
    except GitHubAPIError:
        pass  # Non-fatal — repo is created, topic is cosmetic
    return _repo_summary(repo)


def _repo_summary(r: dict) -> dict:
    return {
        "full_name": r["full_name"],
        "name": r["name"],
        "url": r.get("html_url", f"https://github.com/{r['full_name']}"),
        "private": r.get("private", True),
        "description": r.get("description"),
        "pushed_at": r.get("pushed_at"),
        "clone_url": r.get("clone_url", f"https://github.com/{r['full_name']}.git"),
    }


# ---------------------------------------------------------------------------
# GitHub Actions Variables API
#
# Variables are readable via the API (unlike Secrets which are write-only).
# We use a repo variable to store the WorkerOS secrets encryption key so that:
#   - Any valid PAT with repo access can read it (PAT rotation safe)
#   - Two installs pointing at the same repo share the same key
#   - The key lives in the repo, not derived from the token
# Security model: repo access = key access = secrets access (correct for private repos)
# ---------------------------------------------------------------------------

_SECRETS_KEY_VAR = "WORKEROS_SECRETS_KEY"


def get_secrets_key(pat: str, repo_full_name: str) -> Optional[bytes]:
    """Read the workspace secrets key from the repo's Actions variables.

    Returns raw 32 bytes, or None if the variable doesn't exist yet.
    """
    from base64 import b64decode
    try:
        result = _call("GET", f"/repos/{repo_full_name}/actions/variables/{_SECRETS_KEY_VAR}", pat)
        return b64decode(result["value"])
    except GitHubAPIError as exc:
        if exc.status == 404:
            return None
        raise


def set_secrets_key(pat: str, repo_full_name: str, key: bytes) -> None:
    """Write or update the workspace secrets key as a repo Actions variable."""
    from base64 import b64encode
    encoded = b64encode(key).decode("ascii")
    # Try update first, fall back to create
    try:
        _call("PATCH", f"/repos/{repo_full_name}/actions/variables/{_SECRETS_KEY_VAR}", pat,
              {"name": _SECRETS_KEY_VAR, "value": encoded})
    except GitHubAPIError as exc:
        if exc.status == 404:
            _call("POST", f"/repos/{repo_full_name}/actions/variables", pat,
                  {"name": _SECRETS_KEY_VAR, "value": encoded})
        else:
            raise


# ---------------------------------------------------------------------------
# GitHub Contents API
#
# Allows creating/updating individual files in a repo without a local git
# clone. Used by the cloud GitOps path where there is no persistent disk.
# ---------------------------------------------------------------------------

def get_file_sha(pat: str, repo_full_name: str, path: str) -> Optional[str]:
    """Return the blob SHA of an existing file, or None if not found.

    Required for PUT (update) calls — GitHub rejects updates without the
    current SHA to prevent unintentional overwrites.
    """
    try:
        result = _call("GET", f"/repos/{repo_full_name}/contents/{path}", pat)
        return result.get("sha")
    except GitHubAPIError as exc:
        if exc.status == 404:
            return None
        raise


def put_file(
    pat: str,
    repo_full_name: str,
    path: str,
    content: bytes,
    message: str,
    sha: Optional[str] = None,
) -> None:
    """Create or update a single file in the repo via the Contents API.

    If sha is None the file will be fetched first to get the current SHA
    (needed for updates). Pass sha explicitly to avoid an extra round-trip
    when you already have it.
    """
    from base64 import b64encode
    if sha is None:
        sha = get_file_sha(pat, repo_full_name, path)
    body: dict = {
        "message": message,
        "content": b64encode(content).decode("ascii"),
    }
    if sha:
        body["sha"] = sha
    _call("PUT", f"/repos/{repo_full_name}/contents/{path}", pat, body)


def list_repo_tree(pat: str, repo_full_name: str, ref: str = "HEAD") -> list[dict]:
    """Return the full recursive tree of the repo at ref.

    Each entry: {path, type, sha} where type is 'blob' or 'tree'.
    Used by the import flow to discover all worker/context files.
    """
    try:
        result = _call("GET", f"/repos/{repo_full_name}/git/trees/{ref}?recursive=1", pat)
        return result.get("tree", [])
    except GitHubAPIError as exc:
        if exc.status == 404:
            return []
        raise


def get_file_content(pat: str, repo_full_name: str, path: str) -> Optional[str]:
    """Return the decoded text content of a file, or None if not found."""
    from base64 import b64decode
    try:
        result = _call("GET", f"/repos/{repo_full_name}/contents/{path}", pat)
        encoded = result.get("content", "")
        return b64decode(encoded.replace("\n", "")).decode("utf-8")
    except GitHubAPIError as exc:
        if exc.status == 404:
            return None
        raise


