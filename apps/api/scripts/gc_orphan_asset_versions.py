#!/usr/bin/env python3
"""One-time GC for orphaned ``asset_versions`` rows (2026-06-02 disk P2).

The keep-20-per-asset cap only fires when a NEW version is created. When the
parent asset (worker / context / context-file) is DELETED, its snapshot rows are
never pruned and accumulate forever. Ongoing pruning is now wired into the delete
handlers (see _delete_worker_impl + delete_context in main.py); this script is the
ONE-TIME reclaim for the backlog that built up before that fix shipped.

LIVE-ASSET MODEL (must match main.py exactly):
  - worker            : live  <=> asset_id IN (SELECT id FROM workers)
  - brain_pack        : live  <=> asset_id is a live context name
  - brain_file        : live  <=> the parent context (substr before first ':') is live
  - workspace_instructions : ALWAYS live (singleton) — never an orphan

Contexts are stored on DISK (one directory per context under the contexts root),
NOT in a DB table, so the live-context set is the union of directory names under
the contexts root and the keys of the contexts metadata file.

Usage:
    # Read-only report (default) — counts orphans, prints the live/orphan split.
    python scripts/gc_orphan_asset_versions.py --db /root/workeros/data/floom.db \
        --contexts-dir /root/workeros/contexts

    # Destructive reclaim — DELETE orphans in batches, then VACUUM.
    # Run ONLY during a deploy window (API stopped) to avoid lock contention.
    python scripts/gc_orphan_asset_versions.py --db /root/workeros/data/floom.db \
        --contexts-dir /root/workeros/contexts --apply

Idempotent: a second run finds zero orphans. Always take a verified gzip backup
BEFORE running with --apply.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path


def live_context_names(contexts_dir: Path) -> set[str]:
    names: set[str] = set()
    if contexts_dir.is_dir():
        for child in contexts_dir.iterdir():
            if child.is_dir():
                names.add(child.name)
    meta_path = contexts_dir / ".workeros-contexts.json"
    if meta_path.is_file():
        try:
            meta = json.loads(meta_path.read_text())
            if isinstance(meta, dict):
                names.update(str(k) for k in meta.keys())
        except Exception:
            pass
    return names


def orphan_ids(conn: sqlite3.Connection, live_contexts: set[str]) -> list[str]:
    live_list = sorted(live_contexts)
    # Parameterised IN-lists; empty set is handled by a guaranteed-false sentinel.
    ctx_ph = ",".join("?" * len(live_list)) if live_list else "NULL"

    worker_orphans = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM asset_versions "
            "WHERE asset_type='worker' AND asset_id NOT IN (SELECT id FROM workers)"
        ).fetchall()
    ]
    pack_orphans = [
        r[0]
        for r in conn.execute(
            f"SELECT id FROM asset_versions "
            f"WHERE asset_type='brain_pack' AND asset_id NOT IN ({ctx_ph})",
            live_list,
        ).fetchall()
    ]
    file_orphans = [
        r[0]
        for r in conn.execute(
            f"SELECT id FROM asset_versions "
            f"WHERE asset_type='brain_file' "
            f"AND substr(asset_id, 1, instr(asset_id, ':') - 1) NOT IN ({ctx_ph})",
            live_list,
        ).fetchall()
    ]
    return worker_orphans + pack_orphans + file_orphans


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", required=True, help="Path to floom.db")
    ap.add_argument("--contexts-dir", required=True, help="Path to the live contexts root")
    ap.add_argument("--apply", action="store_true", help="Actually DELETE orphans + VACUUM (default: report only)")
    ap.add_argument("--batch", type=int, default=5000, help="Delete batch size")
    args = ap.parse_args()

    db_path = Path(args.db)
    contexts_dir = Path(args.contexts_dir)
    if not db_path.is_file():
        print(f"DB not found: {db_path}", file=sys.stderr)
        return 2

    live_contexts = live_context_names(contexts_dir)

    # Read-only handle for the count/report phase.
    ro = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        total = ro.execute("SELECT COUNT(*) FROM asset_versions").fetchone()[0]
        orphans = orphan_ids(ro, live_contexts)
    finally:
        ro.close()

    print(f"live contexts ({len(live_contexts)}): {sorted(live_contexts)}")
    print(f"asset_versions total rows : {total}")
    print(f"orphan rows               : {len(orphans)}")
    print(f"live rows (kept)          : {total - len(orphans)}")

    if not args.apply:
        print("\n[DRY-RUN] no rows deleted. Re-run with --apply during a deploy window.")
        return 0

    if not orphans:
        print("\nNothing to delete. Idempotent no-op.")
        return 0

    rw = sqlite3.connect(str(db_path))
    try:
        deleted = 0
        for i in range(0, len(orphans), args.batch):
            chunk = orphans[i : i + args.batch]
            ph = ",".join("?" * len(chunk))
            cur = rw.execute(f"DELETE FROM asset_versions WHERE id IN ({ph})", chunk)
            deleted += cur.rowcount
            rw.commit()
            print(f"  deleted {deleted}/{len(orphans)}")
        print(f"deleted {deleted} orphan rows. Running VACUUM (this can take minutes on a large DB)...")
        rw.execute("VACUUM")
        rw.commit()
        remaining = rw.execute("SELECT COUNT(*) FROM asset_versions").fetchone()[0]
        print(f"VACUUM done. asset_versions now has {remaining} rows.")
    finally:
        rw.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
