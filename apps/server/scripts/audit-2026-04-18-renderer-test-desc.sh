#!/usr/bin/env bash
# audit-2026-04-18-renderer-test-desc.sh
#
# One-shot fix-up for bug #8 of the 2026-04-18 audit: the my-renderer-test
# app had the petstore OpenAPI spec's info.description ("This is a sample
# Pet Store Server based on the OpenAPI 3.0 specification.  You can find
# out more about...") because that's the spec the creator pointed the
# renderer sandbox at. The app is user-ingested (not in src/db/seed.json),
# so there's no code-level source-of-truth to edit. This script updates
# the row directly.
#
# Idempotent: running twice is a no-op.
#
# Usage (inside the container):
#   bash apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh /data/floom-chat.db
# Usage (from host):
#   docker exec floom-mcp-preview sh -c 'apt-get install -y sqlite3 >/dev/null 2>&1 && \
#     bash /app/apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh /data/floom-chat.db'
set -euo pipefail

DB="${1:-/data/floom-chat.db}"
NEW_DESC="Creator-uploaded custom React renderer sandbox. Demos the TSX compile + iframe sandbox cascade."

if [ ! -f "$DB" ]; then
  echo "[audit-2026-04-18] db not found: $DB" >&2
  exit 0  # non-fatal: preview images without the DB skip silently
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[audit-2026-04-18] sqlite3 not installed; skipping"
  exit 0
fi

sqlite3 "$DB" <<SQL
UPDATE apps
   SET description = '$NEW_DESC'
 WHERE slug = 'my-renderer-test'
   AND description LIKE '%Pet Store Server%';
SQL

UPDATED="$(sqlite3 "$DB" "SELECT description FROM apps WHERE slug = 'my-renderer-test';")"
echo "[audit-2026-04-18] my-renderer-test description is now: $UPDATED"
