#!/usr/bin/env bash
# Manual disaster-recovery restore for encrypted Floom SQLite backups.

set -Eeuo pipefail

umask 077

DEFAULT_DB_PATH="/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db"

LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/floom-db}"
REMOTE_PREFIX="${BACKUP_REMOTE_PREFIX:-floom-chat}"
RESTORE_DB_PATH="${RESTORE_DB_PATH:-${FLOOM_DB_PATH:-$DEFAULT_DB_PATH}}"
RESTORE_STAGING_DB_PATH="${RESTORE_STAGING_DB_PATH:-${RESTORE_DB_PATH}.restore-staging}"
RESTORE_OLD_DB_PATH="${RESTORE_OLD_DB_PATH:-${RESTORE_DB_PATH}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)}"

SQLITE_BIN="${SQLITE_BIN:-sqlite3}"
ZSTD_BIN="${ZSTD_BIN:-zstd}"
AGE_BIN="${AGE_BIN:-age}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"

RCLONE_CONFIG=""
TMP_DIR=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") <backup-filename|latest>

Environment:
  BACKUP_LOCAL_DIR          Local backup cache (default: ${LOCAL_DIR})
  BACKUP_B2_ACCOUNT_ID      Backblaze B2 application key id
  BACKUP_B2_ACCOUNT_KEY     Backblaze B2 application key
  BACKUP_B2_BUCKET          Backblaze B2 bucket
  BACKUP_AGE_IDENTITY       Path to Federico's local age private identity
  RESTORE_DB_PATH           Target DB path (default: ${RESTORE_DB_PATH})
  RESTORE_STAGING_DB_PATH   Staging DB path (default: ${RESTORE_STAGING_DB_PATH})

Cutover summary:
  1. Stop the Floom container.
  2. Run this restore script and type RESTORE after validation.
  3. Restart the Floom container.
USAGE
}

log_line() {
  local level="$1"
  local message="$2"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "${now} [${level}] ${message}" >&2
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$RCLONE_CONFIG" ] && [ -f "$RCLONE_CONFIG" ]; then
    rm -f "$RCLONE_CONFIG"
  fi
}
trap cleanup EXIT

require_command() {
  local bin="$1"
  local name="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    log_line "ERROR" "missing dependency: ${name} (${bin})"
    exit 2
  fi
}

require_env() {
  local key="$1"
  if [ -z "${!key:-}" ]; then
    log_line "ERROR" "missing required env var: ${key}"
    exit 2
  fi
}

write_rclone_config() {
  RCLONE_CONFIG="$(mktemp)"
  chmod 0600 "$RCLONE_CONFIG"
  {
    printf '[floom-b2]\n'
    printf 'type = b2\n'
    printf 'account = %s\n' "$BACKUP_B2_ACCOUNT_ID"
    printf 'key = %s\n' "$BACKUP_B2_ACCOUNT_KEY"
  } > "$RCLONE_CONFIG"
}

remote_ready() {
  command -v "$RCLONE_BIN" >/dev/null 2>&1 \
    && [ -n "${BACKUP_B2_ACCOUNT_ID:-}" ] \
    && [ -n "${BACKUP_B2_ACCOUNT_KEY:-}" ] \
    && [ -n "${BACKUP_B2_BUCKET:-}" ]
}

download_backup() {
  local filename="$1"
  mkdir -p "$LOCAL_DIR"
  if [ -f "${LOCAL_DIR}/${filename}" ]; then
    printf '%s\n' "${LOCAL_DIR}/${filename}"
    return 0
  fi

  require_command "$RCLONE_BIN" "rclone"
  require_env "BACKUP_B2_ACCOUNT_ID"
  require_env "BACKUP_B2_ACCOUNT_KEY"
  require_env "BACKUP_B2_BUCKET"
  write_rclone_config
  "$RCLONE_BIN" --config "$RCLONE_CONFIG" copyto \
    "floom-b2:${BACKUP_B2_BUCKET}/${REMOTE_PREFIX}/${filename}" \
    "${LOCAL_DIR}/${filename}" \
    --transfers 1 \
    --checkers 4
  printf '%s\n' "${LOCAL_DIR}/${filename}"
}

resolve_latest() {
  mkdir -p "$LOCAL_DIR"
  local local_latest
  local_latest="$(
    find "$LOCAL_DIR" -maxdepth 1 -type f -name 'floom-chat-*.db.zst.age' -printf '%f\n' \
      | sort \
      | tail -n 1
  )"
  if [ -n "$local_latest" ]; then
    printf '%s\n' "$local_latest"
    return 0
  fi

  if ! remote_ready; then
    log_line "ERROR" "no local backups found and B2 env/rclone are not available"
    exit 2
  fi

  write_rclone_config
  local remote_latest
  remote_latest="$(
    "$RCLONE_BIN" --config "$RCLONE_CONFIG" lsf \
      "floom-b2:${BACKUP_B2_BUCKET}/${REMOTE_PREFIX}" \
      --include 'floom-chat-*.db.zst.age' \
      | sort \
      | tail -n 1
  )"
  if [ -z "$remote_latest" ]; then
    log_line "ERROR" "no remote backups found in b2://${BACKUP_B2_BUCKET}/${REMOTE_PREFIX}"
    exit 2
  fi
  printf '%s\n' "${remote_latest%/}"
}

decrypt_and_validate() {
  local encrypted="$1"
  TMP_DIR="$(mktemp -d)"
  local compressed="${TMP_DIR}/floom-chat.db.zst"
  local restored="${TMP_DIR}/floom-chat.db"

  local age_args=(-d)
  if [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
    age_args+=(-i "$BACKUP_AGE_IDENTITY")
  fi
  age_args+=(-o "$compressed" "$encrypted")

  log_line "INFO" "decrypting ${encrypted}"
  "$AGE_BIN" "${age_args[@]}"
  "$ZSTD_BIN" -d -q -f "$compressed" -o "$restored"

  local integrity
  integrity="$("$SQLITE_BIN" "$restored" "PRAGMA integrity_check;")"
  if [ "$integrity" != "ok" ]; then
    log_line "ERROR" "SQLite integrity_check failed: ${integrity}"
    exit 1
  fi
  log_line "INFO" "SQLite integrity_check returned ok"

  mkdir -p "$(dirname "$RESTORE_STAGING_DB_PATH")"
  install -m 0600 "$restored" "$RESTORE_STAGING_DB_PATH"
  log_line "INFO" "staged restore at ${RESTORE_STAGING_DB_PATH}"
}

print_cutover_commands() {
  cat <<EOF

Manual cutover commands on AX41:

  cd /opt/floom-mcp-preview
  docker compose stop floom-mcp-preview
  sudo mv "${RESTORE_DB_PATH}" "${RESTORE_OLD_DB_PATH}"
  sudo mv "${RESTORE_STAGING_DB_PATH}" "${RESTORE_DB_PATH}"
  docker compose up -d floom-mcp-preview
  docker compose logs --tail=100 floom-mcp-preview

The script can perform the two mv commands after confirmation. Stop the
container before typing RESTORE.
EOF
}

confirm_and_swap() {
  print_cutover_commands
  printf '\nType RESTORE to swap staged DB into place, or anything else to leave staging intact: ' >&2
  local answer
  read -r answer
  if [ "$answer" != "RESTORE" ]; then
    log_line "INFO" "left staged restore intact: ${RESTORE_STAGING_DB_PATH}"
    exit 0
  fi
  if [ ! -f "$RESTORE_STAGING_DB_PATH" ]; then
    log_line "ERROR" "staged DB missing: ${RESTORE_STAGING_DB_PATH}"
    exit 1
  fi
  if [ -e "$RESTORE_DB_PATH" ]; then
    mv "$RESTORE_DB_PATH" "$RESTORE_OLD_DB_PATH"
    log_line "INFO" "moved current DB to ${RESTORE_OLD_DB_PATH}"
  fi
  mv "$RESTORE_STAGING_DB_PATH" "$RESTORE_DB_PATH"
  log_line "INFO" "restore swapped into ${RESTORE_DB_PATH}"
}

main() {
  if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "$#" -ne 1 ]; then
    usage
    exit 2
  fi

  require_command "$SQLITE_BIN" "sqlite3"
  require_command "$ZSTD_BIN" "zstd"
  require_command "$AGE_BIN" "age"

  local requested="$1"
  local filename
  if [ "$requested" = "latest" ]; then
    filename="$(resolve_latest)"
  else
    filename="$(basename "$requested")"
  fi

  if [[ "$filename" != floom-chat-*.db.zst.age ]]; then
    log_line "ERROR" "invalid backup filename: ${filename}"
    exit 2
  fi

  local encrypted
  encrypted="$(download_backup "$filename")"
  decrypt_and_validate "$encrypted"
  confirm_and_swap
}

main "$@"
