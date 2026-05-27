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
sudo install -m 0644 ops/workeros-backup.service /etc/systemd/system/workeros-backup.service
sudo install -m 0644 ops/workeros-backup.timer /etc/systemd/system/workeros-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now workeros-backup.timer
```

Verify:
```bash
systemctl list-timers workeros-backup.timer
ls -la /var/backups/workeros
```

Tunables (env):
- `FLOOM_DB` source SQLite path (default `/root/workeros/apps/api/floom.db`)
- `FLOOM_BACKUP_DIR` destination dir (default `/var/backups/workeros`)
- `FLOOM_BACKUP_DAYS` retention in days (default `30`)
