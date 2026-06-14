#!/usr/bin/env python3
"""Apply pending Supabase migrations via the Management API.

Usage:
    python scripts/apply_pending_migrations.py [--dry-run | --apply]

    --dry-run  (default) List pending migrations without applying.
    --apply    Apply pending migrations and record them in _schema_migrations.

Design:
    - Tracking table: public._schema_migrations (id TEXT PK, applied_at TIMESTAMPTZ)
    - Migrations are discovered from supabase/migrations/*.sql in lexical order.
    - Each migration NOT already in _schema_migrations is "pending".
    - Backfill: on first run, all migrations whose DDL objects already exist in prod
      are seeded into _schema_migrations as already-applied WITHOUT re-executing them.
      Everything already in prod is detected via the tracking seed list (0001..0035
      that were applied by hand), so they are marked applied and skipped.
    - Re-runs are idempotent (no-op when no new migrations).
    - Each migration is applied as a single Management API call; the SQL itself
      should be wrapped in BEGIN/COMMIT where transactional rollback is desired
      (the migrations in this repo already do this for complex DDL).

Environment (loaded from /etc/workeros-cloud/migrate.env):
    SUPABASE_MANAGEMENT_PAT   Management API personal access token
    WORKEROS_CLOUD_PROJECT_REF  Supabase project reference ID
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MIGRATIONS_DIR = Path(__file__).parent.parent / "supabase" / "migrations"
TRACKING_TABLE = "_schema_migrations"

# Migrations that were applied by hand before this script existed.
# These are seeded into _schema_migrations WITHOUT re-running their SQL.
# Filenames are compared by basename (no directory prefix).
ALREADY_APPLIED_BASENAMES = {
    "0001_init.sql",
    "0002_rls.sql",
    "0003_secrets_table_finalize.sql",
    "0004_webhook_secret_hash.sql",
    "0005_workspaces.sql",
    "0006_mcp_connections.sql",
    "0007_cli_auth_devices_pending_user_id.sql",
    "0008_members.sql",
    "0010_api_tokens.sql",
    "0011_approvals.sql",
    "0012_runs_retry_columns.sql",
    "0013_asset_versions.sql",
    "0014_workspace_agent_settings.sql",
    "0015_workspace_api_tokens.sql",
    "0016_mcp_transport_fields.sql",
    "0017_telemetry_events.sql",
    "0018_email_events.sql",
    "0019_workspaces_enable_rls.sql",
    "0020_workspace_share_links.sql",
    "0021_workspace_transfer_events.sql",
    "0022_novasearch_state.sql",
    "0022_workspace_agent_channel_bindings.sql",
    "0023_mcp_tools.sql",
    "0024_runs_member_trigger.sql",
    "0025_worker_triggers.sql",
    "0026_lock_down_public_rls_policies.sql",
    "0026_performance_indexes.sql",
    "0027_get_last_run_fn.sql",
    "0028_force_rls_public_tables.sql",
    "0029_brain_asset_access.sql",
    "0030_git_workspace_config.sql",
    "0031_secrets_vault.sql",
    "0032_worker_alerts.sql",
    "0033_whatsapp_sender_bindings.sql",
    "0033_worker_feedback.sql",
    "0034_slack_installations.sql",
    "0035_approvals_annotations.sql",
}


# ---------------------------------------------------------------------------
# Management API helper
# ---------------------------------------------------------------------------

def management_query(pat: str, project_ref: str, sql: str) -> list[dict]:
    """Execute SQL via the Supabase Management API and return rows."""
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    payload = json.dumps({"query": sql}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {pat}",
            "Content-Type": "application/json",
            # Supabase Management API WAF (Cloudflare) blocks the default
            # Python urllib User-Agent (error 1010). Use a neutral UA.
            "User-Agent": "workeros-cloud-migration/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Management API HTTP {exc.code} for query:\n{sql[:200]}\nResponse: {body}"
        ) from exc


# ---------------------------------------------------------------------------
# Tracking table bootstrap
# ---------------------------------------------------------------------------

CREATE_TRACKING_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS public.{TRACKING_TABLE} (
    id         TEXT        PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


def ensure_tracking_table(pat: str, ref: str) -> None:
    management_query(pat, ref, CREATE_TRACKING_TABLE_SQL)


def get_applied_ids(pat: str, ref: str) -> set[str]:
    rows = management_query(
        pat, ref,
        f"SELECT id FROM public.{TRACKING_TABLE} ORDER BY id"
    )
    return {row["id"] for row in rows}


def record_applied(pat: str, ref: str, migration_id: str) -> None:
    escaped = migration_id.replace("'", "''")
    management_query(
        pat, ref,
        f"INSERT INTO public.{TRACKING_TABLE} (id) VALUES ('{escaped}') ON CONFLICT (id) DO NOTHING"
    )


# ---------------------------------------------------------------------------
# Migration discovery
# ---------------------------------------------------------------------------

def discover_migrations() -> list[Path]:
    """Return all .sql files in migrations dir sorted lexically by filename."""
    if not MIGRATIONS_DIR.exists():
        raise RuntimeError(f"Migrations directory not found: {MIGRATIONS_DIR}")
    files = sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)
    return files


# ---------------------------------------------------------------------------
# Backfill: seed already-applied migrations into tracking table
# ---------------------------------------------------------------------------

def backfill_already_applied(
    pat: str, ref: str, migrations: list[Path], applied_ids: set[str]
) -> set[str]:
    """Seed all known-already-applied migrations into _schema_migrations.

    This is a one-time backfill for the hand-applied migrations (0001..0035).
    Only inserts; never re-runs SQL. Returns the updated set of applied IDs.
    """
    newly_seeded: list[str] = []
    for m in migrations:
        mid = m.name
        if mid in ALREADY_APPLIED_BASENAMES and mid not in applied_ids:
            record_applied(pat, ref, mid)
            applied_ids.add(mid)
            newly_seeded.append(mid)
    if newly_seeded:
        print(f"[backfill] Seeded {len(newly_seeded)} already-applied migrations into {TRACKING_TABLE}:")
        for mid in newly_seeded:
            print(f"  + {mid}")
    return applied_ids


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Apply pending Supabase migrations (default: --apply)."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="List pending migrations without applying (safe, read-only).",
    )
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Apply pending migrations and record in tracking table.",
    )
    args = parser.parse_args()

    # Default mode is --apply (for autodeploy compatibility — no args = apply)
    dry_run = args.dry_run

    # Load credentials from environment (migrate.env is sourced by autodeploy)
    pat = os.environ.get("SUPABASE_MANAGEMENT_PAT", "").strip()
    ref = os.environ.get("WORKEROS_CLOUD_PROJECT_REF", "").strip()

    # Fallback: try reading from the known secrets file directly
    if not pat or not ref:
        secrets_file = Path("/root/.config/floom-secrets/supabase-management.env")
        if secrets_file.exists():
            for line in secrets_file.read_text().splitlines():
                line = line.strip()
                if line.startswith("SUPABASE_MANAGEMENT_PAT=") and not pat:
                    pat = line.split("=", 1)[1].strip()
                elif line.startswith("WORKEROS_CLOUD_PROJECT_REF=") and not ref:
                    ref = line.split("=", 1)[1].strip()

    if not pat:
        print("ERROR: SUPABASE_MANAGEMENT_PAT not set. Set it in /etc/workeros-cloud/migrate.env")
        sys.exit(1)
    if not ref:
        print("ERROR: WORKEROS_CLOUD_PROJECT_REF not set. Set it in /etc/workeros-cloud/migrate.env")
        sys.exit(1)

    mode_label = "DRY-RUN" if dry_run else "APPLY"
    print(f"[{mode_label}] Supabase migration applier — project: {ref}")
    print(f"[{mode_label}] Migrations dir: {MIGRATIONS_DIR}")

    # Discover all migration files
    migrations = discover_migrations()
    print(f"[{mode_label}] Found {len(migrations)} migration file(s)")

    # Bootstrap tracking table
    if not dry_run:
        ensure_tracking_table(pat, ref)

    # Dry-run: create table to read, but we need to read applied regardless
    # For dry-run we still read the tracking table (it may not exist yet)
    try:
        if dry_run:
            # In dry-run, create table if missing so we can read it
            ensure_tracking_table(pat, ref)
        applied_ids = get_applied_ids(pat, ref)
    except Exception as exc:
        if dry_run:
            print(f"[DRY-RUN] Could not read tracking table (may not exist yet): {exc}")
            applied_ids = set()
        else:
            raise

    # Backfill already-applied migrations (idempotent)
    if not dry_run:
        applied_ids = backfill_already_applied(pat, ref, migrations, applied_ids)
    else:
        # In dry-run, show what would be backfilled
        to_backfill = [
            m.name for m in migrations
            if m.name in ALREADY_APPLIED_BASENAMES and m.name not in applied_ids
        ]
        if to_backfill:
            print(f"[DRY-RUN] Would backfill {len(to_backfill)} already-applied migration(s) into tracking table")
            for mid in to_backfill:
                print(f"  ~ {mid} (would seed as applied, no SQL re-run)")
            # Simulate the backfill for dry-run pending calculation
            applied_ids = applied_ids | set(to_backfill)

    # Determine pending migrations
    pending = [m for m in migrations if m.name not in applied_ids]

    if not pending:
        print(f"[{mode_label}] No pending migrations. Database is up to date.")
        return

    print(f"[{mode_label}] {len(pending)} pending migration(s):")
    for m in pending:
        print(f"  ? {m.name}")

    if dry_run:
        print(f"[DRY-RUN] To apply, run with --apply (or no args for autodeploy)")
        return

    # Apply each pending migration
    applied_count = 0
    for m in pending:
        sql = m.read_text(encoding="utf-8")
        print(f"[APPLY] Applying {m.name} ...", flush=True)
        try:
            management_query(pat, ref, sql)
            record_applied(pat, ref, m.name)
            applied_ids.add(m.name)
            applied_count += 1
            print(f"[APPLY]   OK: {m.name}")
        except Exception as exc:
            print(f"[APPLY]   FAILED: {m.name}: {exc}", file=sys.stderr)
            print(
                f"[APPLY] Stopping after failure on {m.name}. "
                f"Fix the migration and re-run. Applied {applied_count}/{len(pending)} so far.",
                file=sys.stderr,
            )
            sys.exit(1)

    print(f"[APPLY] Done. Applied {applied_count} migration(s).")


if __name__ == "__main__":
    main()
