#!/usr/bin/env bash
# One-time AX41 installer for the Floom DB backup systemd timer.

set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BACKUP_SCRIPT_SRC="${SCRIPT_DIR}/db-backup.sh"
BACKUP_SCRIPT_DST="/usr/local/sbin/floom-db-backup.sh"
ENV_DIR="/etc/floom"
ENV_FILE="${ENV_DIR}/db-backup.env"
SERVICE_FILE="/etc/systemd/system/floom-db-backup.service"
TIMER_FILE="/etc/systemd/system/floom-db-backup.timer"

if [ ! -f "$BACKUP_SCRIPT_SRC" ]; then
  echo "Missing source script: ${BACKUP_SCRIPT_SRC}" >&2
  exit 2
fi

install -m 0755 "$BACKUP_SCRIPT_SRC" "$BACKUP_SCRIPT_DST"
install -d -m 0750 "$ENV_DIR"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'ENV'
# Required before enabling production uploads:
BACKUP_B2_ACCOUNT_ID=
BACKUP_B2_ACCOUNT_KEY=
BACKUP_B2_BUCKET=floom-prod-db-backups
BACKUP_AGE_RECIPIENT=

# Host-side path for Docker volume floom-chat-deploy_floom-chat-data.
BACKUP_SOURCE_DB=/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db
BACKUP_LOCAL_DIR=/var/backups/floom-db
BACKUP_REMOTE_PREFIX=floom-chat
BACKUP_LOG_FILE=/var/log/floom-backup.log

# Optional: set when rclone is staged outside PATH.
# RCLONE_BIN=/tmp/rclone

# Optional: Layer-5 Discord alert webhook.
# DISCORD_ALERT_WEBHOOK_URL=
ENV
  chmod 0600 "$ENV_FILE"
  echo "Created ${ENV_FILE}; fill required values before the first timer run."
else
  echo "Kept existing ${ENV_FILE}."
fi

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Floom encrypted SQLite database backup
Documentation=https://github.com/floomhq/floom/blob/main/docs/ops/db-backup.md

[Service]
Type=oneshot
EnvironmentFile=${ENV_FILE}
ExecStart=${BACKUP_SCRIPT_DST}
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
EOF

cat > "$TIMER_FILE" <<'EOF'
[Unit]
Description=Run Floom DB backup daily at 03:00 UTC

[Timer]
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
RandomizedDelaySec=0
Unit=floom-db-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now floom-db-backup.timer
systemctl list-timers floom-db-backup.timer --no-pager
