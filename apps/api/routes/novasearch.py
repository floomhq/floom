from __future__ import annotations

import html
import json
import os
import re
import sys
import threading
import time
import uuid
import hashlib
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse

from apps.api.auth.workspace_context import get_active_workspace_id
from apps.api._engine import ensure_engine_api_path
from apps.api.config import new_supabase_service_client

ensure_engine_api_path()

from auth import AuthContext, get_auth_context  # noqa: E402


router = APIRouter(prefix="/novasearch", tags=["novasearch"])

_NOVASEARCH_BACKEND = Path(
    os.environ.get("WORKEROS_NOVASEARCH_BACKEND_DIR", "/opt/novasearch-backend")
).resolve()
_CONTEXTS_DIR = Path(os.environ.get("FLOOM_CONTEXTS_DIR", "/opt/workeros-cloud/var/contexts"))
_DATA_PACK_NAME = os.environ.get("WORKEROS_NOVASEARCH_DATA_PACK", "novasearch-data")
_MATCH_LOCK = threading.Lock()
_IMPORT_LOCK = threading.Lock()
_MATCH_MODULES: dict[str, Any] | None = None
_MATCH_JOBS_LOCK = threading.Lock()
_MATCH_JOBS: dict[str, dict[str, Any]] = {}
_MATCH_JOB_TTL_SECONDS = 30 * 60
_REVIEW_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_VALID_STATUSES = ("sourced", "contacted", "replied", "shortlisted", "rejected")
_VALID_KINDS = ("rule", "fact", "feedback", "preference")
_VALID_SEVERITIES = ("low", "medium", "high", "critical")
_ACTIVE_OUTREACH_STATUSES = {"queued", "queued_dryrun", "sent"}
_LINKEDIN_MARKER = "linkedin.com/in/"


def _load_matcher() -> dict[str, Any]:
    global _MATCH_MODULES
    if _MATCH_MODULES is not None:
        return _MATCH_MODULES
    with _IMPORT_LOCK:
        if _MATCH_MODULES is not None:
            return _MATCH_MODULES
        if not (_NOVASEARCH_BACKEND / "server" / "app.py").is_file():
            raise RuntimeError(f"NovaSearch backend missing at {_NOVASEARCH_BACKEND}")
        backend_path = str(_NOVASEARCH_BACKEND)
        if backend_path not in sys.path:
            sys.path.append(backend_path)

        from lib import db as nova_db  # type: ignore
        from lib import query_log as nova_query_log  # type: ignore
        from lib.validation import validate_request  # type: ignore
        from server.app import _run_match_sync  # type: ignore

        _MATCH_MODULES = {
            "db": nova_db,
            "query_log": nova_query_log,
            "validate_request": validate_request,
            "run_match_sync": _run_match_sync,
        }
        return _MATCH_MODULES


@lru_cache(maxsize=1)
def _mcp_tool_definitions() -> list[dict[str, Any]]:
    backend_path = str(_NOVASEARCH_BACKEND)
    if backend_path not in sys.path:
        sys.path.append(backend_path)
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "_workeros_novasearch_old_mcp_defs",
        _NOVASEARCH_BACKEND / "api" / "mcp.py",
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("NovaSearch MCP definitions could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return json.loads(json.dumps(list(module.TOOLS)))


def _require_workspace_id() -> str:
    workspace_id = get_active_workspace_id()
    if not workspace_id:
        raise HTTPException(status_code=400, detail="active workspace is required")
    return workspace_id


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    return text[: max_len - 1].rstrip() + "..."


def _stable_uuid(workspace_id: str, table: str, key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"workeros://novasearch/{workspace_id}/{table}/{key}"))


def _html_cell(value: Any) -> str:
    """HTML-escape a candidate/label field before interpolating into the review
    page (#218). Candidate name/title/company and label reason are attacker-
    controllable (sourced from CRM/LinkedIn/match payloads), so rendering them
    raw allowed stored XSS. ``None`` renders as empty, matching the prior ``or ''``.
    """
    if value is None:
        return ""
    return html.escape(str(value), quote=True)


def _candidate_key(item: dict[str, Any]) -> tuple[str, str]:
    source = str(item.get("source") or "").strip().lower()
    linkedin_url = str(item.get("linkedin_url") or "").strip()
    candidate_id = item.get("candidate_id")
    if candidate_id is None:
        candidate_id = item.get("id")
    explicit = str(item.get("candidate_key") or "").strip()
    if explicit:
        return explicit, source or ("linkedin" if linkedin_url else "crm")
    if source == "linkedin" or (not source and linkedin_url):
        if linkedin_url:
            return linkedin_url, "linkedin"
    if candidate_id is not None and str(candidate_id).strip():
        return str(candidate_id).strip(), source or "crm"
    if linkedin_url:
        return linkedin_url, source or "linkedin"
    return "", source or "crm"


def _tool_ok(result: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False, default=str)}],
        "isError": False,
    }


def _tool_error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _workspace_data_pack(workspace_id: str) -> Path:
    data_pack = (_CONTEXTS_DIR / workspace_id / _DATA_PACK_NAME).resolve()
    contexts_root = _CONTEXTS_DIR.resolve()
    try:
        data_pack.relative_to(contexts_root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid workspace data pack path") from exc
    if not (data_pack / "candidates.db").is_file():
        raise HTTPException(status_code=404, detail="NovaSearch candidates.db not found in workspace Brain")
    return data_pack


def _configure_matcher_for_pack(data_pack: Path) -> None:
    modules = _load_matcher()
    nova_db = modules["db"]
    nova_query_log = modules["query_log"]
    candidates_db = str(data_pack / "candidates.db")
    query_log_db = str(data_pack / "query_log.db")
    if getattr(nova_db, "DB_PATH", None) != candidates_db:
        nova_db.DB_PATH = candidates_db
        nova_db._cached_candidates = None
    nova_query_log._DB_PATH = query_log_db


def _record_match_query_supabase(
    *,
    workspace_id: str,
    user_id: str,
    sanitized: dict[str, Any],
    result: dict[str, Any],
    modules: dict[str, Any],
) -> None:
    query_id = result.get("query_log_id")
    if not query_id:
        return
    ranked = result.get("downloadable_matches") or result.get("curated_matches") or []
    external_count = sum(1 for candidate in ranked if candidate.get("result_source") == "external_linkedin")
    top_json = modules["query_log"]._candidate_snapshot(ranked)
    now = time.time()
    new_supabase_service_client().table("novasearch_match_queries").upsert(
        {
            "workspace_id": workspace_id,
            "user_id": user_id,
            "id": query_id,
            "ts": now,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "job_title": sanitized.get("job_title"),
            "required_modules": sanitized.get("required_modules") or [],
            "nice_modules": sanitized.get("nice_modules") or [],
            "location": sanitized.get("location"),
            "locations": sanitized.get("locations") or [],
            "min_years": sanitized.get("min_years_experience"),
            "salary_min": sanitized.get("salary_min_eur"),
            "salary_max": sanitized.get("salary_max_eur"),
            "include_external": bool(sanitized.get("include_external")),
            "use_ai_curation": bool(sanitized.get("use_ai_curation")),
            "custom_requirements": (sanitized.get("custom_requirements") or "")[:2000],
            "query_json": json.loads(json.dumps(sanitized, default=str)) if sanitized else {},
            "total_scored": result.get("total_scored"),
            "curated_count": len(result.get("curated_matches") or []),
            "downloadable_count": len(result.get("downloadable_matches") or []),
            "external_count": external_count,
            "elapsed_s": (result.get("response_time_ms") or 0) / 1000.0,
            "top_json": top_json,
            "created_from": "workeros-live",
        },
        on_conflict="workspace_id,id",
    ).execute()


def _review_url(query_id: str) -> str:
    api_base = (
        os.environ.get("WORKEROS_NOVASEARCH_REVIEW_BASE_URL")
        or os.environ.get("WORKEROS_API_BASE")
        or os.environ.get("WORKERS_API_URL")
        or "https://workeros-api.floom.dev"
    ).rstrip("/")
    return f"{api_base}/api/novasearch/review/{query_id}"


def _query_row_by_id(query_id: str) -> dict[str, Any] | None:
    rows = (
        new_supabase_service_client()
        .table("novasearch_match_queries")
        .select("*")
        .eq("id", query_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else None


def _mcp_initialize(params: dict[str, Any]) -> dict[str, Any]:
    requested = params.get("protocolVersion")
    supported = {"2024-11-05", "2025-03-26", "2025-06-18"}
    return {
        "protocolVersion": requested if requested in supported else "2025-06-18",
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "novasearch-workeros", "version": "1.0.0"},
    }


def _mcp_find_sap_candidates(
    *,
    workspace_id: str,
    user_id: str,
    arguments: dict[str, Any],
    request_id: str | None,
) -> dict[str, Any]:
    modules = _load_matcher()
    valid, sanitized, error = modules["validate_request"](arguments)
    if not valid:
        return _tool_error(f"Invalid arguments: {error}")
    if "ranking_version" not in arguments:
        sanitized["ranking_version"] = "v2"
    data_pack = _workspace_data_pack(workspace_id)
    with _MATCH_LOCK:
        _configure_matcher_for_pack(data_pack)
        result = modules["run_match_sync"](sanitized, request_id=request_id)
    try:
        _record_match_query_supabase(
            workspace_id=workspace_id,
            user_id=user_id,
            sanitized=sanitized,
            result=result,
            modules=modules,
        )
    except Exception:
        pass
    mcp_result = {
        "curated_matches": (result.get("curated_matches") or [])[:10],
        "total_scored": result.get("total_scored"),
        "curation_method": result.get("curation_method"),
        "ranking_version": sanitized.get("ranking_version", "v2"),
        "include_external": bool(sanitized.get("include_external")),
        "response_time_ms": result.get("response_time_ms"),
    }
    if result.get("query_log_id"):
        mcp_result["query_log_id"] = result["query_log_id"]
        mcp_result["review_url"] = _review_url(str(result["query_log_id"]))
    return _tool_ok(mcp_result)


def _queue_outreach(workspace_id: str, user_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    mandate = str(arguments.get("mandate") or "").strip()
    messages = arguments.get("messages")
    if not mandate:
        return {
            "queued": 0,
            "skipped_duplicates": 0,
            "errors": ["mandate fehlt (mandate is required)."],
            "dryrun": True,
            "message": "Kein mandate angegeben.",
        }
    if not isinstance(messages, list):
        return {"queued": 0, "skipped_duplicates": 0, "errors": ["messages must be an array."], "dryrun": True}

    valid_items: list[dict[str, str]] = []
    errors: list[str] = []
    for idx, item in enumerate(messages):
        item = item if isinstance(item, dict) else {}
        linkedin_url = str(item.get("linkedin_url") or "").strip()
        message = str(item.get("message") or "").strip()
        name = str(item.get("candidate_name") or "").strip()
        if _LINKEDIN_MARKER not in linkedin_url.lower():
            errors.append(f"Eintrag {idx + 1} ({name or 'ohne Namen'}): ungueltige linkedin_url.")
            continue
        if not message:
            errors.append(f"Eintrag {idx + 1} ({name or 'ohne Namen'}): leere Nachricht.")
            continue
        valid_items.append({"candidate_name": name, "linkedin_url": linkedin_url, "message": message})

    client = new_supabase_service_client()
    queued = 0
    skipped = 0
    rows: list[dict[str, Any]] = []
    now = _now_iso()
    for item in valid_items:
        existing = (
            client.table("novasearch_outreach")
            .select("id,status")
            .eq("workspace_id", workspace_id)
            .eq("mandate", mandate)
            .eq("linkedin_url", item["linkedin_url"])
            .limit(1)
            .execute()
            .data
            or []
        )
        if existing and existing[0].get("status") in _ACTIVE_OUTREACH_STATUSES:
            skipped += 1
            continue
        payload = {
            "id": _stable_uuid(workspace_id, "outreach", f"{mandate}:{item['linkedin_url']}"),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "mandate": mandate,
            "candidate_name": item["candidate_name"],
            "linkedin_url": item["linkedin_url"],
            "message_redacted": _redact_text(item["message"]),
            "message_hash": _hash_text(item["message"]),
            "status": "queued_dryrun",
            "created_at": now,
        }
        client.table("novasearch_outreach").upsert(payload, on_conflict="workspace_id,mandate,linkedin_url").execute()
        queued += 1
        rows.append({"candidate_name": item["candidate_name"], "linkedin_url": item["linkedin_url"], "status": "queued_dryrun"})
    message = f"{queued} Nachrichten vorgemerkt (Testmodus, noch nicht gesendet)."
    if skipped:
        message += f" {skipped} Duplikate uebersprungen."
    result = {"queued": queued, "skipped_duplicates": skipped, "dryrun": True, "message": message, "rows": rows}
    if errors:
        result["errors"] = errors
    return result


def _outreach_status(workspace_id: str, mandate: Any = None) -> dict[str, Any]:
    builder = (
        new_supabase_service_client()
        .table("novasearch_outreach")
        .select("id,mandate,candidate_name,linkedin_url,status,created_at,sent_at,replied_at")
        .eq("workspace_id", workspace_id)
        .order("created_at", desc=True)
    )
    if mandate and str(mandate).strip():
        builder = builder.eq("mandate", str(mandate).strip())
    rows = builder.execute().data or []
    counts = {"queued": 0, "sent": 0, "replied": 0, "booked": 0}
    for row in rows:
        status = row.get("status")
        if status in {"queued", "queued_dryrun"}:
            counts["queued"] += 1
        elif status in counts:
            counts[status] += 1
    scope = f"fuer '{mandate}'" if mandate and str(mandate).strip() else "gesamt"
    return {
        **counts,
        "total": len(rows),
        "rows": rows,
        "message": f"Stand {scope}: {counts['queued']} vorgemerkt/gesendet, {counts['sent']} gesendet, {counts['replied']} Antworten, {counts['booked']} Termine.",
    }


def _track_candidates(workspace_id: str, user_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    mandate = str(arguments.get("mandate") or "").strip()
    candidates = arguments.get("candidates")
    if not mandate:
        return {"tracked": 0, "updated": 0, "total": 0, "errors": ["mandate fehlt (mandate is required)."], "message": "Kein mandate angegeben."}
    if not isinstance(candidates, list):
        return {"tracked": 0, "updated": 0, "total": 0, "errors": ["candidates must be an array."]}
    client = new_supabase_service_client()
    tracked = 0
    updated = 0
    errors: list[str] = []
    now = _now_iso()
    for idx, item in enumerate(candidates):
        item = item if isinstance(item, dict) else {}
        key, source = _candidate_key(item)
        if not key:
            errors.append(f"Eintrag {idx + 1} ({item.get('name') or 'ohne Namen'}): weder candidate_id noch linkedin_url vorhanden.")
            continue
        existing = (
            client.table("novasearch_tracked_candidates")
            .select("id")
            .eq("workspace_id", workspace_id)
            .eq("candidate_key", key)
            .eq("mandate", mandate)
            .limit(1)
            .execute()
            .data
            or []
        )
        status = str(item.get("status") or "sourced").strip().lower()
        if status not in _VALID_STATUSES:
            status = "sourced"
        payload = {
            "id": _stable_uuid(workspace_id, "tracked_candidates", f"{mandate}:{key}"),
            "workspace_id": workspace_id,
            "user_id": user_id,
            "candidate_key": key,
            "name": item.get("name"),
            "title": item.get("title") or item.get("current_title"),
            "company": item.get("company") or item.get("current_company"),
            "location": item.get("location"),
            "source": source,
            "mandate": mandate,
            "status": status,
            "score": item.get("score"),
            "notes": item.get("notes"),
            "last_updated": now,
        }
        if not existing:
            payload["first_seen"] = now
        client.table("novasearch_tracked_candidates").upsert(payload, on_conflict="workspace_id,candidate_key,mandate").execute()
        tracked += 0 if existing else 1
        updated += 1 if existing else 0
    total = (
        client.table("novasearch_tracked_candidates")
        .select("id", count="exact")
        .eq("workspace_id", workspace_id)
        .eq("mandate", mandate)
        .execute()
        .count
        or 0
    )
    result = {"tracked": tracked, "updated": updated, "total": total, "message": f"{tracked} neue Kandidaten verfolgt, {updated} aktualisiert (Mandat '{mandate}', gesamt {total})."}
    if errors:
        result["errors"] = errors
    return result


def _tracked_candidates(workspace_id: str, mandate: Any = None, status: Any = None) -> dict[str, Any]:
    builder = (
        new_supabase_service_client()
        .table("novasearch_tracked_candidates")
        .select("*")
        .eq("workspace_id", workspace_id)
        .order("last_updated", desc=True)
    )
    if mandate and str(mandate).strip():
        builder = builder.eq("mandate", str(mandate).strip())
    if status and str(status).strip():
        builder = builder.eq("status", str(status).strip().lower())
    rows = builder.execute().data or []
    counts = {s: 0 for s in _VALID_STATUSES}
    for row in rows:
        if row.get("status") in counts:
            counts[row["status"]] += 1
    scope = f"Mandat '{mandate}'" if mandate and str(mandate).strip() else "alle Mandate"
    breakdown = ", ".join(f"{s_count} {s}" for s, s_count in counts.items() if s_count) or "keine"
    return {"rows": rows, "counts": counts, "total": len(rows), "message": f"{len(rows)} verfolgte Kandidaten ({scope}): {breakdown}."}


def _update_candidate(workspace_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    key = str(arguments.get("candidate_key") or "").strip()
    mandate = str(arguments.get("mandate") or "").strip()
    if not key:
        return {"updated": False, "error": "candidate_key fehlt."}
    if not mandate:
        return {"updated": False, "error": "mandate fehlt."}
    client = new_supabase_service_client()
    rows = (
        client.table("novasearch_tracked_candidates")
        .select("*")
        .eq("workspace_id", workspace_id)
        .eq("candidate_key", key)
        .eq("mandate", mandate)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return {"updated": False, "error": f"Kandidat '{key}' fuer Mandat '{mandate}' nicht gefunden."}
    row = rows[0]
    status = arguments.get("status")
    payload: dict[str, Any] = {"last_updated": _now_iso()}
    if status is not None:
        status = str(status).strip().lower()
        if status not in _VALID_STATUSES:
            return {"updated": False, "error": f"Ungueltiger status '{status}'."}
        payload["status"] = status
    note = arguments.get("note")
    if note is not None and str(note).strip():
        stamped = f"[{payload['last_updated']}] {str(note).strip()}"
        payload["notes"] = f"{row.get('notes')}\n{stamped}" if row.get("notes") else stamped
    updated = client.table("novasearch_tracked_candidates").update(payload).eq("id", row["id"]).execute().data[0]
    updated["updated"] = True
    updated["message"] = f"Kandidat '{updated.get('name') or key}' aktualisiert: Status '{updated['status']}'."
    return updated


def _remember(workspace_id: str, user_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    text = str(arguments.get("text") or "").strip()
    if not text:
        return {"stored": False, "error": "text fehlt.", "message": "Kein Text angegeben."}
    kind = str(arguments.get("kind") or "fact").strip().lower()
    if kind not in _VALID_KINDS:
        kind = "fact"
    scope = str(arguments.get("scope") or "global").strip() or "global"
    row = (
        new_supabase_service_client()
        .table("novasearch_memory")
        .insert({"workspace_id": workspace_id, "user_id": user_id, "scope": scope, "kind": kind, "text": text, "created_at": _now_iso()})
        .execute()
        .data[0]
    )
    return {"stored": True, "id": row["id"], "scope": scope, "kind": kind, "text": text, "message": f"Gemerkt ({kind}, Bereich '{scope}'): {text}"}


def _recall(workspace_id: str, scope: Any = None) -> dict[str, Any]:
    rows = (
        new_supabase_service_client()
        .table("novasearch_memory")
        .select("id,scope,kind,text,created_at")
        .eq("workspace_id", workspace_id)
        .order("created_at")
        .execute()
        .data
        or []
    )
    scope_text = str(scope or "").strip()
    if scope_text and scope_text != "global":
        items = [row for row in rows if row.get("scope") in {"global", scope_text}]
    else:
        items = [row for row in rows if row.get("scope") == "global"]
    if items:
        scope_label = f" inkl. Mandat '{scope_text}'" if scope_text and scope_text != "global" else ""
        lines = [f"- ({item['kind']}/{item['scope']}) {item['text']}" for item in items]
        message = f"{len(items)} gemerkte Einträge (global{scope_label}):\n" + "\n".join(lines)
    else:
        message = "Keine gemerkten Einträge vorhanden."
    return {"items": items, "total": len(items), "message": message}


def _daily_briefing(workspace_id: str) -> dict[str, Any]:
    tracked = _tracked_candidates(workspace_id)["rows"]
    outreach = _outreach_status(workspace_id)["rows"]
    now = _now_iso()
    status_counts = {s: 0 for s in _VALID_STATUSES}
    mandates: dict[str, int] = {}
    for row in tracked:
        if row.get("status") in status_counts:
            status_counts[row["status"]] += 1
        mandates[row["mandate"]] = mandates.get(row["mandate"], 0) + 1
    follow_up = [
        row for row in outreach
        if row.get("status") in {"queued", "queued_dryrun", "sent"} and not row.get("replied_at")
    ] + [row for row in tracked if row.get("status") == "contacted"]
    replies = [row for row in outreach if row.get("status") == "replied" or row.get("replied_at")] + [row for row in tracked if row.get("status") == "replied"]
    lines = ["Tagesbriefing - NovaSearch / Emily", f"Stand: {now}", "", f"Verfolgte Kandidaten gesamt: {len(tracked)}"]
    if mandates:
        lines.extend(["", "Mandate in Arbeit:"])
        lines.extend(f"  - {mandate}: {count} Kandidaten" for mandate, count in sorted(mandates.items(), key=lambda item: -item[1]))
    lines.extend(["", f"Follow-up nötig (kontaktiert, keine Antwort): {len(follow_up)}"])
    for row in follow_up[:25]:
        lines.append(f"  - {row.get('candidate_name') or row.get('name') or row.get('linkedin_url') or row.get('candidate_key')} ({row.get('mandate')})")
    lines.extend(["", f"Antworten: {len(replies)}"])
    return {"briefing": "\n".join(lines).rstrip(), "generated_at": now, "tracked_total": len(tracked), "status_counts": status_counts, "follow_up_needed": len(follow_up), "replies": len(replies), "mandates": mandates}


def _report_issue(workspace_id: str, user_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    title = _redact_text(arguments.get("title"), max_len=180).strip()
    description = _redact_text(arguments.get("description"), max_len=4000).strip()
    if not title:
        return {"reported": False, "error": "title fehlt.", "message": "Kein Titel angegeben."}
    if not description:
        return {"reported": False, "error": "description fehlt.", "message": "Keine Beschreibung angegeben."}
    severity = str(arguments.get("severity") or "medium").strip().lower()
    if severity not in _VALID_SEVERITIES:
        severity = "medium"
    row = (
        new_supabase_service_client()
        .table("novasearch_issue_reports")
        .insert({
            "workspace_id": workspace_id,
            "user_id": user_id,
            "created_at": _now_iso(),
            "title": title,
            "description_redacted": description,
            "description_hash": _hash_text(arguments.get("description")),
            "severity": severity,
            "area": _redact_text(arguments.get("area"), max_len=120) or None,
            "session_id_hash": _hash_text(arguments.get("session_id")),
            "chat_url": _redact_text(arguments.get("chat_url"), max_len=1000) or None,
            "reporter": _redact_text(arguments.get("reporter"), max_len=200) or None,
            "status": "local_only",
            "metadata_json": arguments.get("metadata") if isinstance(arguments.get("metadata"), dict) else {},
        })
        .execute()
        .data[0]
    )
    row["reported"] = True
    row["message"] = f"Issue gespeichert: {title}. GitHub nicht konfiguriert oder nicht erreichbar; lokal gespeichert."
    return row


def _evict_old_jobs() -> None:
    cutoff = time.time() - _MATCH_JOB_TTL_SECONDS
    with _MATCH_JOBS_LOCK:
        for job_id, entry in list(_MATCH_JOBS.items()):
            if float(entry.get("created_at") or 0) < cutoff:
                _MATCH_JOBS.pop(job_id, None)


def _run_background_match_job(
    *,
    job_id: str,
    workspace_id: str,
    user_id: str,
    data_pack: Path,
    sanitized: dict[str, Any],
    request_id: str | None,
) -> None:
    try:
        modules = _load_matcher()
        with _MATCH_LOCK:
            _configure_matcher_for_pack(data_pack)
            result = modules["run_match_sync"](sanitized, request_id=request_id)
        try:
            _record_match_query_supabase(
                workspace_id=workspace_id,
                user_id=user_id,
                sanitized=sanitized,
                result=result,
                modules=modules,
            )
        except Exception:
            pass
        with _MATCH_JOBS_LOCK:
            if job_id in _MATCH_JOBS:
                _MATCH_JOBS[job_id].update({"status": "done", "result": result, "error": None})
    except Exception as exc:
        with _MATCH_JOBS_LOCK:
            if job_id in _MATCH_JOBS:
                _MATCH_JOBS[job_id].update({"status": "error", "result": None, "error": str(exc)})


def _backend_path() -> None:
    backend_path = str(_NOVASEARCH_BACKEND)
    if backend_path not in sys.path:
        sys.path.append(backend_path)


def _extract_from_text(raw_text: str) -> dict[str, Any]:
    _backend_path()
    from api.extract import _extract_fallback, _extract_with_llm, clean_extracted_result  # type: ignore

    try:
        result = _extract_with_llm(raw_text)
    except Exception:
        result = _extract_fallback(raw_text)
    if not (result.get("location") or "").strip():
        try:
            from lib.geo import resolve_city  # type: ignore
            city = resolve_city(raw_text)
            if city:
                result["location"] = city["name"]
        except Exception:
            pass
    return clean_extracted_result(result, raw_text)


async def _read_json_body(request: Request) -> dict[str, Any]:
    body = await request.body()
    if len(body) > 50000:
        raise HTTPException(status_code=413, detail="Payload too large")
    if not body:
        raise HTTPException(status_code=400, detail="Request body is required")
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    return parsed


def _mcp_dispatch(
    *,
    rpc: dict[str, Any],
    workspace_id: str,
    user_id: str,
    request_id: str | None,
) -> dict[str, Any]:
    rpc_id = rpc.get("id")
    method = rpc.get("method", "")
    params = rpc.get("params") or {}
    if not isinstance(params, dict):
        return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32602, "message": "Invalid params: params must be an object"}}
    try:
        if method == "initialize":
            result = _mcp_initialize(params)
        elif method == "notifications/initialized":
            result = {}
        elif method == "tools/list":
            result = {"tools": _mcp_tool_definitions()}
        elif method in {"resources/list", "resourceTemplates/list", "prompts/list"}:
            key = {"resources/list": "resources", "resourceTemplates/list": "resourceTemplates", "prompts/list": "prompts"}[method]
            result = {key: []}
        elif method == "tools/call":
            name = params.get("name", "")
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                result = _tool_error("Invalid arguments: arguments must be an object.")
            elif name in {"find_sap_candidates", "find_candidates"}:
                result = _mcp_find_sap_candidates(
                    workspace_id=workspace_id,
                    user_id=user_id,
                    arguments=arguments,
                    request_id=request_id,
                )
            elif name == "send_outreach":
                result = _tool_ok(_queue_outreach(workspace_id, user_id, arguments))
            elif name == "get_outreach_status":
                result = _tool_ok(_outreach_status(workspace_id, arguments.get("mandate")))
            elif name == "track_candidates":
                result = _tool_ok(_track_candidates(workspace_id, user_id, arguments))
            elif name == "update_candidate":
                updated = _update_candidate(workspace_id, arguments)
                result = _tool_ok(updated) if updated.get("updated") else _tool_error(updated.get("error", "Update fehlgeschlagen."))
            elif name == "get_tracked_candidates":
                result = _tool_ok(_tracked_candidates(workspace_id, arguments.get("mandate"), arguments.get("status")))
            elif name == "remember":
                remembered = _remember(workspace_id, user_id, arguments)
                result = _tool_ok(remembered) if remembered.get("stored") else _tool_error(remembered.get("error", "Speichern fehlgeschlagen."))
            elif name == "recall":
                result = _tool_ok(_recall(workspace_id, arguments.get("scope")))
            elif name == "get_daily_briefing":
                result = _tool_ok(_daily_briefing(workspace_id))
            elif name == "report_issue":
                reported = _report_issue(workspace_id, user_id, arguments)
                result = _tool_ok(reported) if reported.get("reported") else _tool_error(reported.get("error", "Issue report fehlgeschlagen."))
            else:
                result = _tool_error(f"Unknown tool: {name}")
        else:
            return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": f"Method not found: {method}"}}
    except Exception as exc:
        return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32603, "message": f"Internal error: {type(exc).__name__}"}}
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


@router.post("/mcp")
async def novasearch_mcp(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    rpc = await _read_json_body(request)
    workspace_id = _require_workspace_id()
    return _mcp_dispatch(
        rpc=rpc,
        workspace_id=workspace_id,
        user_id=auth.user_id,
        request_id=getattr(request.state, "request_id", None),
    )


@router.get("/state/counts")
async def novasearch_state_counts(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    workspace_id = _require_workspace_id()
    client = new_supabase_service_client()
    tables = [
        "novasearch_match_queries",
        "novasearch_match_labels",
        "novasearch_tracked_candidates",
        "novasearch_outreach",
        "novasearch_memory",
        "novasearch_judge_cache",
        "novasearch_session_events",
        "novasearch_issue_reports",
    ]
    counts: dict[str, int] = {}
    for table in tables:
        counts[table] = (
            client.table(table)
            .select("workspace_id", count="exact")
            .eq("workspace_id", workspace_id)
            .limit(1)
            .execute()
            .count
            or 0
        )
    return {"workspace_id": workspace_id, "counts": counts}


@router.post("/match/start")
async def match_candidates_start(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    req = await _read_json_body(request)
    workspace_id = _require_workspace_id()
    data_pack = _workspace_data_pack(workspace_id)
    modules = _load_matcher()
    valid, sanitized, error = modules["validate_request"](req)
    if not valid:
        raise HTTPException(status_code=400, detail=error)
    _evict_old_jobs()
    job_id = uuid.uuid4().hex
    with _MATCH_JOBS_LOCK:
        _MATCH_JOBS[job_id] = {"status": "running", "created_at": time.time(), "result": None, "error": None}
    thread = threading.Thread(
        target=_run_background_match_job,
        kwargs={
            "job_id": job_id,
            "workspace_id": workspace_id,
            "user_id": auth.user_id,
            "data_pack": data_pack,
            "sanitized": sanitized,
            "request_id": getattr(request.state, "request_id", None),
        },
        daemon=True,
        name=f"workeros-novasearch-match-{job_id[:8]}",
    )
    thread.start()
    return {"job_id": job_id, "status": "queued"}


@router.get("/match/result/{job_id}")
async def match_candidates_result(
    job_id: str,
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    _evict_old_jobs()
    with _MATCH_JOBS_LOCK:
        entry = _MATCH_JOBS.get(job_id)
        if entry is None:
            raise HTTPException(status_code=404, detail="Job not found or expired")
        snapshot = {"status": entry["status"], "result": entry.get("result"), "error": entry.get("error")}
    if snapshot["status"] == "running":
        return {"status": "running"}
    if snapshot["status"] == "error":
        return {"status": "error", "error": snapshot["error"] or "Candidate matching failed"}
    return {"status": "done", "result": snapshot["result"]}


@router.post("/extract")
async def novasearch_extract(
    request: Request,
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    req = await _read_json_body(request)
    raw_text = str(req.get("raw_text") or req.get("text") or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="Field 'raw_text' or 'text' is required")
    return _extract_from_text(raw_text)


@router.post("/extract-pdf")
async def novasearch_extract_pdf(
    _auth: AuthContext = Depends(get_auth_context),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    _backend_path()
    from api.extract_pdf import MAX_PDF_BYTES, SCANNED_ERROR, _extract_pdf_text  # type: ignore

    pdf_bytes = await file.read()
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="File too large. Maximum PDF size is 5 MB.")
    filename = file.filename or ""
    content_type = (file.content_type or "").lower()
    is_pdf_type = content_type == "application/pdf" or filename.lower().endswith(".pdf")
    if not is_pdf_type or not pdf_bytes.startswith(b"%PDF"):
        raise HTTPException(status_code=415, detail="Only PDF files are supported.")
    try:
        raw_text = _extract_pdf_text(pdf_bytes)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read PDF: {exc}")
    if not raw_text:
        raise HTTPException(status_code=422, detail=SCANNED_ERROR)
    return _extract_from_text(raw_text)


@router.post("/refine")
async def novasearch_refine(
    request: Request,
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    _backend_path()
    from api.refine import _clean_refinement, _keyword_refine, _llm_refine, _normalise_spec  # type: ignore

    req = await _read_json_body(request)
    current_spec, error = _normalise_spec(req.get("current_spec"))
    if not current_spec:
        raise HTTPException(status_code=400, detail=f"Invalid current_spec: {error}")
    message = str(req.get("message") or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Field 'message' is required")
    raw = _keyword_refine(current_spec, message)
    if raw is None:
        try:
            raw = _llm_refine(current_spec, message)
        except Exception:
            raw = {
                "intent": "answer",
                "updated_spec": None,
                "candidate_query": None,
                "agent_reply": "Ich habe das als Kommentar verstanden. Formuliere die Anpassung z. B. als 'nur Festanstellung', 'nur Hamburg' oder 'mehr Seniorität'.",
            }
    return _clean_refinement(raw, current_spec)


@router.get("/metrics")
async def novasearch_metrics(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    workspace_id = _require_workspace_id()
    counts = (await novasearch_state_counts(_auth))["counts"]
    return {
        "total_matches": counts["novasearch_match_queries"],
        "review_labels_written": counts["novasearch_match_labels"],
        "tracked_candidates": counts["novasearch_tracked_candidates"],
        "outreach_rows": counts["novasearch_outreach"],
        "memory_rows": counts["novasearch_memory"],
        "issue_reports": counts["novasearch_issue_reports"],
        "workspace_id": workspace_id,
    }


@router.get("/loxo/health")
async def novasearch_loxo_health(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    _backend_path()
    from lib.loxo import health_check  # type: ignore
    return health_check()


@router.get("/review/{query_id}", response_class=HTMLResponse)
async def novasearch_review(query_id: str) -> HTMLResponse:
    if not _REVIEW_ID_RE.fullmatch(query_id or ""):
        return HTMLResponse("<!doctype html><title>Not found</title><h1>Review link not found</h1>", status_code=404)
    query = _query_row_by_id(query_id)
    if not query:
        return HTMLResponse("<!doctype html><title>Not found</title><h1>Review link not found</h1>", status_code=404)
    labels = (
        new_supabase_service_client()
        .table("novasearch_match_labels")
        .select("candidate_key,worth_contact,reason")
        .eq("workspace_id", query["workspace_id"])
        .eq("query_id", query_id)
        .execute()
        .data
        or []
    )
    by_key = {row["candidate_key"]: row for row in labels}
    rows = []
    for item in query.get("top_json") or []:
        key = item.get("candidate_key") or ""
        label = by_key.get(key) or {}
        rows.append(
            "<tr>"
            f"<td>{_html_cell(item.get('rank'))}</td>"
            f"<td>{_html_cell(item.get('name'))}</td>"
            f"<td>{_html_cell(item.get('title'))}</td>"
            f"<td>{_html_cell(item.get('company'))}</td>"
            f"<td>{_html_cell(item.get('score'))}</td>"
            f"<td>{_html_cell(label.get('worth_contact'))}</td>"
            f"<td>{_html_cell(label.get('reason'))}</td>"
            "</tr>"
        )
    page = (
        "<!doctype html><html><head><meta charset='utf-8'><title>Candidate review</title></head>"
        f"<body><h1>{_html_cell(query.get('job_title') or 'Candidate review')}</h1>"
        f"<p>Query {_html_cell(query_id)}</p>"
        "<table border='1' cellpadding='6'><thead><tr><th>Rank</th><th>Name</th><th>Title</th><th>Company</th><th>Score</th><th>Worth contact</th><th>Reason</th></tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></body></html>"
    )
    return HTMLResponse(page)


@router.post("/review/{query_id}/label")
async def novasearch_review_label(query_id: str, request: Request) -> dict[str, Any]:
    if not _REVIEW_ID_RE.fullmatch(query_id or ""):
        raise HTTPException(status_code=404, detail="Review link not found")
    query = _query_row_by_id(query_id)
    if not query:
        raise HTTPException(status_code=404, detail="Review link not found")
    body = await _read_json_body(request)
    candidate_key = str(body.get("candidate_key") or "").strip()
    if not candidate_key:
        raise HTTPException(status_code=400, detail="candidate_key is required")
    payload = {
        "workspace_id": query["workspace_id"],
        "user_id": query["user_id"],
        "query_id": query_id,
        "rank": body.get("rank"),
        "candidate_key": candidate_key,
        "source": body.get("source"),
        "worth_contact": body.get("worth_contact"),
        "reason": body.get("reason"),
        "labeled_at": _now_iso(),
    }
    new_supabase_service_client().table("novasearch_match_labels").upsert(
        payload,
        on_conflict="workspace_id,query_id,candidate_key",
    ).execute()
    return {"ok": True}


@router.post("/match")
async def match_candidates(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    req = await _read_json_body(request)
    workspace_id = _require_workspace_id()
    data_pack = _workspace_data_pack(workspace_id)
    modules = _load_matcher()
    valid, sanitized, error = modules["validate_request"](req)
    if not valid:
        raise HTTPException(status_code=400, detail=error)

    # NovaSearch's imported matcher stores DB paths and candidate cache in module
    # globals. Serialize this compatibility route so concurrent workspaces cannot
    # cross-read each other's Brain-pack SQLite files.
    with _MATCH_LOCK:
        _configure_matcher_for_pack(data_pack)
        result = modules["run_match_sync"](
            sanitized,
            request_id=getattr(request.state, "request_id", None),
        )
    try:
        _record_match_query_supabase(
            workspace_id=workspace_id,
            user_id=auth.user_id,
            sanitized=sanitized,
            result=result,
            modules=modules,
        )
    except Exception:
        pass
    return result


@router.get("/health")
async def novasearch_health(
    _auth: AuthContext = Depends(get_auth_context),
) -> dict[str, Any]:
    data_pack = _workspace_data_pack(_require_workspace_id())
    return {
        "status": "ok",
        "data_pack": _DATA_PACK_NAME,
        "has_candidates_db": (data_pack / "candidates.db").is_file(),
        "has_query_log_db": (data_pack / "query_log.db").is_file(),
    }
