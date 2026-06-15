"""Workspace-agent tool implementations: workers, runs, secrets, connections,
MCP-tools, and contexts.

Extracted verbatim from chat_service.py: the agent action handlers behind the
``workers__*`` / ``runs__*`` / ``secrets__*`` / ``connections__*`` /
``mcp_tools__*`` / ``contexts__*`` tools registered by _workspace_tools.
chat_service re-imports these names for backward compatibility. Backend deps
(main, db, run_service, worker_registry, contexts, scanners) are lazy-imported
inside each handler; the per-request conversation ContextVar is lazy-imported
from chat_service.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("floom.chat")


# ---------------------------------------------------------------------------
# Authz helpers
# ---------------------------------------------------------------------------

def _caller_is_workspace_admin(user_id: str) -> bool:
    """Return True if *user_id* is an admin/owner in the active workspace.

    #238: mirrors the HTTP route's ``auth.is_admin`` for Emily's mutation
    tools, backend-agnostically:

    - Cloud: the per-request role is stashed in the workspace-context
      contextvar by SupabaseAuthProvider.verify; read it via a soft import so
      the OSS engine never hard-depends on the cloud package.
    - OSS SQLite: fall back to the ``users`` table ``role`` column (the same
      source ``_worker_can_view`` uses for its admin check).

    Defaults to False (least privilege) when the role cannot be resolved.
    """
    # Cloud: per-request active member role.
    try:
        from apps.api.auth.workspace_context import get_active_member_role
        role = get_active_member_role()
        if role is not None:
            return str(role).lower() == "admin"
    except Exception:
        pass
    # OSS SQLite: users-table role lookup (matches _worker_can_view).
    try:
        from chat_service import _effective_worker_visibility_user_id
        from db import get_db

        effective_id = _effective_worker_visibility_user_id(user_id)
        with get_db() as conn:
            row = conn.execute(
                "SELECT role FROM users WHERE id = ? LIMIT 1", (effective_id,)
            ).fetchone()
        return bool(row) and str(row["role"]).lower() == "admin"
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------

def _tool_workers_create_from_prompt(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from chat_service import _current_chat_conversation_id, _idempotent_worker_author_run
    prompt = str(args.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}
    if len(prompt) > 4000:
        return {"ok": False, "error": "prompt must be 4000 characters or fewer"}
    mode = str(args.get("mode") or "create").strip()
    if mode not in {"draft", "create"}:
        return {"ok": False, "error": "mode must be 'draft' or 'create'"}
    conversation_id = _current_chat_conversation_id.get()
    if not conversation_id:
        return {"ok": False, "error": "conversation context unavailable"}
    return _idempotent_worker_author_run(
        user_id=user_id,
        conversation_id=conversation_id,
        idempotency_key=str(args.get("idempotency_key") or ""),
        prompt=prompt,
        mode=mode,
    )


def _tool_workers_create(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Create a RUNNABLE worker from a worker.yml manifest — same path as the API.

    Two things must happen for an Emily-created worker to actually RUN to
    completion, and the old implementation did neither:

    1. MATERIALIZE THE BUNDLE ON DISK. The old code only wrote the workers +
       skill_versions DB rows. A worker that exists only in the DB has no bundle
       on disk, so at run time the E2B runner failed with "worker directory not
       found" (run_service._snapshot_worker_bundle / e2b_driver). This now routes
       through the SAME shared helper the HTTP/MCP create paths use
       (``main._register_worker_from_files``), which writes worker.yml, backfills
       run.py + requirements.txt, invalidates the cache, re-discovers, and
       persists the worker.

    2. GENERATE REAL run.py CODE. Emily authors a *manifest* (yaml only, no code),
       so the backfilled run.py is a no-op placeholder. A worker whose manifest
       declares an output but whose run.py produces nothing fails at run time with
       "Output schema violation". So, exactly like ``/workers/draft-and-create``
       Path B, this runs ``smoke_and_gate_generated_worker`` with
       ``allow_code_repair=True``: it detects the placeholder stub, synthesises a
       real run.py from the manifest via the codegen model, smokes it in E2B, and
       gates the worker (a smoke-failed worker is DISABLED, never deleted, and the
       verdict is surfaced to Emily). This is the proven create path — Emily's
       tool is no longer a weaker parallel implementation of it.
    """
    import yaml as _yaml
    from chat_service import (
        _canonicalize_emily_exec_command,
        _emily_worker_result_message,
        _smoke_gate_emily_worker,
    )
    yaml_text = str(args.get("yaml_text") or "")
    if not yaml_text:
        return {"ok": False, "error": "yaml_text is required"}
    # Single execution path: Emily authors a manifest, not code. Strip any
    # caller-supplied exec.command so the generated run.py is the ONLY executed
    # script (a divergent exec.command silently shadows run.py — ISSUES.md #E1).
    yaml_text = _canonicalize_emily_exec_command(yaml_text)
    try:
        manifest = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid YAML: {exc}"}
    if not isinstance(manifest, dict):
        return {"ok": False, "error": "YAML must be a mapping"}
    if not (manifest.get("name") or manifest.get("id")):
        return {"ok": False, "error": "worker name is required in YAML"}

    # #673: validate field values before persisting so Emily gets an immediate,
    # actionable error instead of silently saving a broken worker.
    _VALID_TRIGGER_TYPES = {"manual", "schedule", "webhook", "event"}
    trigger_block = manifest.get("trigger") or {}
    if isinstance(trigger_block, dict):
        trigger_type = trigger_block.get("type") or ""
        if trigger_type and trigger_type not in _VALID_TRIGGER_TYPES:
            return {
                "ok": False,
                "error": (
                    f"Invalid trigger.type '{trigger_type}'. "
                    f"Valid values: {sorted(_VALID_TRIGGER_TYPES)}. "
                    "For a scheduled worker use type: 'schedule' with cron: '*/10 * * * *'. "
                    "Never use 'cron' or 'incoming_email' — they do not exist in WorkerOS."
                ),
            }
    exec_block = manifest.get("exec") or {}
    if isinstance(exec_block, dict):
        runner = exec_block.get("runner") or ""
        if runner and runner != "e2b":
            return {
                "ok": False,
                "error": (
                    f"Invalid exec.runner '{runner}'. "
                    "The only valid runner is 'e2b'. "
                    "The local in-process runner was removed. Set exec.runner: 'e2b'."
                ),
            }

    # Step 1: converge onto the proven materialization path. ``dedupe_id`` rewrites
    # a colliding id to a free one (matches the worker-author hook) so a create
    # never dead-ends on a taken slug.
    from db import get_repositories
    from main import _register_worker_from_files, DraftFile
    from fastapi import HTTPException as _HTTPException

    repos = get_repositories()
    try:
        worker_id = _register_worker_from_files(
            [DraftFile(path="worker.yml", content=yaml_text)],
            user_id=user_id,
            repos=repos,
            dedupe_id=True,
        )
    except _HTTPException as exc:
        return {"ok": False, "error": str(exc.detail)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    # Step 2: generate real run.py + smoke-gate — same as draft-and-create Path B,
    # shared verbatim with workers__update so create and update gate identically.
    # Best-effort: a generation/smoke failure must not undo a successful create
    # (the worker stays editable), but it IS surfaced so Emily can tell the user
    # the worker is not yet runnable instead of presenting a dead worker as ready.
    smoke_status, smoke_reason = _smoke_gate_emily_worker(worker_id, manifest, user_id)
    result = _emily_worker_result_message(worker_id, "created", smoke_status, smoke_reason)
    # #675: include what was *actually* saved so Emily can verify it matches the
    # user's intent without a separate workers.get call. This surfaces silent drops
    # (e.g. connections=[], approvals.required=False) immediately in the tool result.
    exec_block = manifest.get("exec") or {}
    trigger_block = manifest.get("trigger") or {}
    approvals_block = manifest.get("approvals") or {}
    result["saved_config"] = {
        "connections": manifest.get("connections") or [],
        "approvals_required": bool(approvals_block.get("required", False)),
        "trigger_type": (trigger_block.get("type") if isinstance(trigger_block, dict) else trigger_block) or "manual",
        "exec_mode": (exec_block.get("mode") if isinstance(exec_block, dict) else None) or "unknown",
        "runner": (exec_block.get("runner") if isinstance(exec_block, dict) else None) or "unknown",
    }
    return result


def _tool_workers_update(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    """Update a worker's manifest — writes worker.yml to disk, same path as the editor.

    The previous implementation only inserted a new ``skill_versions`` row and
    re-pointed the FK; it never wrote the new worker.yml to the worker's directory.
    The runner reads ``worker.yml``/``run.py`` from ``WORKERS_DIR/<id>/`` on every
    run (run_service), so a DB-only update was silently ignored at run time — the
    same parallel-implementation gap as create. This converges onto the proven
    editor path (``main.update_worker_files``): it writes the new worker.yml to disk,
    preserves the existing run.py and other bundle files, then re-discovers and
    re-persists the worker so the manifest, disk, and DB stay in sync.
    """
    import yaml as _yaml
    from chat_service import (
        _canonicalize_emily_exec_command,
        _emily_worker_result_message,
        _generate_run_py_from_manifest,
        _manifest_executes_run_py,
        _smoke_gate_emily_worker,
    )
    worker_id = str(args.get("id") or "")
    yaml_text = str(args.get("yaml_text") or "")
    if not worker_id or not yaml_text:
        return {"ok": False, "error": "id and yaml_text are required"}
    from services.worker_access import _canonical_worker_id
    worker_id = _canonical_worker_id(worker_id)

    from db import get_db as _get_db
    with _get_db() as conn:
        row = conn.execute(
            "SELECT id FROM workers WHERE id = ? AND owner_id = ?",
            (worker_id, user_id),
        ).fetchone()
        if not row:
            return {"ok": False, "error": f"Worker not found or not owned by you: {worker_id}"}

    # Build the full new bundle: replace worker.yml, carry over every existing file
    # (run.py, SKILL.md, lib/*, ...) so the editor path does not delete them. The
    # editor endpoint removes any on-disk file absent from the payload, so we must
    # resend the rest verbatim.
    from main import (
        update_worker_files,
        WorkerFilesUpdateRequest,
        WorkerFilePatch,
        AuthContext,
        _read_worker_files,
        _DEFAULT_RUN_PY_STUB,
        get_repositories,
    )
    from fastapi import HTTPException as _HTTPException
    from worker_registry import WORKERS_DIR

    worker_dir = WORKERS_DIR / worker_id
    # Read the EXISTING on-disk file set FIRST so the entry-normalisation can
    # preserve a legitimate hand-authored run.js / multi-file Python worker (its
    # source is present) and only redirect an orphaned script entry to run.py.
    existing_files: set = set()
    carried: list = []
    if worker_dir.is_dir():
        for wf in _read_worker_files(worker_dir):
            if wf.path == "worker.yml" or wf.binary or wf.content is None:
                continue
            carried.append(wf)
            existing_files.add(wf.path)

    # Single execution path (ISSUES.md #E1): strip a divergent exec.command and
    # redirect an ORPHANED non-run.py script entry (run.sh/run.js with no source)
    # to the generated run.py — but never clobber a real authored entry file.
    yaml_text = _canonicalize_emily_exec_command(yaml_text, existing_files=existing_files)
    try:
        manifest = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return {"ok": False, "error": f"Invalid YAML: {exc}"}
    if not isinstance(manifest, dict):
        return {"ok": False, "error": "YAML must be a mapping"}

    files: list = [WorkerFilePatch(path="worker.yml", content=yaml_text)]
    seen = {"worker.yml"}
    for wf in carried:
        if wf.path in seen:
            continue
        files.append(WorkerFilePatch(path=wf.path, content=wf.content))
        seen.add(wf.path)
    if "run.py" not in seen and _manifest_executes_run_py(manifest):
        # Legacy run.py worker materialized without a run.py: backfill the runnable
        # stub so the update yields a runnable bundle. Only for workers that
        # EXECUTE run.py — a run.js / SKILL.md worker must not get an unused run.py
        # stub (the placeholder-marker smoke preflight would then disable a good
        # worker — Codex P1).
        files.append(WorkerFilePatch(path="run.py", content=_DEFAULT_RUN_PY_STUB))

    auth = AuthContext(user_id=user_id)
    try:
        update_worker_files(
            worker_id,
            WorkerFilesUpdateRequest(files=files),
            auth=auth,
            repos=get_repositories(),
        )
    except _HTTPException as exc:
        return {"ok": False, "error": str(exc.detail)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    if _manifest_executes_run_py(manifest):
        def _update_codegen_log(msg: str, level: str = "info") -> None:
            logger.info("emily worker update codegen %s: %s", worker_id, msg)

        _generate_run_py_from_manifest(
            worker_id,
            manifest,
            user_id,
            _update_codegen_log,
            force=True,
        )

    # Gate == runtime (ISSUES.md #E1): an update that would break every real run
    # must NOT be persisted as a silent success. Run the SAME smoke gate create
    # uses — it validates via the real driver.run + _validate_run_outputs path,
    # so a `passed` verdict means real runs pass and a `failed` verdict DISABLES
    # the worker (kept editable) and is surfaced. This closes the gap where the
    # update path wrote a manifest with zero validation.
    smoke_status, smoke_reason = _smoke_gate_emily_worker(worker_id, manifest, user_id)
    return _emily_worker_result_message(worker_id, "updated", smoke_status, smoke_reason)


def _tool_workers_run(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from chat_service import _resolve_runnable_worker, _worker_can_view
    raw_ref = str(args.get("id") or "")
    if not raw_ref:
        return {"ok": False, "error": "id is required"}
    inputs_json = args.get("inputs_json") or "{}"
    try:
        inputs = json.loads(inputs_json) if isinstance(inputs_json, str) else dict(inputs_json or {})
    except json.JSONDecodeError as exc:
        return {"ok": False, "error": f"Invalid inputs_json: {exc}"}

    # #892: resolve the natural-language reference to a worker id SAFELY. The
    # previous behaviour slugified the ref and ran whatever id came out, letting
    # "run the node smoke test worker" silently fire the WRONG worker (proof run
    # hit approval-smoke-e2e instead of node-smoke-test). _resolve_runnable_worker
    # only returns a worker on a HIGH-CONFIDENCE, UNAMBIGUOUS match; on ambiguity
    # it returns candidate ids for the model to confirm — it NEVER auto-picks.
    from db import get_db as _get_db
    with _get_db() as conn:
        resolution = _resolve_runnable_worker(conn, raw_ref, user_id)
        if not resolution.get("ok"):
            return resolution
        worker_id = str(resolution["worker_id"])
        # Security (#748): actor must own the worker or it must be workspace-
        # visible and the actor an active workspace member.
        if not _worker_can_view(conn, worker_id, user_id):
            return {"ok": False, "error": f"Worker not found: {worker_id}"}

    # #627: validate required inputs BEFORE firing the run (was: create_run ran
    # first and the run failed at execution time). Load the declared input schema
    # and return a structured error listing missing fields so Emily can ask the
    # user for them before retrying.
    from run_service import get_worker_config_for_run
    run_config = get_worker_config_for_run(worker_id)
    if run_config is not None:
        declared_inputs = getattr(run_config, "inputs", []) or []
        missing = [
            inp for inp in declared_inputs
            if getattr(inp, "required", False)
            and (inp.name not in inputs or inputs.get(inp.name) in (None, ""))
        ]
        if missing:
            # Include the label/description so Emily can phrase the follow-up
            # question intelligently rather than echoing a raw field name.
            details = [
                f"{inp.name!r} ({inp.label or inp.description or inp.name})"
                for inp in missing
            ]
            return {
                "ok": False,
                "error": f"Missing required inputs: {', '.join(details)}. "
                         "Ask the user to provide them, then retry.",
                "missing_inputs": [inp.name for inp in missing],
            }

    from run_service import create_run, start_run
    from db import get_repositories
    try:
        repos = get_repositories()
        run_id = create_run(
            worker_id,
            inputs,
            trigger_source="workspace-agent",
            user_id=user_id,
            repos=repos,
        )
        start_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
        # The run is enqueued, not finished. Report only the real run_id and its
        # current status ("queued"); the model must NOT narrate an output yet.
        # On success we return {ok, run_id, status} and nothing that looks like a
        # completed result. (#877)
        return {
            "ok": True,
            "run_id": run_id,
            "status": "queued",
            "message": (
                f"Run '{run_id}' was queued for worker '{worker_id}'. "
                "It has not finished; do not report any output until it completes."
            ),
        }
    except Exception as exc:
        # Failure: return only ok:false + error. No run_id, no status, no
        # message, nothing the model could misread as a started/finished run.
        return {"ok": False, "error": str(exc)}


def _tool_runs_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    worker_id = args.get("worker_id")
    status = args.get("status")
    limit = min(int(args.get("limit") or 20), 100)
    where = ["w.owner_id = ?"]
    params: list = [user_id]
    if worker_id:
        where.append("r.worker_id = ?")
        params.append(worker_id)
    if status:
        where.append("r.status = ?")
        params.append(status)
    where_sql = " AND ".join(where)
    with _get_db() as conn:
        rows = conn.execute(
            f"""
            SELECT r.id, r.worker_id, w.name AS worker_name,
                   r.status, r.created_at, r.completed_at, r.error, r.duration_ms
            FROM runs r
            JOIN workers w ON w.id = r.worker_id
            WHERE {where_sql}
            ORDER BY r.created_at DESC
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "worker_id": r["worker_id"],
            "worker_name": r["worker_name"],
            "status": r["status"],
            "created_at": r["created_at"],
            "completed_at": r["completed_at"],
            "duration_ms": r["duration_ms"],
            "error": r["error"],
        })
    return {"ok": True, "runs": result, "count": len(result)}


def _tool_runs_get(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    run_id = str(args.get("run_id") or "")
    if not run_id:
        return {"ok": False, "error": "run_id is required"}
    repos = get_repositories()
    run = repos.runs.get(user_id=user_id, run_id=run_id)
    if not run:
        return {"ok": False, "error": f"Run not found: {run_id}"}
    r = dict(run)
    # Parse output_json safely
    if r.get("output_json"):
        try:
            r["outputs"] = json.loads(r["output_json"])
        except Exception:
            r["outputs"] = {}
    return {"ok": True, "run": r}


def _tool_runs_cancel(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    run_id = str(args.get("run_id") or "")
    if not run_id:
        return {"ok": False, "error": "run_id is required"}
    try:
        with _get_db() as conn:
            conn.execute(
                "UPDATE runs SET cancel_requested = 1 WHERE id = ?",
                (run_id,),
            )
        return {"ok": True, "message": f"Cancel requested for run '{run_id}'."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_secrets_list_names(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    rows = repos.secrets.list(user_id=user_id)
    secrets = []
    for row in rows:
        item = dict(row)
        secrets.append({
            "name": item.get("name"),
            "status": item.get("status") or ("set" if item.get("value") else "missing"),
            "last_used_at": item.get("last_used_at"),
            "last_checked_at": item.get("last_checked_at"),
            "last_check_status": item.get("last_check_status"),
        })
    return {
        "ok": True,
        "names": sorted(s["name"] for s in secrets if s.get("name")),
        "secrets": sorted(secrets, key=lambda s: str(s.get("name") or "")),
    }


def _tool_secrets_set(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    value = str(args.get("value") or "")
    if not name:
        return {"ok": False, "error": "name is required"}
    import re as _re
    if not _re.fullmatch(r"[A-Z_][A-Z0-9_]*", name.upper()):
        return {"ok": False, "error": "Secret name must be alphanumeric with underscores"}
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return {"ok": False, "error": "Secret value must not contain newline or control characters"}
    env_key = name.upper()
    from db import get_repositories
    repos = get_repositories()
    # #238: apply the SAME per-action authz the HTTP route enforces
    # (_require_secret_mutation_allowed, #952). Without this, a low-priv member
    # could overwrite another user's / the owner's workspace secret through
    # Emily — an action the direct API blocks. The cloud SupabaseSecretRepository
    # upserts by (workspace_id, name) only, so we MUST gate on the existing
    # secret's creator here. On OSS SQLite, secrets are per-user so get() never
    # surfaces another user's row and this is a no-op.
    existing = repos.secrets.get(user_id=user_id, name=env_key)
    if existing is not None and not _caller_is_workspace_admin(user_id):
        creator = str(existing.get("user_id") or "")
        if creator and creator != str(user_id):
            return {
                "ok": False,
                "error": (
                    f"only an admin or the creator can modify secret '{env_key}'"
                ),
            }
    repos.secrets.set(user_id=user_id, name=env_key, value=value, status="set")
    return {"ok": True, "message": f"Secret '{env_key}' set."}


def _tool_connections_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    connections = repos.connections.list(user_id=user_id)
    result = []
    for c in connections:
        raw_scopes = c.get("scopes_json")
        try:
            scopes = json.loads(raw_scopes or "[]")
        except Exception:
            scopes = []
        if not isinstance(scopes, list):
            scopes = []
        raw_allowed_tools = c.get("mcp_allowed_tools_json")
        try:
            allowed_tools = json.loads(raw_allowed_tools or "[]")
        except Exception:
            allowed_tools = []
        if not isinstance(allowed_tools, list):
            allowed_tools = []
        account_label = c.get("display_name") or c.get("account_label")
        result.append({
            "id": c.get("id"),
            "kind": c.get("kind") or "composio",
            "app_name": c.get("app_name"),
            "status": c.get("status"),
            "account_label": account_label,
            "display_name": account_label,
            "scopes": [scope for scope in scopes if isinstance(scope, str)],
            "last_checked_at": c.get("last_checked_at"),
            "last_check_status": c.get("last_check_status"),
            "mcp_label": c.get("mcp_label"),
            "mcp_url": c.get("mcp_url"),
            "mcp_auth_secret": c.get("mcp_auth_secret"),
            "mcp_allowed_tools": [tool for tool in allowed_tools if isinstance(tool, str)],
        })
    return {"ok": True, "connections": result, "count": len(result)}


def _tool_connections_add_mcp(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    label = str(args.get("label") or "")
    url = str(args.get("url") or "")
    auth_secret = args.get("auth_secret")
    allowed_tools = args.get("allowed_tools")
    if not label or not url:
        return {"ok": False, "error": "label and url are required"}
    from db import get_db as _get_db, now_iso as _now_iso
    import uuid as _uuid
    conn_id = f"mcp_{_uuid.uuid4().hex[:12]}"
    ts = _now_iso()
    try:
        with _get_db() as conn:
            conn.execute(
                """
                INSERT INTO composio_connections
                    (id, app_name, composio_connection_id, kind, status,
                     mcp_label, mcp_url, mcp_auth_secret, mcp_allowed_tools_json,
                     user_id, created_at, updated_at)
                VALUES (?, ?, ?, 'mcp', 'active', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    conn_id, label, conn_id, label, url,
                    auth_secret,
                    json.dumps(allowed_tools) if allowed_tools else None,
                    user_id, ts, ts,
                ),
            )
        return {"ok": True, "connection_id": conn_id, "message": f"MCP connection '{label}' added."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _mcp_tool_input_schema_from_worker(worker: Dict[str, Any]) -> Dict[str, Any]:
    config = worker.get("config") or {}
    inputs = config.get("inputs") if isinstance(config, dict) else []
    if not isinstance(inputs, list):
        return {"type": "object", "properties": {}}
    properties: Dict[str, Any] = {}
    required: List[str] = []
    type_map = {
        "string": "string",
        "text": "string",
        "markdown": "string",
        "number": "number",
        "integer": "integer",
        "boolean": "boolean",
        "bool": "boolean",
        "object": "object",
        "json": "object",
        "array": "array",
    }
    for item in inputs:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        raw_type = str(item.get("type") or item.get("kind") or "string").lower()
        schema_type = type_map.get(raw_type, "string")
        prop: Dict[str, Any] = {"type": schema_type}
        if item.get("description"):
            prop["description"] = str(item["description"])
        if isinstance(item.get("options"), list):
            prop["enum"] = [str(option) for option in item["options"]]
        properties[name] = prop
        if item.get("required"):
            required.append(name)
    schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _resolve_mcp_tool_worker(worker_ref: str, user_id: str) -> Dict[str, Any] | None:
    from db import get_repositories
    repos = get_repositories()
    worker = repos.workers.get(user_id=user_id, worker_id=worker_ref)
    if worker:
        return worker
    for candidate in repos.workers.list(user_id=user_id):
        if candidate.get("name") == worker_ref:
            return candidate
    return None


def _tool_mcp_tools_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_repositories
    repos = get_repositories()
    return {"ok": True, "tools": repos.mcp_tools.list(user_id=user_id)}


def _tool_mcp_tools_register(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    description = str(args.get("description") or "").strip()
    worker_ref = str(args.get("worker_id") or "").strip()
    input_schema = args.get("input_schema") or {}
    if not name or not description or not worker_ref:
        return {"ok": False, "error": "name, description, and worker_id are required"}
    from db import get_repositories
    repos = get_repositories()
    if repos.mcp_tools.get_by_name(user_id=user_id, name=name):
        return {"ok": False, "error": f"Tool {name!r} already exists"}
    worker = _resolve_mcp_tool_worker(worker_ref, user_id)
    if not worker:
        return {"ok": False, "error": f"Worker {worker_ref!r} not found"}
    if not isinstance(input_schema, dict) or not input_schema:
        input_schema = _mcp_tool_input_schema_from_worker(worker)
    tool = repos.mcp_tools.create(
        user_id=user_id,
        name=name,
        description=description,
        input_schema=input_schema,
        worker_id=str(worker["id"]),
    )
    return {"ok": True, "tool": tool}


def _tool_mcp_tools_update(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name is required"}
    from db import get_repositories
    repos = get_repositories()
    tool = repos.mcp_tools.get_by_name(user_id=user_id, name=name)
    if not tool:
        return {"ok": False, "error": f"Tool {name!r} not found"}
    updates: Dict[str, Any] = {}
    if args.get("description"):
        updates["description"] = str(args["description"])
    if isinstance(args.get("input_schema"), dict):
        updates["input_schema"] = args["input_schema"]
    if args.get("worker_id"):
        worker_ref = str(args["worker_id"])
        worker = _resolve_mcp_tool_worker(worker_ref, user_id)
        if not worker:
            return {"ok": False, "error": f"Worker {worker_ref!r} not found"}
        updates["worker_id"] = str(worker["id"])
    updated = repos.mcp_tools.update(user_id=user_id, tool_id=str(tool["id"]), **updates)
    return {"ok": True, "tool": updated}


def _tool_mcp_tools_delete(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name is required"}
    from db import get_repositories
    repos = get_repositories()
    tool = repos.mcp_tools.get_by_name(user_id=user_id, name=name)
    if not tool:
        return {"ok": False, "error": f"Tool {name!r} not found"}
    repos.mcp_tools.delete(user_id=user_id, tool_id=str(tool["id"]))
    return {"ok": True, "message": f"Tool {name!r} deleted"}


def _tool_contexts_list(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from contexts import context_scope_for_user, current_contexts_root, iter_context_files, use_context_scope
    result = []
    with use_context_scope(context_scope_for_user(user_id)):
        root = current_contexts_root()
        if root.is_dir():
            for ctx_dir in sorted(root.iterdir()):
                if ctx_dir.is_dir() and not ctx_dir.name.startswith("."):
                    files = list(iter_context_files(ctx_dir))
                    result.append({
                        "name": ctx_dir.name,
                        "file_count": len(files),
                        "files": [str(path.relative_to(ctx_dir)) for path in files[:25]],
                        "truncated": len(files) > 25,
                    })
    return {"ok": True, "contexts": result}


def _tool_contexts_read(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    file_path = str(args.get("file_path") or "")
    if not name or not file_path:
        return {"ok": False, "error": "name and file_path are required"}
    from contexts import context_scope_for_user, safe_context_file_path, use_context_scope
    try:
        with use_context_scope(context_scope_for_user(user_id)):
            full_path = safe_context_file_path(name, file_path)
            if not full_path.is_file():
                return {"ok": False, "error": f"File not found: {file_path}"}
            content = full_path.read_text(errors="replace")
        if not full_path.is_file():
            return {"ok": False, "error": f"File not found: {file_path}"}
        return {"ok": True, "content": content}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _tool_contexts_write(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    name = str(args.get("name") or "")
    file_path = str(args.get("file_path") or "")
    content = str(args.get("content") or "")
    if not name or not file_path:
        return {"ok": False, "error": "name and file_path are required"}
    from contexts import context_scope_for_user, safe_context_file_path, use_context_scope
    try:
        from secret_scan import scan_bytes

        findings = scan_bytes(content.encode("utf-8", errors="replace"))
        if findings:
            patterns = ", ".join(sorted({f.pattern for f in findings}))
            return {
                "ok": False,
                "error": (
                    "Refusing to write likely credential material into a brain pack "
                    f"({patterns}). Store credentials in Secrets instead."
                ),
            }
        with use_context_scope(context_scope_for_user(user_id)):
            full_path = safe_context_file_path(name, file_path)
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding='utf-8')
        return {"ok": True, "message": f"Written {len(content)} chars to {name}/{file_path}."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
