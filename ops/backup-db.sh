#!/usr/bin/env bash
# Hourly Floom data backup.
#
# Writes one directory per backup:
#   /root/backups/floom-YYYY-MM-DD-HHMM/
#     floom.db.gz       (gzip-compressed SQLite online backup)
#     artifacts.tar.gz
#     manifest.json
#
# Restore: gunzip floom.db.gz first, then sqlite3 .restore (see ops/README.md).
#
# Retention (tightened 2026-06-02 — DB grew to 11GB, uncompressed 48x copies
# filled the disk; gzip ~5x + fewer hourly points keeps backup footprint bounded):
#   - 6 newest hourly restore points
#   - 7 daily restore points
#   - 4 weekly restore points
#
# Override via env:
#   WORKEROS_ROOT            repo root (default: /opt/floom)
#   WORKEROS_API_DIR         API dir for relative FLOOM_DB paths (default: $WORKEROS_ROOT/apps/api)
#   FLOOM_DB                 SQLite path (default: $WORKEROS_ROOT/data/floom.db)
#   FLOOM_ARTIFACTS_DIR      artifacts dir (default: $WORKEROS_ROOT/data/artifacts)
#   WORKEROS_BACKUP_ROOT     destination root (default: /root/backups)
#   WORKEROS_BACKUP_HOURLY   hourly retention count (default: 6)
#   WORKEROS_BACKUP_DAILY    daily retention count (default: 7)
#   WORKEROS_BACKUP_WEEKLY   weekly retention count (default: 4)

set -euo pipefail

WORKEROS_ROOT="${WORKEROS_ROOT:-/opt/floom}"
WORKEROS_API_DIR="${WORKEROS_API_DIR:-$WORKEROS_ROOT/apps/api}"
DB_PATH="${FLOOM_DB:-$WORKEROS_ROOT/data/floom.db}"
ARTIFACTS_DIR="${FLOOM_ARTIFACTS_DIR:-$WORKEROS_ROOT/data/artifacts}"
BACKUP_ROOT="${WORKEROS_BACKUP_ROOT:-/root/backups}"
HOURLY_KEEP="${WORKEROS_BACKUP_HOURLY:-6}"
DAILY_KEEP="${WORKEROS_BACKUP_DAILY:-7}"
WEEKLY_KEEP="${WORKEROS_BACKUP_WEEKLY:-4}"

resolve_path() {
  local base="$1"
  local raw="$2"
  python3 - "$base" "$raw" <<'PY'
from pathlib import Path
import sys

base = Path(sys.argv[1])
raw = Path(sys.argv[2])
print((raw if raw.is_absolute() else base / raw).resolve())
PY
}

if [[ "$DB_PATH" != /* ]]; then
  DB_PATH="$(resolve_path "$WORKEROS_API_DIR" "$DB_PATH")"
fi

if [[ "$ARTIFACTS_DIR" != /* ]]; then
  ARTIFACTS_DIR="$(resolve_path "$WORKEROS_API_DIR" "$ARTIFACTS_DIR")"
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup-db] source database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT"

TIMESTAMP="$(date -u +%Y-%m-%d-%H%M)"
DEST="$BACKUP_ROOT/floom-$TIMESTAMP"
if [[ -e "$DEST" ]]; then
  DEST="$BACKUP_ROOT/floom-$TIMESTAMP-$(date -u +%S)"
fi
mkdir -p "$DEST"

# Online snapshot. SQLite .backup is safe while the API is running.
# Snapshot to a temp file, then gzip it. The DB is ~11GB raw; storing 48
# uncompressed copies filled the disk. gzip (~5x) + the tightened retention
# above keeps the backup footprint bounded. Restore = gunzip then .restore.
TMP_DB="$DEST/floom.db"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$TMP_DB'"
else
  echo "[backup-db] sqlite3 not found, copying database file directly" >&2
  cp -a "$DB_PATH" "$TMP_DB"
fi
gzip -f "$TMP_DB"   # -> $DEST/floom.db.gz

mkdir -p "$ARTIFACTS_DIR"
tar -C "$(dirname "$ARTIFACTS_DIR")" -czf "$DEST/artifacts.tar.gz" "$(basename "$ARTIFACTS_DIR")"

python3 - "$DEST" "$DB_PATH" "$ARTIFACTS_DIR" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

dest = Path(sys.argv[1])
db_path = Path(sys.argv[2])
artifacts_dir = Path(sys.argv[3])


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


manifest = {
    "created_at": datetime.now(timezone.utc).isoformat(),
    "source_db": str(db_path),
    "source_artifacts": str(artifacts_dir),
    "files": {
        "floom.db.gz": {
            "size_bytes": (dest / "floom.db.gz").stat().st_size,
            "sha256": sha256(dest / "floom.db.gz"),
        },
        "artifacts.tar.gz": {
            "size_bytes": (dest / "artifacts.tar.gz").stat().st_size,
            "sha256": sha256(dest / "artifacts.tar.gz"),
        },
    },
}
(dest / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
PY

python3 - "$BACKUP_ROOT" "$HOURLY_KEEP" "$DAILY_KEEP" "$WEEKLY_KEEP" <<'PY'
from __future__ import annotations

import re
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

root = Path(sys.argv[1])
hourly_keep = int(sys.argv[2])
daily_keep = int(sys.argv[3])
weekly_keep = int(sys.argv[4])
pattern = re.compile(r"^floom-(\d{4}-\d{2}-\d{2}-\d{4})(?:-\d{2})?$")


@dataclass(frozen=True)
class Backup:
    path: Path
    created_at: datetime


backups: list[Backup] = []
for path in root.iterdir() if root.exists() else []:
    if not path.is_dir():
        continue
    match = pattern.match(path.name)
    if not match:
        continue
    try:
        created_at = datetime.strptime(match.group(1), "%Y-%m-%d-%H%M")
    except ValueError:
        continue
    backups.append(Backup(path=path, created_at=created_at))

backups.sort(key=lambda item: item.created_at, reverse=True)
keep: set[Path] = {item.path for item in backups[:hourly_keep]}

daily_seen: set[str] = set()
for item in backups:
    key = item.created_at.date().isoformat()
    if key in daily_seen:
        continue
    daily_seen.add(key)
    if len(daily_seen) <= daily_keep:
        keep.add(item.path)

weekly_seen: set[tuple[int, int]] = set()
for item in backups:
    iso = item.created_at.isocalendar()
    key = (iso.year, iso.week)
    if key in weekly_seen:
        continue
    weekly_seen.add(key)
    if len(weekly_seen) <= weekly_keep:
        keep.add(item.path)

for item in backups:
    if item.path not in keep:
        shutil.rmtree(item.path)
        print(f"[backup-db] pruned {item.path}")
PY

python3 "$WORKEROS_ROOT/ops/rotate-artifacts.py" || true

echo "[backup-db] wrote $DEST"
