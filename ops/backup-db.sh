#!/usr/bin/env bash
# Daily SQLite backup for the Workeros API.
#
# Strategy:
#   1. Use `sqlite3 .backup` (online backup; safe while the API is running).
#   2. gzip the snapshot.
#   3. Prune backups older than 30 days.
#
# Idempotent. Designed to run from systemd-timer with no arguments.
#
# Override via env:
#   FLOOM_DB           SQLite path  (default: /root/workeros/apps/api/floom.db)
#   FLOOM_BACKUP_DIR   destination  (default: /var/backups/workeros)
#   FLOOM_BACKUP_DAYS  retention    (default: 30)

set -euo pipefail

DB_PATH="${FLOOM_DB:-/root/workeros/apps/api/floom.db}"
BACKUP_DIR="${FLOOM_BACKUP_DIR:-/var/backups/workeros}"
RETENTION_DAYS="${FLOOM_BACKUP_DAYS:-30}"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup-db] source database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
SNAPSHOT="$BACKUP_DIR/floom-$TIMESTAMP.db"

# Online snapshot. Falls back to a plain copy if .backup is unavailable.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$SNAPSHOT'"
else
  echo "[backup-db] sqlite3 not found, copying file directly" >&2
  cp -a "$DB_PATH" "$SNAPSHOT"
fi

gzip -f "$SNAPSHOT"
echo "[backup-db] wrote $SNAPSHOT.gz"

# Prune anything older than RETENTION_DAYS.
find "$BACKUP_DIR" -maxdepth 1 -name 'floom-*.db.gz' -type f -mtime "+$RETENTION_DAYS" -print -delete || true

echo "[backup-db] done"
