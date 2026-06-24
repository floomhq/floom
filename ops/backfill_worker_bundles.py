#!/usr/bin/env python3
"""One-shot, idempotent backfill: move skill_versions.manifest_json._files into
the `worker-bundles` Supabase Storage bucket and rewrite the manifest lean.

Why: worker code bundles were inlined into the metadata JSONB, so listing
workers downloaded ~18 MB of bundle bytes the grid never displays. The cloud
repo now offloads new/updated bundles to Storage; this migrates the existing
rows. Safe to run repeatedly — rows already carrying `_files_in_storage` are
skipped, and the API keeps an inline-`_files` read fallback so runs work before,
during, and after the backfill.

Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or WORKEROS_CLOUD_* equivalents).

Usage:
  python ops/backfill_worker_bundles.py --dry-run     # report only
  python ops/backfill_worker_bundles.py               # migrate
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

_BUCKET = "worker-bundles"
_PAGE = 100


def _env(*names: str) -> str:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return ""


def _bundle_sha256(files: dict) -> str | None:
    """Canonical bundle hash — must match supabase_repos._bundle_sha256."""
    if not isinstance(files, dict) or not files:
        return None
    digest = hashlib.sha256()
    included = 0
    for rel_path, content in sorted(files.items()):
        if not isinstance(rel_path, str) or not isinstance(content, str):
            continue
        path = Path(rel_path)
        if (
            not rel_path
            or path.is_absolute()
            or ".." in path.parts
            or (path.parts and path.parts[0] == "inputs")
            or "__pycache__" in path.parts
            or path.suffix == ".pyc"
            or (path.parts and path.parts[0] in {".pytest_cache", ".ruff_cache"})
        ):
            continue
        pb = path.as_posix().encode("utf-8")
        cb = content.encode("utf-8")
        digest.update(len(pb).to_bytes(8, "big")); digest.update(pb)
        digest.update(len(cb).to_bytes(8, "big")); digest.update(cb)
        included += 1
    return digest.hexdigest() if included else None


def _lean_manifest(manifest: dict, files: dict) -> dict:
    lean = {k: v for k, v in manifest.items() if k != "_files"}
    lean["_files_in_storage"] = True
    sha = _bundle_sha256(files)
    if sha:
        runtime = dict(lean["runtime"]) if isinstance(lean.get("runtime"), dict) else {}
        runtime["bundle_sha256"] = sha
        lean["runtime"] = runtime
    return lean


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="max rows to migrate (0 = all)")
    args = ap.parse_args()

    url = _env("SUPABASE_URL", "WORKEROS_CLOUD_SUPABASE_URL")
    key = _env("SUPABASE_SERVICE_ROLE_KEY", "WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        print("ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set", file=sys.stderr)
        return 2

    from supabase import create_client

    svc = create_client(url, key)

    # Ensure the bucket exists (idempotent).
    try:
        svc.storage.create_bucket(_BUCKET, options={"public": False, "file_size_limit": "50mb"})
        print(f"created bucket {_BUCKET}")
    except Exception as exc:
        if not ("already exists" in str(exc).lower() or "duplicate" in str(exc).lower()):
            print(f"warning: create_bucket: {exc}", file=sys.stderr)

    scanned = migrated = skipped = bytes_moved = 0
    offset = 0
    while True:
        resp = (
            svc.table("skill_versions")
            .select("id,manifest_json")
            .order("id")
            .range(offset, offset + _PAGE - 1)
            .execute()
        )
        rows = resp.data or []
        if not rows:
            break
        for row in rows:
            scanned += 1
            sv_id = row.get("id")
            manifest = row.get("manifest_json")
            if isinstance(manifest, str):
                try:
                    manifest = json.loads(manifest)
                except Exception:
                    manifest = {}
            if not isinstance(manifest, dict):
                skipped += 1
                continue
            files = manifest.get("_files")
            if manifest.get("_files_in_storage") or not isinstance(files, dict) or not files:
                skipped += 1
                continue
            size = len(json.dumps(files, separators=(",", ":")).encode("utf-8"))
            print(f"  migrate {sv_id}: {len(files)} files, {size/1e6:.2f} MB")
            if args.dry_run:
                migrated += 1
                bytes_moved += size
                continue
            payload = json.dumps(files, separators=(",", ":")).encode("utf-8")
            svc.storage.from_(_BUCKET).upload(
                path=f"{sv_id}/files.json",
                file=payload,
                file_options={"upsert": "true", "content-type": "application/json"},
            )
            svc.table("skill_versions").update(
                {"manifest_json": _lean_manifest(manifest, files)}
            ).eq("id", sv_id).execute()
            migrated += 1
            bytes_moved += size
            if args.limit and migrated >= args.limit:
                break
        if args.limit and migrated >= args.limit:
            break
        offset += _PAGE

    print(
        f"\n{'DRY-RUN ' if args.dry_run else ''}done: scanned={scanned} "
        f"migrated={migrated} skipped={skipped} freed~{bytes_moved/1e6:.1f} MB from metadata rows"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
