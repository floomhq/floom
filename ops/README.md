# Workeros Ops

Operational scripts and systemd units for the production API.

## Hourly Data Backup

Files:
- `backup-db.sh` - online SQLite `.backup`, artifacts tarball, manifest, retention pruning
- `rotate-artifacts.py` - gzip old `transcript.jsonl` files and mark `runs.artifacts_archived`
- `workeros-backup.service` - oneshot systemd unit that runs backup and rotation
- `workeros-backup.timer` - hourly timer with 5m randomized delay

Backup output:

```text
/root/backups/workeros-YYYY-MM-DD-HHMM/
  floom.db
  artifacts.tar.gz
  manifest.json
```

Retention keeps 48 hourly restore points, 7 daily restore points, and 4 weekly restore points.

Install or refresh production units:

```bash
install -m 0755 ops/backup-db.sh /root/workeros/ops/backup-db.sh
install -m 0755 ops/rotate-artifacts.py /root/workeros/ops/rotate-artifacts.py
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
- `WORKEROS_ROOT` repo root, default `/root/workeros`
- `WORKEROS_API_DIR` API dir used to resolve relative `FLOOM_DB`, default `$WORKEROS_ROOT/apps/api`
- `FLOOM_DB` source SQLite path, default `$WORKEROS_ROOT/data/floom.db`; relative paths resolve from `WORKEROS_API_DIR`
- `FLOOM_ARTIFACTS_DIR` artifacts dir, default `$WORKEROS_ROOT/data/artifacts`; relative paths resolve from `WORKEROS_API_DIR`
- `WORKEROS_BACKUP_ROOT` destination root, default `/root/backups`
- `WORKEROS_BACKUP_HOURLY` hourly retention count, default `48`
- `WORKEROS_BACKUP_DAILY` daily retention count, default `7`
- `WORKEROS_BACKUP_WEEKLY` weekly retention count, default `4`
- `WORKEROS_ARTIFACT_RETENTION_DAYS` transcript gzip cutoff, default `30`
