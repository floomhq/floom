# DB Backup Runbook

Defense Layer 6 protects the single production SQLite database with daily
encrypted snapshots uploaded to Backblaze B2.

## Live DB Audit

Read-only audit performed from AX41 paths:

| Item | Finding |
| --- | --- |
| Compose file | `/opt/floom-mcp-preview/docker-compose.yml` |
| Service | `floom-mcp-preview` |
| In-container DB path | `/data/floom-chat.db` |
| Docker volume mount | `floom-mcp-preview-data:/data` |
| External volume name | `floom-chat-deploy_floom-chat-data` |
| Host volume path | `/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db` |
| Read-only size estimate | `4.0K` from `/opt/floom-mcp-preview/data/floom-chat.db` |
| Compose backup env vars | None present today |

The scheduled host backup uses the Docker volume path directly:

```bash
/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db
```

For a containerized backup service, mount the named volume read-only at
`/data` and set `BACKUP_SOURCE_DB=/data/floom-chat.db`. No production compose
changes are part of this PR.

## Required Env Vars

Create `/etc/floom/db-backup.env` on AX41 with these four required values:

```bash
BACKUP_B2_ACCOUNT_ID=
BACKUP_B2_ACCOUNT_KEY=
BACKUP_B2_BUCKET=floom-prod-db-backups
BACKUP_AGE_RECIPIENT=age1...
```

Optional operational values:

```bash
BACKUP_SOURCE_DB=/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db
BACKUP_LOCAL_DIR=/var/backups/floom-db
BACKUP_REMOTE_PREFIX=floom-chat
BACKUP_LOG_FILE=/var/log/floom-backup.log
DISCORD_ALERT_WEBHOOK_URL=
RCLONE_BIN=/tmp/rclone
```

`DISCORD_ALERT_WEBHOOK_URL` matches the current Layer 5 alert helper. The
backup script also accepts the legacy `DISCORD_ALERTS_WEBHOOK_URL` and
`DISCORD_WEBHOOK_URL` names.

## Provision Backblaze B2

Recommended bucket name: `floom-prod-db-backups`.

1. In Backblaze, create a private B2 bucket named `floom-prod-db-backups`.
2. Create an application key scoped to that bucket with read/write access.
3. Put the key id in `BACKUP_B2_ACCOUNT_ID`.
4. Put the application key in `BACKUP_B2_ACCOUNT_KEY`.

The 10 GB free tier covers years of current SQLite snapshots at the audited
size. Usage remains low even after growth because backups are `zstd -19`
compressed before encryption.

## Generate Age Keypair

Run this on Federico's local machine, not on AX41:

```bash
age-keygen -o ~/floom-prod-db-backup-age-key.txt
```

Copy only the printed public recipient, beginning with `age1...`, into
`BACKUP_AGE_RECIPIENT` on AX41. Keep
`~/floom-prod-db-backup-age-key.txt` local and offline from the server.

For restore, pass the local identity file:

```bash
BACKUP_AGE_IDENTITY=~/floom-prod-db-backup-age-key.txt \
  scripts/ops/db-restore.sh latest
```

If the private identity is stored in a passphrase-protected local vault,
unlock it locally before restore. The private key never goes to AX41.

## Install Required Tools On AX41

Verified during implementation:

```bash
which age
# /usr/bin/age
```

Required commands:

- `age`
- `sqlite3`
- `zstd`
- `rclone`

`rclone` was not present during this implementation. Download the official
static Linux binary when installing the timer:

```bash
cd /tmp
curl -fsSLO https://downloads.rclone.org/rclone-current-linux-amd64.zip
unzip -p rclone-current-linux-amd64.zip '*/rclone' > /tmp/rclone
chmod +x /tmp/rclone
/tmp/rclone version
```

Then either install it system-wide:

```bash
sudo install -m 0755 /tmp/rclone /usr/local/bin/rclone
```

or set `RCLONE_BIN=/tmp/rclone` in `/etc/floom/db-backup.env`.

## Install Daily Timer

Run once on AX41 from the repo:

```bash
sudo bash scripts/ops/install-backup-timer.sh
sudoedit /etc/floom/db-backup.env
sudo systemctl start floom-db-backup.service
sudo systemctl status floom-db-backup.service --no-pager
sudo systemctl list-timers floom-db-backup.timer --no-pager
```

Schedule: daily at `03:00 UTC` via systemd timer:

```ini
OnCalendar=*-*-* 03:00:00 UTC
Persistent=true
```

Logs land in `/var/log/floom-backup.log`.

## Backup Behavior

`scripts/ops/db-backup.sh` performs:

1. SQLite online backup API snapshot via `sqlite3 source.db ".backup target.db"`.
2. Compression with `zstd -19`.
3. Public-key encryption with `age -r "$BACKUP_AGE_RECIPIENT"`.
4. Upload to Backblaze B2 via `rclone`.
5. Success log with file size, duration, and remote path.
6. Discord alert on failure when `DISCORD_ALERT_WEBHOOK_URL` is set.

Backup names use minute-level idempotency:

```text
floom-chat-YYYY-MM-DDTHH-MM-00Z.db.zst.age
```

Re-running in the same minute finds the existing local encrypted file and exits
successfully without a second upload.

## Retention

- Local: keep the last 7 encrypted backups in `/var/backups/floom-db`.
- Remote: prune encrypted backups older than 30 days from B2.

With the daily timer, this gives 7 daily local restore points and 30 daily
remote restore points.

## Disaster Recovery

If AX41 dies:

1. Provision a replacement host with Docker, Floom compose, `age`, `sqlite3`,
   `zstd`, and `rclone`.
2. Restore the private age key on Federico's local machine only.
3. Configure B2 env vars locally or on the replacement host.
4. Download and decrypt the latest backup.
5. Validate SQLite integrity.
6. Stop Floom, swap the staged DB into the Docker volume, restart Floom.

Example restore on AX41 or a replacement host:

```bash
export BACKUP_B2_ACCOUNT_ID
export BACKUP_B2_ACCOUNT_KEY
export BACKUP_B2_BUCKET=floom-prod-db-backups
export BACKUP_AGE_IDENTITY=~/floom-prod-db-backup-age-key.txt

bash scripts/ops/db-restore.sh latest
```

The script downloads the backup if it is not local, decrypts it, decompresses
it, runs `PRAGMA integrity_check`, then writes:

```bash
/var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db.restore-staging
```

Equivalent in-container staging path:

```bash
/data/floom-chat.db.restore-staging
```

Manual cutover commands:

```bash
cd /opt/floom-mcp-preview
docker compose stop floom-mcp-preview
sudo mv /var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db \
  /var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)
sudo mv /var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db.restore-staging \
  /var/lib/docker/volumes/floom-chat-deploy_floom-chat-data/_data/floom-chat.db
docker compose up -d floom-mcp-preview
docker compose logs --tail=100 floom-mcp-preview
```

The restore script prints these commands and asks for `RESTORE` before it
performs the two file moves.
