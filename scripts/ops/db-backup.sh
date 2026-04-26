#!/usr/bin/env bash
# Daily encrypted SQLite backups for the Floom production database.

set -Eeuo pipefail

umask 077

DEFAULT_DB_PATH="/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db"

SOURCE_DB="${BACKUP_SOURCE_DB:-${FLOOM_DB_PATH:-$DEFAULT_DB_PATH}}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/floom-db}"
REMOTE_PREFIX="${BACKUP_REMOTE_PREFIX:-floom-chat}"
LOG_FILE="${BACKUP_LOG_FILE:-/var/log/floom-backup.log}"
TEST_MODE="${BACKUP_TEST_MODE:-0}"

SQLITE_BIN="${SQLITE_BIN:-sqlite3}"
ZSTD_BIN="${ZSTD_BIN:-zstd}"
AGE_BIN="${AGE_BIN:-age}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
CURL_BIN="${CURL_BIN:-curl}"

TIMESTAMP="${BACKUP_TIMESTAMP:-$(date -u +%Y-%m-%dT%H-%M-00Z)}"
FILENAME="floom-chat-${TIMESTAMP}.db.zst.age"
FINAL_PATH="${LOCAL_DIR}/${FILENAME}"
REMOTE_PATH="${REMOTE_PREFIX}/${FILENAME}"

START_SECONDS="$(date +%s)"
TMP_DIR=""
RCLONE_CONFIG=""

log_line() {
  local level="$1"
  local message="$2"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local line="${now} [${level}] ${message}"
  echo "$line" >&2
  if [ -n "$LOG_FILE" ]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    printf '%s\n' "$line" >> "$LOG_FILE" 2>/dev/null || true
  fi
}

discord_webhook_url() {
  if [ -n "${DISCORD_ALERT_WEBHOOK_URL:-}" ]; then
    printf '%s' "$DISCORD_ALERT_WEBHOOK_URL"
    return 0
  fi
  if [ -n "${DISCORD_ALERTS_WEBHOOK_URL:-}" ]; then
    printf '%s' "$DISCORD_ALERTS_WEBHOOK_URL"
    return 0
  fi
  if [ -n "${DISCORD_WEBHOOK_URL:-}" ]; then
    printf '%s' "$DISCORD_WEBHOOK_URL"
    return 0
  fi
}

send_discord_alert() {
  local message="$1"
  local webhook
  webhook="$(discord_webhook_url || true)"
  if [ -z "$webhook" ]; then
    return 0
  fi
  if [[ "$webhook" != https://discord.com/api/webhooks/* ]]; then
    log_line "WARN" "Discord alert skipped: webhook URL does not match Discord webhook prefix"
    return 0
  fi
  if ! command -v "$CURL_BIN" >/dev/null 2>&1; then
    log_line "WARN" "Discord alert skipped: curl not found"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_line "WARN" "Discord alert skipped: python3 not found"
    return 0
  fi

  local payload
  payload="$(
    python3 - "$message" <<'PY'
import json
import sys

content = sys.argv[1]
print(json.dumps({"content": content[:1900], "allowed_mentions": {"parse": []}}))
PY
  )"
  "$CURL_BIN" -fsS -m 10 \
    -H "content-type: application/json" \
    -X POST \
    --data "$payload" \
    "$webhook" >/dev/null 2>&1 || log_line "WARN" "Discord alert POST failed"
}

fail() {
  local status="$1"
  local message="$2"
  log_line "ERROR" "$message"
  send_discord_alert "**Floom DB backup failed**"$'\n'"${message}"
  exit "$status"
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

on_error() {
  local status="$1"
  local line="$2"
  local message="Floom DB backup failed status=${status} line=${line} file=${FILENAME}"
  fail "$status" "$message"
}
trap 'on_error "$?" "$LINENO"' ERR

require_command() {
  local bin="$1"
  local name="$2"
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail 2 "missing dependency: ${name} (${bin})"
  fi
}

require_env() {
  local key="$1"
  if [ -z "${!key:-}" ]; then
    fail 2 "missing required env var: ${key}"
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

prune_local_backups() {
  find "$LOCAL_DIR" -maxdepth 1 -type f -name 'floom-chat-*.db.zst.age' -printf '%T@ %p\n' \
    | sort -nr \
    | tail -n +8 \
    | cut -d' ' -f2- \
    | while IFS= read -r old_backup; do
        [ -n "$old_backup" ] || continue
        rm -f "$old_backup"
        log_line "INFO" "pruned local backup ${old_backup}"
      done
}

prune_remote_backups() {
  "$RCLONE_BIN" --config "$RCLONE_CONFIG" delete \
    "floom-b2:${BACKUP_B2_BUCKET}/${REMOTE_PREFIX}" \
    --min-age 30d \
    --include 'floom-chat-*.db.zst.age' >/dev/null
  "$RCLONE_BIN" --config "$RCLONE_CONFIG" rmdirs \
    "floom-b2:${BACKUP_B2_BUCKET}/${REMOTE_PREFIX}" >/dev/null || true
}

main() {
  require_command "$SQLITE_BIN" "sqlite3"
  require_command "$ZSTD_BIN" "zstd"
  require_command "$AGE_BIN" "age"
  require_env "BACKUP_AGE_RECIPIENT"

  if [ "$TEST_MODE" != "1" ]; then
    require_command "$RCLONE_BIN" "rclone"
    require_env "BACKUP_B2_ACCOUNT_ID"
    require_env "BACKUP_B2_ACCOUNT_KEY"
    require_env "BACKUP_B2_BUCKET"
  fi

  if [ ! -f "$SOURCE_DB" ]; then
    fail 2 "source DB not found: ${SOURCE_DB}"
  fi

  mkdir -p "$LOCAL_DIR"

  if [ -e "$FINAL_PATH" ]; then
    log_line "INFO" "backup already exists for timestamp=${TIMESTAMP}; skipping path=${FINAL_PATH}"
    exit 0
  fi

  TMP_DIR="$(mktemp -d)"
  local snapshot="${TMP_DIR}/floom-chat.db"
  local compressed="${TMP_DIR}/floom-chat.db.zst"
  local encrypted="${TMP_DIR}/${FILENAME}"

  log_line "INFO" "snapshot start source=${SOURCE_DB} target=${FILENAME}"
  "$SQLITE_BIN" "$SOURCE_DB" ".timeout 60000" ".backup '${snapshot}'"

  "$ZSTD_BIN" -19 -T0 -q -f "$snapshot" -o "$compressed"
  "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$encrypted" "$compressed"

  if [ -e "$FINAL_PATH" ]; then
    log_line "INFO" "backup created concurrently for timestamp=${TIMESTAMP}; skipping path=${FINAL_PATH}"
    exit 0
  fi
  mv "$encrypted" "$FINAL_PATH"

  if [ "$TEST_MODE" = "1" ]; then
    log_line "INFO" "test mode enabled; skipped B2 upload"
  else
    write_rclone_config
    "$RCLONE_BIN" --config "$RCLONE_CONFIG" copyto \
      "$FINAL_PATH" \
      "floom-b2:${BACKUP_B2_BUCKET}/${REMOTE_PATH}" \
      --transfers 1 \
      --checkers 4
    prune_remote_backups
  fi

  prune_local_backups

  local size_bytes
  size_bytes="$(stat -c%s "$FINAL_PATH")"
  local duration_seconds
  duration_seconds="$(($(date +%s) - START_SECONDS))"
  local remote_label="b2://${BACKUP_B2_BUCKET:-test-skip}/${REMOTE_PATH}"
  log_line "INFO" "backup success file=${FINAL_PATH} size_bytes=${size_bytes} duration_seconds=${duration_seconds} remote=${remote_label}"
}

main "$@"
