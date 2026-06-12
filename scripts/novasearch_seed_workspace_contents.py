#!/usr/bin/env python3
"""Seed the Nova Search WorkerOS workspace with current safe assets.

This is deliberately additive/idempotent:
- copies NovaSearch data snapshots into the workspace Brain pack
- registers existing WorkerOS worker bundles under the Nova Search workspace
- writes workspace-agent instructions describing the current operating surface

It does not disable or mutate nova-api.floom.dev.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from supabase import create_client


DEFAULT_ENV = Path("/etc/workeros-cloud/api.env")
DEFAULT_SOURCE_DATA = Path("/opt/novasearch-backend/data")
DEFAULT_CONTEXTS_ROOT = Path("/opt/workeros-cloud/var/contexts")
DEFAULT_ENGINE_WORKERS = Path("/opt/workeros-cloud/engine/workers")
DEFAULT_EMAIL = "fede@floom.dev"
DEFAULT_WORKSPACE_NAME = "Nova Search"
DEFAULT_PACK_NAME = "novasearch-data"

DATA_FILES = [
    "candidates.db",
    "query_log.db",
    "outreach.db",
    "judge_cache.db",
    "telemetry.db",
    "cities_de_at.json",
]

WORKER_BUNDLES = [
    "reverse_match_crm",
    "cv_writeup",
    "dach_compliance",
    "csv_enricher",
]

WORKSPACE_INSTRUCTIONS = """# Nova Search Workspace

This workspace is the WorkerOS Cloud migration target for NovaSearch.

Current verified assets:
- Brain pack `novasearch-data` contains snapshots from `/opt/novasearch-backend/data`.
- `candidates.db` is the CRM candidate source copied from the isolated NovaSearch backend.
- Worker bundles available in this workspace: Reverse Match CRM, CV Reformat + Writeup, DACH Compliance + Rate Benchmark, CSV Enricher.

Operating rules:
- Keep `nova-api.floom.dev` live until parity is verified.
- Treat mutable SQLite files in Brain as snapshots, not the final source of truth.
- Do not run paid external sourcing unless the user explicitly asks for external sourcing.
- Do not send outreach without explicit human confirmation.
- Do not expose secret values. List secret names only.

Known migration gaps:
- Full `/api/match` parity is not yet implemented as a WorkerOS worker.
- Query log, labels, tracked candidates, memory, outreach, judge cache, and telemetry still need workspace-scoped Supabase tables before WorkerOS can replace the isolated backend.
- LangDock/Emily tool parity is pending.
"""


def _load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _env(env_file: Path, *names: str) -> str:
    file_values = _load_env_file(env_file)
    for name in names:
        value = (os.environ.get(name) or file_values.get(name) or "").strip()
        if value:
            return value
    raise RuntimeError(f"missing required env value: {'/'.join(names)}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _rows(response: Any) -> list[dict[str, Any]]:
    data = getattr(response, "data", None) or []
    return [dict(row) for row in data]


def _one(response: Any) -> dict[str, Any] | None:
    rows = _rows(response)
    return rows[0] if rows else None


def _db_counts(path: Path) -> dict[str, int]:
    if path.suffix != ".db":
        return {}
    counts: dict[str, int] = {}
    with sqlite3.connect(path) as conn:
        tables = [
            row[0]
            for row in conn.execute(
                "select name from sqlite_master where type='table' order by name"
            ).fetchall()
        ]
        for table in tables:
            try:
                counts[table] = int(conn.execute(f'select count(*) from "{table}"').fetchone()[0])
            except sqlite3.Error:
                continue
    return counts


def _manifest_from_worker(bundle_dir: Path) -> dict[str, Any]:
    manifest_path = bundle_dir / "worker.yml"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"worker.yml not found: {manifest_path}")
    parsed = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise RuntimeError(f"worker.yml did not parse as a mapping: {manifest_path}")
    return parsed


def _worker_id(manifest: dict[str, Any]) -> str:
    return str(manifest.get("name") or "").strip().replace("_", "-")


def _skill_version_id(worker_id: str, version: str) -> str:
    safe = worker_id.replace("-", "_")
    safe_version = version.replace(".", "_")
    return f"sv_{safe}_{safe_version}"


def _copy_data_pack(*, source_root: Path, target_pack: Path) -> dict[str, Any]:
    target_pack.mkdir(parents=True, exist_ok=True)
    copied: dict[str, Any] = {}
    for name in DATA_FILES:
        source = source_root / name
        if not source.is_file():
            copied[name] = {"present": False}
            continue
        target = target_pack / name
        shutil.copy2(source, target)
        copied[name] = {
            "present": True,
            "size_bytes": target.stat().st_size,
            "counts": _db_counts(target),
        }
    return copied


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed Nova Search workspace contents")
    parser.add_argument("--apply", action="store_true", help="perform writes; default is dry-run")
    parser.add_argument("--email", default=DEFAULT_EMAIL)
    parser.add_argument("--workspace-name", default=DEFAULT_WORKSPACE_NAME)
    parser.add_argument("--pack-name", default=DEFAULT_PACK_NAME)
    parser.add_argument("--env-file", default=str(DEFAULT_ENV))
    parser.add_argument("--source-data", default=str(DEFAULT_SOURCE_DATA))
    parser.add_argument("--contexts-root", default=str(DEFAULT_CONTEXTS_ROOT))
    parser.add_argument("--engine-workers", default=str(DEFAULT_ENGINE_WORKERS))
    args = parser.parse_args()

    env_file = Path(args.env_file)
    url = _env(env_file, "SUPABASE_URL", "WORKEROS_CLOUD_SUPABASE_URL")
    service_key = _env(env_file, "SUPABASE_SERVICE_ROLE_KEY", "WORKEROS_CLOUD_SUPABASE_SERVICE_ROLE_KEY")
    client = create_client(url, service_key)

    email = args.email.strip().lower()
    user = _one(client.table("users").select("id,email").eq("email", email).limit(1).execute())
    if user is None:
        raise RuntimeError(f"public.users row not found for {email}")
    user_id = str(user["id"])
    workspace = _one(
        client.table("workspaces")
        .select("id,name,owner_user_id,created_at")
        .eq("owner_user_id", user_id)
        .eq("name", args.workspace_name)
        .limit(1)
        .execute()
    )
    if workspace is None:
        raise RuntimeError(f"workspace {args.workspace_name!r} not found for {email}")
    workspace_id = str(workspace["id"])

    contexts_root = Path(args.contexts_root)
    target_pack = contexts_root / workspace_id / args.pack_name
    metadata_path = contexts_root / workspace_id / ".workeros-contexts.json"
    report: dict[str, Any] = {
        "apply": args.apply,
        "email": email,
        "workspace": workspace,
        "pack_dir": str(target_pack),
        "workers": [],
    }

    if args.apply:
        data_report = _copy_data_pack(source_root=Path(args.source_data), target_pack=target_pack)
        metadata = {}
        if metadata_path.is_file():
            try:
                loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    metadata = loaded
            except json.JSONDecodeError:
                metadata = {}
        metadata[args.pack_name] = {
            **(metadata.get(args.pack_name) or {}),
            "owner_id": user_id,
            "writeable": False,
            "updated_at": _now_iso(),
        }
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    else:
        data_report = {
            name: {"present": (Path(args.source_data) / name).is_file()}
            for name in DATA_FILES
        }
    report["data_files"] = data_report

    engine_workers = Path(args.engine_workers)
    for bundle_name in WORKER_BUNDLES:
        bundle_dir = engine_workers / bundle_name
        manifest = _manifest_from_worker(bundle_dir)
        worker_id = _worker_id(manifest)
        version = str(manifest.get("version") or "0.1.0")
        skill_version_id = _skill_version_id(worker_id, version)
        trigger = manifest.get("trigger") if isinstance(manifest.get("trigger"), dict) else {}
        worker_name = str(manifest.get("title") or manifest.get("name") or worker_id)
        worker_report = {
            "worker_id": worker_id,
            "skill_version_id": skill_version_id,
            "name": worker_name,
            "bundle_path": str(bundle_dir),
        }
        if args.apply:
            client.table("skill_versions").upsert(
                {
                    "id": skill_version_id,
                    "user_id": user_id,
                    "name": str(manifest.get("name") or worker_id),
                    "version": version,
                    "manifest_json": manifest,
                    "bundle_path": str(bundle_dir),
                    "created_at": _now_iso(),
                },
                on_conflict="id",
            ).execute()
            existing = _one(client.table("workers").select("id").eq("id", worker_id).limit(1).execute())
            payload = {
                "id": worker_id,
                "user_id": user_id,
                "workspace_id": workspace_id,
                "skill_version_id": skill_version_id,
                "name": worker_name,
                "trigger_type": str(trigger.get("type") or "manual"),
                "cron_expr": trigger.get("cron"),
                "cron_timezone": trigger.get("timezone"),
                "notify_email": False,
                "grants_json": {},
                "input_values_json": {},
                "enabled": True,
                "created_at": _now_iso(),
                "triggers_json": [],
            }
            if existing:
                client.table("workers").update(payload).eq("id", worker_id).execute()
                worker_report["action"] = "updated"
            else:
                client.table("workers").insert(payload).execute()
                worker_report["action"] = "inserted"
        report["workers"].append(worker_report)

    if args.apply:
        client.table("workspace_agent_settings").upsert(
            {
                "workspace_id": workspace_id,
                "instructions_md": WORKSPACE_INSTRUCTIONS,
            },
            on_conflict="workspace_id",
        ).execute()
        report["workspace_agent_settings"] = "upserted"
    else:
        report["workspace_agent_settings"] = "would_upsert"

    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
