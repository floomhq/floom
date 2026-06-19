# Workeros Ops

Operational scripts and systemd units for the production API.

## API Autodeploy

Files:
- `autodeploy-api.sh` - deterministic wrapper for systemd/webhook autodeploys
- `workeros-api-autodeploy.service` - API oneshot unit

The wrapper never runs `git pull`. It fetches `origin/main`, rejects tracked
changes, staged changes, untracked files, and local-only commits with an
actionable error, then resets a clean deploy mirror to `origin/main` and invokes
the configured deploy command.

Install or refresh the unit:

```bash
install -m 0755 ops/autodeploy-api.sh /opt/workeros/ops/autodeploy-api.sh
install -m 0644 ops/workeros-api-autodeploy.service /etc/systemd/system/workeros-api-autodeploy.service
systemctl daemon-reload
systemctl start workeros-api-autodeploy.service
```

Optional failure alerting:

```bash
cat >/etc/workeros/autodeploy.env <<'EOF'
WORKEROS_AUTODEPLOY_ALERT_WEBHOOK=https://example.invalid/webhook
EOF
```

## Hard Post-Deploy Smoke Gate

After every production deploy and before relying on a production alias, run:

```bash
bash ops/smoke-routes.sh
```

The gate must pass. It curls critical routes and fails on any 508, 5xx, or curl
failure. If it fails, the deploy is not promoted.

`ops/deploy-api.sh` runs this gate automatically after the API health, endpoint,
and schema checks pass.

## Hourly Data Backup

Files:
- `backup-db.sh` - online SQLite `.backup`, artifacts tarball, manifest, retention pruning
- `rotate-artifacts.py` - gzip old `transcript.jsonl` files and mark `runs.artifacts_archived`
- `workeros-backup.service` - oneshot systemd unit that runs backup and rotation
- `workeros-backup.timer` - hourly timer with 5m randomized delay

Backup output:

```text
/root/backups/workeros-YYYY-MM-DD-HHMM/
  floom.db.gz      # gzip-compressed SQLite online backup
  artifacts.tar.gz
  manifest.json
```

Retention keeps 6 hourly restore points, 7 daily restore points, and 4 weekly restore points.
(Hourly was 48 until 2026-06-02; the DB grew to ~11GB and 48 uncompressed copies
filled the disk. The snapshot is now gzip-compressed and hourly points reduced.)

Restore a backup:

```bash
gunzip -c /root/backups/workeros-YYYY-MM-DD-HHMM/floom.db.gz > /tmp/restore-floom.db
sqlite3 /opt/workeros/data/floom.db ".restore '/tmp/restore-floom.db'"
```

Install or refresh production units:

```bash
install -m 0755 ops/backup-db.sh /opt/workeros/ops/backup-db.sh
install -m 0755 ops/rotate-artifacts.py /opt/workeros/ops/rotate-artifacts.py
install -m 0644 ops/workeros-backup.service /etc/systemd/system/workeros-backup.service
install -m 0644 ops/workeros-backup.timer /etc/systemd/system/workeros-backup.timer
systemctl daemon-reload
systemctl enable --now workeros-backup.timer
```

Verify:

```bash
systemctl list-timers workeros-backup.timer
systemctl start workeros-backup.service
ls -la /root/backups
```

Tunables:
- `WORKEROS_ROOT` repo root, default `/opt/workeros`
- `WORKEROS_API_DIR` API dir used to resolve relative `FLOOM_DB`, default `$WORKEROS_ROOT/apps/api`
- `FLOOM_DB` source SQLite path, default `$WORKEROS_ROOT/data/floom.db`; relative paths resolve from `WORKEROS_API_DIR`
- `FLOOM_ARTIFACTS_DIR` artifacts dir, default `$WORKEROS_ROOT/data/artifacts`; relative paths resolve from `WORKEROS_API_DIR`
- `WORKEROS_BACKUP_ROOT` destination root, default `/root/backups`
- `WORKEROS_BACKUP_HOURLY` hourly retention count, default `6`
- `WORKEROS_BACKUP_DAILY` daily retention count, default `7`
- `WORKEROS_BACKUP_WEEKLY` weekly retention count, default `4`
- `WORKEROS_ARTIFACT_RETENTION_DAYS` transcript gzip cutoff, default `30`
