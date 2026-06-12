#!/usr/bin/env python3
"""Backfill NovaSearch SQLite state into WorkerOS Cloud Supabase tables."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from supabase import create_client


DEFAULT_ENV = Path("/etc/workeros-cloud/api.env")
DEFAULT_WORKSPACE_ID = "ws_8bdb2e8127db4f"
DEFAULT_USER_ID = "31fa31b6-47bf-4056-9abc-fe96a7066fee"
DEFAULT_DATA_PACK = Path(
    "/opt/workeros-cloud/var/contexts/ws_8bdb2e8127db4f/novasearch-data"
)


def _load_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _parse_json(raw: Any, default: Any) -> Any:
    if raw in (None, ""):
        return default
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(str(raw))
    except Exception:
        return default


def _bool_int(raw: Any) -> bool:
    return bool(int(raw or 0))


def _to_iso(raw: Any) -> str | None:
    if raw in (None, ""):
        return None
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(float(raw), tz=timezone.utc).isoformat()
    text = str(raw).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return text
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


def _hash_text(raw: Any) -> str | None:
    text = str(raw or "")
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _redact_text(raw: Any, *, max_len: int = 240) -> str:
    text = " ".join(str(raw or "").split())
    if not text:
        return ""
    if len(text) <= max_len:
        return text
    return text[: max_len - 1].rstrip() + "…"


def _hash_session(raw: Any) -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _stable_id(workspace_id: str, table: str, old_id: Any) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"workeros://novasearch/{workspace_id}/{table}/{old_id}"))


def _rows(db_path: Path, query: str) -> list[sqlite3.Row]:
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        return list(conn.execute(query).fetchall())


def _upsert(client: Any, table: str, rows: list[dict[str, Any]], *, on_conflict: str) -> int:
    if not rows:
        return 0
    for i in range(0, len(rows), 100):
        batch = rows[i : i + 100]
        client.table(table).upsert(batch, on_conflict=on_conflict).execute()
    return len(rows)


def build_rows(data_pack: Path, workspace_id: str, user_id: str) -> dict[str, list[dict[str, Any]]]:
    query_log = data_pack / "query_log.db"
    outreach = data_pack / "outreach.db"
    judge_cache = data_pack / "judge_cache.db"
    telemetry = data_pack / "telemetry.db"

    match_queries = [
        {
            "workspace_id": workspace_id,
            "user_id": user_id,
            "id": row["id"],
            "ts": row["ts"],
            "created_at": _to_iso(row["created_at"]),
            "job_title": row["job_title"],
            "required_modules": _parse_json(row["required_modules"], []),
            "nice_modules": _parse_json(row["nice_modules"], []),
            "location": row["location"],
            "locations": _parse_json(row["locations"], []),
            "min_years": row["min_years"],
            "salary_min": row["salary_min"],
            "salary_max": row["salary_max"],
            "include_external": _bool_int(row["include_external"]),
            "use_ai_curation": _bool_int(row["use_ai_curation"]),
            "custom_requirements": row["custom_requirements"],
            "query_json": _parse_json(row["query_json"], {}),
            "total_scored": row["total_scored"],
            "curated_count": row["curated_count"],
            "downloadable_count": row["downloadable_count"],
            "external_count": row["external_count"],
            "elapsed_s": row["elapsed_s"],
            "top_json": _parse_json(row["top_json"], []),
            "created_from": "sqlite-backfill",
        }
        for row in _rows(query_log, "select * from match_queries")
    ]

    match_labels = [
        {
            "workspace_id": workspace_id,
            "user_id": user_id,
            "query_id": row["query_id"],
            "rank": row["rank"],
            "candidate_key": row["candidate_key"],
            "source": row["source"],
            "worth_contact": None if row["worth_contact"] is None else _bool_int(row["worth_contact"]),
            "reason": row["reason"],
            "labeled_at": _to_iso(row["labeled_at"]),
        }
        for row in _rows(query_log, "select * from match_labels")
    ]

    tracked_candidates = [
        {
            "id": _stable_id(workspace_id, "tracked_candidates", row["id"]),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "old_id": row["id"],
            "candidate_key": row["candidate_key"],
            "name": row["name"],
            "title": row["title"],
            "company": row["company"],
            "location": row["location"],
            "source": row["source"],
            "mandate": row["mandate"],
            "status": row["status"],
            "score": row["score"],
            "notes": row["notes"],
            "first_seen": _to_iso(row["first_seen"]),
            "last_updated": _to_iso(row["last_updated"]),
        }
        for row in _rows(outreach, "select * from tracked_candidates")
    ]

    outreach_rows = [
        {
            "id": _stable_id(workspace_id, "outreach", row["id"]),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "old_id": row["id"],
            "mandate": row["mandate"],
            "candidate_name": row["candidate_name"],
            "linkedin_url": row["linkedin_url"],
            "message_redacted": _redact_text(row["message"]),
            "message_hash": _hash_text(row["message"]),
            "status": row["status"],
            "created_at": _to_iso(row["created_at"]),
            "sent_at": _to_iso(row["sent_at"]),
            "replied_at": _to_iso(row["replied_at"]),
            "phantom_container_id": row["phantom_container_id"],
        }
        for row in _rows(outreach, "select * from outreach")
    ]

    memory = [
        {
            "id": _stable_id(workspace_id, "memory", row["id"]),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "old_id": row["id"],
            "scope": row["scope"],
            "kind": row["kind"],
            "text": row["text"],
            "created_at": _to_iso(row["created_at"]),
        }
        for row in _rows(outreach, "select * from memory")
    ]

    judge_rows = [
        {
            "workspace_id": workspace_id,
            "user_id": user_id,
            "cache_key": row["cache_key"],
            "mandate_signature": row["mandate_signature"],
            "candidate_key": row["candidate_key"],
            "model": row["model"],
            "prompt_version": row["prompt_version"],
            "verdict_json": _parse_json(row["verdict_json"], {}),
            "created_at": _to_iso(row["created_at"]),
        }
        for row in _rows(judge_cache, "select * from judge_cache")
    ]

    session_events = [
        {
            "id": _stable_id(workspace_id, "session_events", row["id"]),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "old_id": row["id"],
            "created_at": _to_iso(row["created_at"]),
            "session_id_hash": _hash_session(row["session_id"]),
            "request_id": row["request_id"],
            "source": row["source"],
            "event_type": row["event_type"],
            "tool_name": row["tool_name"],
            "rpc_method": row["rpc_method"],
            "status": row["status"],
            "duration_ms": row["duration_ms"],
            "error_message": row["error_message"],
            "metadata_json": _parse_json(row["metadata_json"], {}),
        }
        for row in _rows(telemetry, "select * from session_events")
    ]

    issue_reports = [
        {
            "id": _stable_id(workspace_id, "issue_reports", row["id"]),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "old_id": row["id"],
            "created_at": _to_iso(row["created_at"]),
            "title": row["title"],
            "description_redacted": _redact_text(row["description"]),
            "description_hash": _hash_text(row["description"]),
            "severity": row["severity"],
            "area": row["area"],
            "session_id_hash": _hash_session(row["session_id"]),
            "chat_url": row["chat_url"],
            "reporter": row["reporter"],
            "github_issue_url": row["github_issue_url"],
            "github_issue_number": row["github_issue_number"],
            "status": row["status"],
            "metadata_json": _parse_json(row["metadata_json"], {}),
        }
        for row in _rows(telemetry, "select * from issue_reports")
    ]

    return {
        "novasearch_match_queries": match_queries,
        "novasearch_match_labels": match_labels,
        "novasearch_tracked_candidates": tracked_candidates,
        "novasearch_outreach": outreach_rows,
        "novasearch_memory": memory,
        "novasearch_judge_cache": judge_rows,
        "novasearch_session_events": session_events,
        "novasearch_issue_reports": issue_reports,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill NovaSearch state into WorkerOS Supabase")
    parser.add_argument("--apply", action="store_true", help="write rows; default only prints counts")
    parser.add_argument("--env-file", default=str(DEFAULT_ENV))
    parser.add_argument("--data-pack", default=str(DEFAULT_DATA_PACK))
    parser.add_argument("--workspace-id", default=DEFAULT_WORKSPACE_ID)
    parser.add_argument("--user-id", default=DEFAULT_USER_ID)
    args = parser.parse_args()

    data_pack = Path(args.data_pack)
    rows_by_table = build_rows(data_pack, args.workspace_id, args.user_id)
    report = {"apply": bool(args.apply), "counts": {k: len(v) for k, v in rows_by_table.items()}}
    if not args.apply:
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0

    env = _load_env(Path(args.env_file))
    client = create_client(env["SUPABASE_URL"], env["SUPABASE_SERVICE_ROLE_KEY"])
    written: dict[str, int] = {}
    written["novasearch_match_queries"] = _upsert(
        client,
        "novasearch_match_queries",
        rows_by_table["novasearch_match_queries"],
        on_conflict="workspace_id,id",
    )
    written["novasearch_match_labels"] = _upsert(
        client,
        "novasearch_match_labels",
        rows_by_table["novasearch_match_labels"],
        on_conflict="workspace_id,query_id,candidate_key",
    )
    written["novasearch_tracked_candidates"] = _upsert(
        client,
        "novasearch_tracked_candidates",
        rows_by_table["novasearch_tracked_candidates"],
        on_conflict="workspace_id,candidate_key,mandate",
    )
    written["novasearch_outreach"] = _upsert(
        client,
        "novasearch_outreach",
        rows_by_table["novasearch_outreach"],
        on_conflict="workspace_id,mandate,linkedin_url",
    )
    written["novasearch_memory"] = _upsert(
        client,
        "novasearch_memory",
        rows_by_table["novasearch_memory"],
        on_conflict="id",
    )
    written["novasearch_judge_cache"] = _upsert(
        client,
        "novasearch_judge_cache",
        rows_by_table["novasearch_judge_cache"],
        on_conflict="workspace_id,cache_key",
    )
    written["novasearch_session_events"] = _upsert(
        client,
        "novasearch_session_events",
        rows_by_table["novasearch_session_events"],
        on_conflict="id",
    )
    written["novasearch_issue_reports"] = _upsert(
        client,
        "novasearch_issue_reports",
        rows_by_table["novasearch_issue_reports"],
        on_conflict="id",
    )
    report["written"] = written
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
