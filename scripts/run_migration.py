#!/usr/bin/env python3
"""Run a Supabase migration SQL file via a direct Postgres connection.

Usage:
    python scripts/run_migration.py [migration_file] [db_password]

    migration_file  - path to .sql file (default: supabase/migrations/0011_approvals.sql)
    db_password     - Supabase project DB password (from Dashboard > Settings > Database)

The DB host and project ref are read from the SUPABASE_URL in .env.
"""
from __future__ import annotations

import sys
import os
import re


def main() -> None:
    sql_file = sys.argv[1] if len(sys.argv) > 1 else "supabase/migrations/0011_approvals.sql"
    db_password = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("SUPABASE_DB_PASSWORD", "")

    if not db_password:
        print("ERROR: provide DB password as second arg or set SUPABASE_DB_PASSWORD env var")
        print("  (Dashboard > Settings > Database > Connection string)")
        sys.exit(1)

    # Read project ref from .env
    supabase_url = ""
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    with open(env_path) as f:
        for line in f:
            if line.startswith("SUPABASE_URL="):
                supabase_url = line.strip().split("=", 1)[1]

    project_ref = re.search(r"https://([^.]+)\.supabase\.co", supabase_url)
    if not project_ref:
        print(f"ERROR: could not parse project ref from SUPABASE_URL={supabase_url!r}")
        sys.exit(1)
    ref = project_ref.group(1)

    try:
        import psycopg2
    except ImportError:
        print("Installing psycopg2-binary...")
        os.system(f"{sys.executable} -m pip install psycopg2-binary -q")
        import psycopg2  # noqa: F811

    sql = open(sql_file).read()

    # Try session-mode Supavisor (us-east-1 detected earlier)
    hosts = [
        (f"aws-0-us-east-1.pooler.supabase.com", 5432, f"postgres.{ref}"),
        (f"db.{ref}.supabase.co", 5432, "postgres"),
    ]

    for host, port, user in hosts:
        try:
            print(f"Connecting to {host}:{port} as {user} ...")
            conn = psycopg2.connect(
                host=host, port=port,
                user=user, password=db_password,
                dbname="postgres", connect_timeout=10,
                sslmode="require",
            )
            conn.autocommit = True
            cur = conn.cursor()
            cur.execute(sql)
            conn.close()
            print(f"Migration applied successfully from {sql_file}")
            return
        except Exception as e:
            print(f"  {host}: {e}")

    print("ERROR: could not connect to Supabase Postgres with provided password.")
    print("Run the SQL manually at: https://supabase.com/dashboard/project/{ref}/sql/new")


if __name__ == "__main__":
    main()
