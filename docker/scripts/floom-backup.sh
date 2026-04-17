#!/usr/bin/env bash
# Daily SQLite backup for a Docker-hosted Floom preview.
#
# Runs on the host, snapshots the DB file inside the `floom-chat-data`
# volume via sqlite3's online `.backup` (atomic even while the server is
# writing), gzips the snapshot, prunes anything older than 30 days.
#
# Install (on AX41 or wherever the preview runs):
#   sudo install -m 0755 docker/scripts/floom-backup.sh /usr/local/bin/floom-backup.sh
#   sudo mkdir -p /opt/floom-backups
#   sudo crontab -e
#     0 4 * * * /usr/local/bin/floom-backup.sh >> /var/log/floom-backup.log 2>&1
#
# Requirements: host must have `sqlite3` and `gzip` installed, and must be
# able to read /var/lib/docker/volumes/... (run via cron as root).

set -euo pipefail

DB="${FLOOM_BACKUP_DB:-/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db}"
OUT_DIR="${FLOOM_BACKUP_DIR:-/opt/floom-backups}"
RETENTION_DAYS="${FLOOM_BACKUP_RETENTION_DAYS:-30}"

if [[ ! -f "$DB" ]]; then
  echo "[floom-backup] source DB not found: $DB" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M)"
STAGE="/tmp/floom-backup-$$.db"
OUT="$OUT_DIR/floom-$TS.db.gz"

# sqlite3 online backup — consistent snapshot even under concurrent writes.
sqlite3 "$DB" ".backup '$STAGE'"
gzip < "$STAGE" > "$OUT"
rm -f "$STAGE"

# Prune old backups. `-mtime +N` keeps anything modified within the last
# N days; older files are removed.
find "$OUT_DIR" -maxdepth 1 -type f -name 'floom-*.db.gz' -mtime "+${RETENTION_DAYS}" -delete

echo "[floom-backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"
