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
# GitHub Actions Secrets API
#
# GitHub secrets are WRITE-ONLY from the API — values can never be read back.
# Values must be encrypted with the repo's NaCl public key before uploading.
# ---------------------------------------------------------------------------

def _encrypt_secret(public_key_b64: str, value: str) -> str:
    """Encrypt value with the repo's NaCl public key (libsodium sealed box)."""
    from base64 import b64decode, b64encode
    from nacl import encoding, public as nacl_public

    pk = nacl_public.PublicKey(b64decode(public_key_b64), encoding.RawEncoder)
    box = nacl_public.SealedBox(pk)
    encrypted = box.encrypt(value.encode("utf-8"))
    return b64encode(encrypted).decode("utf-8")


def set_secret(pat: str, repo_full_name: str, name: str, value: str) -> None:
    """Create or update a GitHub Actions secret on the repo.

    Values are encrypted client-side with the repo's public key before
    transmission — GitHub never receives the plaintext.
    """
    key_info = _call("GET", f"/repos/{repo_full_name}/actions/secrets/public-key", pat)
    encrypted = _encrypt_secret(key_info["key"], value)
    _call(
        "PUT",
        f"/repos/{repo_full_name}/actions/secrets/{name}",
        pat,
        {"encrypted_value": encrypted, "key_id": key_info["key_id"]},
    )


def delete_secret(pat: str, repo_full_name: str, name: str) -> None:
    """Delete a GitHub Actions secret from the repo."""
    _call("DELETE", f"/repos/{repo_full_name}/actions/secrets/{name}", pat)


def list_secret_names(pat: str, repo_full_name: str) -> list[str]:
    """List the names of GitHub Actions secrets on the repo.

    NOTE: GitHub intentionally never exposes secret values via API.
    This returns names only — useful for showing users what needs to be
    configured on a fresh install.
    """
    result = _call(
        "GET",
        f"/repos/{repo_full_name}/actions/secrets?per_page=100",
        pat,
    )
    return [s["name"] for s in result.get("secrets", [])]
