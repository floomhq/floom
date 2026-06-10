#!/usr/bin/env python3
"""One-shot backfill: copy WhatsApp sender bindings from SQLite into Supabase.

IDEMPOTENT: rows already present in Supabase (matched by wa_id) are skipped via
``upsert ... on_conflict=wa_id``.  Safe to run multiple times.

Usage:
    WORKEROS_DEPLOY=cloud \\
    SUPABASE_URL=https://... \\
    SUPABASE_SERVICE_ROLE_KEY=... \\
    FLOOM_DB=/opt/workeros-cloud/var/floom.db \\
    python scripts/backfill_wa_bindings.py

For a dry-run (print rows but do not write to Supabase):
    ... python scripts/backfill_wa_bindings.py --dry-run
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dry-run", action="store_true", help="Print rows but do not write to Supabase")
    p.add_argument(
        "--db",
        default=os.environ.get("FLOOM_DB", "/opt/workeros-cloud/var/floom.db"),
        help="Path to the SQLite database (default: $FLOOM_DB or /opt/workeros-cloud/var/floom.db)",
    )
    return p.parse_args()


def _read_sqlite_bindings(db_path: str) -> list[dict]:
    if not Path(db_path).exists():
        print(f"[backfill] SQLite DB not found: {db_path}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        """
        SELECT
            wa_id,
            user_id,
            workspace_id,
            profile_name,
            status,
            claim_token,
            claim_expires_at,
            created_at,
            updated_at,
            last_seen_at
        FROM whatsapp_sender_bindings
        ORDER BY created_at
        """
    )
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def _to_supabase_row(row: dict) -> dict:
    """Convert a SQLite row dict into a Supabase-compatible payload."""
    def _ts(value: str | None) -> str | None:
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except Exception:
            return value

    return {
        "wa_id": row["wa_id"],
        "user_id": row["user_id"] or None,
        # NULL workspace_id in SQLite → default to 'local-default' in cloud too.
        # NOTE: this is the string ID; cloud Supabase stores real UUID workspace_id
        # (from the workspaces table).  A NULL here means the binding predates
        # Phase 3.  Leave as NULL for now; it will be set when the user re-claims.
        "workspace_id": row.get("workspace_id") or None,
        "profile_name": row["profile_name"] or None,
        "status": row["status"] or "pending",
        "claim_token": row["claim_token"] or None,
        "claim_expires_at": _ts(row.get("claim_expires_at")),
        "created_at": _ts(row["created_at"]) or datetime.now(timezone.utc).isoformat(),
        "updated_at": _ts(row["updated_at"]) or datetime.now(timezone.utc).isoformat(),
        "last_seen_at": _ts(row.get("last_seen_at")),
    }


def main() -> None:
    args = _parse_args()

    rows = _read_sqlite_bindings(args.db)
    print(f"[backfill] Found {len(rows)} row(s) in SQLite whatsapp_sender_bindings.")

    if not rows:
        print("[backfill] Nothing to backfill. Done.")
        return

    supabase_rows = [_to_supabase_row(r) for r in rows]

    for r in supabase_rows:
        print(
            f"  wa_id={r['wa_id']!r}  status={r['status']!r}  "
            f"user_id={r['user_id']!r}  workspace_id={r['workspace_id']!r}"
        )

    if args.dry_run:
        print("[backfill] Dry-run mode: no writes performed.")
        return

    # Validate Supabase env vars before importing.
    url = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or ""
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SECRET_KEY")
        or ""
    )
    if not url or not key:
        print(
            "[backfill] ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Add the cloud api dir to path so the config module is importable.
    repo_root = Path(__file__).resolve().parents[1]
    api_dir = repo_root / "apps" / "api"
    if str(api_dir) not in sys.path:
        sys.path.insert(0, str(repo_root))
        sys.path.insert(0, str(api_dir))

    # Ensure WORKEROS_DEPLOY=cloud so config module resolves the right client.
    os.environ["WORKEROS_DEPLOY"] = "cloud"

    from apps.api.config import get_supabase_service_client  # noqa: E402
    sb = get_supabase_service_client()

    # Upsert in one batch (idempotent via on_conflict=wa_id).
    resp = sb.table("whatsapp_sender_bindings").upsert(
        supabase_rows, on_conflict="wa_id"
    ).execute()
    upserted = len(resp.data or [])
    print(f"[backfill] Upserted {upserted} row(s) into Supabase whatsapp_sender_bindings. Done.")


if __name__ == "__main__":
    main()
