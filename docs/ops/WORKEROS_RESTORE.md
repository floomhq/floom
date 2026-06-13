# Workeros Restore Runbook

Use this when restoring `/root/workeros/data` from a local backup directory under `/root/backups/workeros-YYYY-MM-DD-HHMM/`.

## 1. Pick A Backup

```bash
ls -1dt /root/backups/workeros-* | head
BACKUP=/root/backups/workeros-YYYY-MM-DD-HHMM
test -f "$BACKUP/floom.db"
test -f "$BACKUP/artifacts.tar.gz"
```

## 2. Stop API

```bash
systemctl stop workeros-api.service
```

Confirm there are no attached API processes:

```bash
systemctl is-active workeros-api.service || true
```

## 3. Restore Data

```bash
cd /root/workeros
mv data "data.restore-backup.$(date -u +%Y%m%d-%H%M%S)"
mkdir -p data
cp -a "$BACKUP/floom.db" data/floom.db
tar -C data -xzf "$BACKUP/artifacts.tar.gz"
```

## 4. Start API

```bash
systemctl start workeros-api.service
curl -fsS http://127.0.0.1:8011/health
```

## 5. Verify Application State

```bash
cd /root/workeros
python3 - <<'PY'
import sqlite3
conn = sqlite3.connect("data/floom.db")
workers = conn.execute("SELECT COUNT(*) FROM workers WHERE owner_id='federico'").fetchone()[0]
runs = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
recent = conn.execute("SELECT id, worker_id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 5").fetchall()
print({"workers": workers, "runs": runs, "recent": recent})
conn.close()
PY
```

Expected production baseline for S35: 18 the operator-owned workers and recent runs present.
