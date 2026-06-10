"""Generate a Personal Access Token (PAT) for a user.

Usage:
    python scripts/generate_pat.py
    python scripts/generate_pat.py --name mytoken
    python scripts/generate_pat.py --email user@example.com  # target a specific user

Reads credentials from .env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
Prints the raw token — copy it and use as: x-floom-token: <value>
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import sys
import os

# Load .env before anything else
from pathlib import Path

env_path = Path(__file__).parent.parent / ".env"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

from supabase import create_client  # noqa: E402

_TOKEN_PREFIX = "floom_"


def _generate_raw_token() -> str:
    return _TOKEN_PREFIX + secrets.token_urlsafe(32)


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a WorkerOS PAT")
    parser.add_argument("--name", default="dev", help="Token name (default: dev)")
    parser.add_argument("--email", default=None, help="Target user email (default: first user found)")
    parser.add_argument("--workspace", default=None, help="Workspace id to scope the token to (default: user's earliest-owned workspace)")
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

    if not url or not key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env", file=sys.stderr)
        sys.exit(1)

    client = create_client(url, key)

    # Find the user
    if args.email:
        resp = client.table("users").select("id, email").eq("email", args.email).limit(1).execute()
    else:
        resp = client.table("users").select("id, email").limit(1).execute()

    if not resp.data:
        print("ERROR: No users found in the users table. Have you logged in yet?", file=sys.stderr)
        sys.exit(1)

    user = resp.data[0]
    user_id = user["id"]
    user_email = user.get("email", "(unknown)")
    print(f"User: {user_email} ({user_id})")

    # Resolve the workspace to scope the token to. api_tokens.workspace_id is
    # NOT NULL with a FK to workspaces, so a valid workspace is required.
    if args.workspace:
        ws_resp = client.table("workspaces").select("id, name").eq("id", args.workspace).limit(1).execute()
    else:
        ws_resp = (
            client.table("workspaces")
            .select("id, name")
            .eq("owner_user_id", user_id)
            .order("created_at")
            .limit(1)
            .execute()
        )
    if not ws_resp.data:
        print(
            "ERROR: no workspace found to scope the token to. Pass --workspace <id> "
            "or ensure the user owns a workspace.",
            file=sys.stderr,
        )
        sys.exit(1)
    workspace_id = ws_resp.data[0]["id"]
    print(f"Workspace: {ws_resp.data[0].get('name', '(unnamed)')} ({workspace_id})")

    # Check existing tokens
    existing = client.table("api_tokens").select("id, name, created_at").eq("user_id", user_id).execute()
    if existing.data:
        print(f"\nExisting tokens ({len(existing.data)}):")
        for t in existing.data:
            print(f"  {t['name']}  (id: {t['id']}, created: {t['created_at']})")
        print("\nRaw values are not stored — generating a new token.")

    # Create a new token. created_at is populated by the DB default.
    raw = _generate_raw_token()
    token_hash = _hash_token(raw)
    client.table("api_tokens").insert({
        "user_id": user_id,
        "workspace_id": workspace_id,
        "name": args.name,
        "token_hash": token_hash,
    }).execute()

    print(f"\n{'='*60}")
    print(f"Token name : {args.name}")
    print(f"Header     : x-floom-token")
    print(f"Value      : {raw}")
    print(f"{'='*60}")
    print("\nSave this — it will NOT be shown again.")


if __name__ == "__main__":
    main()
