# Workeros Ops

Operational scripts and systemd units for the production API.

## Daily SQLite backup

Files:
- `backup-db.sh` - online snapshot via `sqlite3 .backup`, gzip, 30-day retention
- `workeros-backup.service` - oneshot systemd unit that runs the script
- `workeros-backup.timer` - daily timer with 15m randomized delay

The script and units are committed; they are NOT installed automatically. To
activate on the production box:

```bash
cp ops/workeros-backup.service /etc/systemd/system/
cp ops/workeros-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now workeros-backup.timer
```

Verify:
```bash
systemctl list-timers | rg workeros-backup
systemctl start workeros-backup.service
ls -la /var/backups/workeros
```

Tunables (env):
- `FLOOM_DB` source SQLite path (default `/root/workeros/data/floom.db`)
- `FLOOM_BACKUP_DIR` destination dir (default `/var/backups/workeros`)
- `FLOOM_BACKUP_DAYS` retention in days (default `30`)

self-hosted server status (2026-05-27):
- `workeros-backup.timer` is active and scheduled daily.
- Manual run via `systemctl start workeros-backup.service` succeeds and writes a gzipped snapshot under `/var/backups/workeros/`.
