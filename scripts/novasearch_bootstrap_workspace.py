#!/usr/bin/env python3
"""Bootstrap the NovaSearch WorkerOS workspace and Brain pack.

Dry-run is the default. Production writes only happen with --apply and an
explicit --email. This script intentionally does not touch nova-api.floom.dev.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import sqlite3
import sys
import uuid
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from supabase import create_client


DEFAULT_ENV = Path("/etc/workeros-cloud/api.env")
DEFAULT_DB = Path("/opt/novasearch-backend/data/candidates.db")
DEFAULT_CONTEXTS_ROOT = Path("/opt/workeros-cloud/var/contexts")
DEFAULT_WORKSPACE_NAME = "NovaSearch"
DEFAULT_PACK_NAME = "novasearch-data"


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def _env(env_file: Path, *names: str) -> str | None:
    file_values = _load_env_file(env_file)
    for name in names:
        value = (os.environ.get(name) or file_values.get(name) or "").strip()
        if value:
            return value
    return None


def _workspace_id() -> str:
    return "ws_" + uuid.uuid4().hex[:14]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_stats(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"source database not found: {path}")
    with sqlite3.connect(path) as conn:
        tables = [
            row[0]
            for row in conn.execute(
                "select name from sqlite_master where type='table' order by name"
            ).fetchall()
        ]
        counts: dict[str, int] = {}
        for table in tables:
            try:
                counts[table] = int(conn.execute(f'select count(*) from "{table}"').fetchone()[0])
            except sqlite3.Error:
                continue
    return {
        "path": str(path),
        "size_bytes": path.stat().st_size,
        "tables": tables,
        "counts": counts,
    }


def _find_public_user(client: Any, email: str) -> dict[str, Any] | None:
    response = (
        client.table("users")
        .select("id,email")
        .eq("email", email)
        .limit(1)
        .execute()
    )
    rows = getattr(response, "data", None) or []
    return dict(rows[0]) if rows else None


def _find_auth_user_by_email(*, supabase_url: str, service_key: str, email: str) -> dict[str, str] | None:
    """Find an existing Supabase Auth user by email via the admin API.

    The Python client can create users through ``auth.admin`` but the list-user
    surface varies by installed supabase-py version. The HTTP admin endpoint is
    stable and keeps this bootstrap safe when Auth already has a user but
    ``public.users`` was never written.
    """
    base = supabase_url.rstrip("/")
    page = 1
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }
    while True:
        query = urllib.parse.urlencode({"page": page, "per_page": 100})
        request = urllib.request.Request(f"{base}/auth/v1/admin/users?{query}", headers=headers)
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
        users = payload.get("users") if isinstance(payload, dict) else []
        if not users:
            return None
        for user in users:
            if str(user.get("email") or "").strip().lower() == email:
                user_id = str(user.get("id") or "").strip()
                if not user_id:
                    raise RuntimeError(f"Supabase auth user for {email} has no id")
                return {"id": user_id, "email": email}
        if len(users) < 100:
            return None
        page += 1


def _create_auth_user(client: Any, email: str, password: str | None) -> dict[str, str]:
    raw_password = password or ("NovaSearch-" + secrets.token_urlsafe(18))
    response = client.auth.admin.create_user(
        {
            "email": email,
            "password": raw_password,
            "email_confirm": True,
        }
    )
    user = getattr(response, "user", None)
    if user is None or not getattr(user, "id", None):
        raise RuntimeError("Supabase admin create_user returned no user")
    return {"id": str(user.id), "email": email, "password": raw_password}


def _upsert_public_user(client: Any, user_id: str, email: str) -> None:
    client.table("users").upsert(
        {
            "id": user_id,
            "email": email,
            "updated_at": _now_iso(),
        },
        on_conflict="id",
    ).execute()


def _find_workspace(client: Any, user_id: str, name: str) -> dict[str, Any] | None:
    response = (
        client.table("workspaces")
        .select("id,name,owner_user_id,created_at")
        .eq("owner_user_id", user_id)
        .eq("name", name)
        .limit(1)
        .execute()
    )
    rows = getattr(response, "data", None) or []
    return dict(rows[0]) if rows else None


def _create_workspace(client: Any, user_id: str, name: str) -> dict[str, Any]:
    workspace = {
        "id": _workspace_id(),
        "owner_user_id": user_id,
        "name": name,
        "created_at": _now_iso(),
    }
    client.table("workspaces").insert(workspace).execute()
    return workspace


def _write_brain_pack(
    *,
    contexts_root: Path,
    workspace_id: str,
    pack_name: str,
    source_db: Path,
    owner_id: str,
    apply: bool,
) -> dict[str, Any]:
    scoped_root = contexts_root / workspace_id
    pack_dir = scoped_root / pack_name
    target_db = pack_dir / "candidates.db"
    metadata_path = scoped_root / ".workeros-contexts.json"

    result = {
        "scoped_root": str(scoped_root),
        "pack_dir": str(pack_dir),
        "target_db": str(target_db),
        "metadata_path": str(metadata_path),
        "would_overwrite": target_db.exists(),
    }
    if not apply:
        return result

    pack_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_db, target_db)

    metadata: dict[str, Any] = {}
    if metadata_path.is_file():
        try:
            parsed = json.loads(metadata_path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                metadata = parsed
        except json.JSONDecodeError:
            metadata = {}
    metadata[pack_name] = {
        **(metadata.get(pack_name) or {}),
        "owner_id": owner_id,
        "writeable": False,
        "updated_at": _now_iso(),
    }
    metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap NovaSearch workspace and Brain pack")
    parser.add_argument("--apply", action="store_true", help="perform writes; default is dry-run")
    parser.add_argument("--email", help="target account email; required with --apply")
    parser.add_argument("--password", help="optional password for a newly-created auth user")
    parser.add_argument("--workspace-name", default=DEFAULT_WORKSPACE_NAME)
    parser.add_argument("--pack-name", default=DEFAULT_PACK_NAME)
    parser.add_argument("--source-db", default=str(DEFAULT_DB))
    parser.add_argument("--contexts-root", default=str(DEFAULT_CONTEXTS_ROOT))
    parser.add_argument("--env-file", default=str(DEFAULT_ENV))
    args = parser.parse_args()

    if args.apply and not args.email:
        print("--email is required with --apply", file=sys.stderr)
        return 2

    source_db = Path(args.source_db)
    contexts_root = Path(args.contexts_root)
    env_file = Path(args.env_file)
    report: dict[str, Any] = {
        "apply": bool(args.apply),
        "workspace_name": args.workspace_name,
        "pack_name": args.pack_name,
        "source_db": _db_stats(source_db),
        "contexts_root": str(contexts_root),
    }

    if not args.apply:
        report["next"] = "Run with --apply --email <target> to create/update WorkerOS Cloud rows and Brain pack."
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    url = _env(env_file, "SUPABASE_URL", "WORKEROS_CLOUD_SUPABASE_URL")
    service_key = _env(env_file, "SUPABASE_SERVICE_ROLE_KEY", "WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not service_key:
        print("Missing Supabase URL or service role key", file=sys.stderr)
        return 2
    client = create_client(url, service_key)

    email = str(args.email).strip().lower()
    public_user = _find_public_user(client, email)
    created_password: str | None = None
    if public_user:
        user_id = str(public_user["id"])
        user_created = False
    else:
        existing_auth = _find_auth_user_by_email(
            supabase_url=url,
            service_key=service_key,
            email=email,
        )
        if existing_auth:
            user_id = existing_auth["id"]
            user_created = False
        else:
            created = _create_auth_user(client, email, args.password)
            user_id = created["id"]
            created_password = created["password"]
            user_created = True
        _upsert_public_user(client, user_id, email)

    workspace = _find_workspace(client, user_id, args.workspace_name)
    workspace_created = False
    if workspace is None:
        workspace = _create_workspace(client, user_id, args.workspace_name)
        workspace_created = True

    brain = _write_brain_pack(
        contexts_root=contexts_root,
        workspace_id=str(workspace["id"]),
        pack_name=args.pack_name,
        source_db=source_db,
        owner_id=user_id,
        apply=True,
    )
    target_stats = _db_stats(Path(brain["target_db"]))
    report.update(
        {
            "email": email,
            "user_id": user_id,
            "user_created": user_created,
            "workspace": workspace,
            "workspace_created": workspace_created,
            "brain": brain,
            "target_db": target_stats,
            "created_password_returned_once": bool(created_password),
        }
    )
    if created_password:
        report["created_password"] = created_password
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
