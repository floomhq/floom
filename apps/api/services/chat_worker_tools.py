"""Worker visibility + resolution for the Emily chat tools.

Backs the workers.list_all / get / run tool surface: role-aware visibility
filtering, fuzzy worker-reference resolution, and the runnable-worker lookup.
Extracted verbatim from chat_service.py. Stock-worker sets, db, and worker_access
are imported lazily in-function (verbatim); the one chat_service helper it needs
(_effective_worker_visibility_user_id) is imported lazily too, so there is no
module-load circular import. chat_service re-imports these names.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional


def _tool_workers_list_all(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from chat_service import _effective_worker_visibility_user_id
    from db import get_db as _get_db
    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    include_all_users = bool(args.get("include_all_users"))
    result = []
    with _get_db() as conn:
        # Default to "the user's workers" for Emily's "what workers do I have?"
        # path. Admin-wide listing is explicit so the default never exposes
        # another user's private workers in a personal inventory answer.
        try:
            role_row = conn.execute("SELECT role FROM users WHERE id = ?", (visibility_user_id,)).fetchone()
            is_admin = bool(role_row) and str(role_row["role"]).lower() == "admin"
        except Exception:
            # No users table (single-user OSS without multi-member) -> not admin;
            # the member path below (own + workspace-shared) is the safe default.
            is_admin = False
        base_select = (
            "SELECT w.id, w.name, w.trigger_type, w.enabled, w.owner_id, sv.manifest_json "
            "FROM workers w "
            "LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id "
        )
        if is_admin and include_all_users:
            rows = conn.execute(base_select + "ORDER BY w.name").fetchall()
        else:
            # Mirror _worker_can_view exactly: a member sees their own workers,
            # stock/public workers (always accessible regardless of ownership),
            # plus workspace-visible workers they are an active member of.
            # The workspace_members table may be absent in single-user OSS
            # (no multi-member); check for its existence before using it.
            from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS
            all_stock_ids = list(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS)
            try:
                has_members_table = bool(conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_members' LIMIT 1"
                ).fetchone())
            except Exception:
                has_members_table = False

            if has_members_table:
                # Show own workers and workspace-visible workers where the user
                # is an active workspace member — matching _worker_can_view.
                rows = conn.execute(
                    base_select
                    + "LEFT JOIN workspace_members wm "
                    + "  ON wm.workspace_id = COALESCE(w.workspace_id, 'local-default') "
                    + "  AND wm.user_id = ? AND wm.status = 'active' "
                    + "WHERE w.owner_id = ? "
                    + "OR (COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                    + "    AND wm.user_id IS NOT NULL) "
                    + "ORDER BY w.name",
                    (visibility_user_id, visibility_user_id),
                ).fetchall()
                # Also include stock/public workers not already captured above
                # (e.g. stock worker owned by another user in a workspace the
                # member doesn't belong to — stock workers are always runnable
                # by everyone, matching _worker_can_view's stock-first check).
                if all_stock_ids:
                    seen_ids = {r["id"] for r in rows}
                    missing_stock = [sid for sid in all_stock_ids if sid not in seen_ids]
                    if missing_stock:
                        placeholders = ",".join("?" * len(missing_stock))
                        stock_rows = conn.execute(
                            base_select
                            + f"WHERE w.id IN ({placeholders}) ORDER BY w.name",
                            missing_stock,
                        ).fetchall()
                        rows = list(rows) + stock_rows
            else:
                # Single-user OSS: no workspace_members table.
                # In single-user mode everyone is effectively in every workspace,
                # so workspace-visible workers are accessible to all users —
                # matching _worker_can_view's _shared_filesystem_fallback_allowed
                # path. Show own + workspace-visible + stock workers.
                if all_stock_ids:
                    placeholders = ",".join("?" * len(all_stock_ids))
                    rows = conn.execute(
                        base_select
                        + f"WHERE w.owner_id = ? "
                        + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                        + f"OR w.id IN ({placeholders}) "
                        + "ORDER BY w.name",
                        [visibility_user_id] + all_stock_ids,
                    ).fetchall()
                else:
                    rows = conn.execute(
                        base_select
                        + "WHERE w.owner_id = ? "
                        + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                        + "ORDER BY w.name",
                        (visibility_user_id,),
                    ).fetchall()
    # #841 RCA: every row was returned, so "what workers do I have?" dumped
    # system and example workers into the chat card with no distinction. The
    # flags were already computed but never used to filter. Hidden rows are
    # surfaced as a count (plus include_system=true to opt back in) so Emily
    # can mention they exist without listing them.
    include_system = bool(args.get("include_system"))
    hidden_system = 0
    for row in rows:
        try:
            manifest = json.loads(row["manifest_json"] or "{}") if row["manifest_json"] else {}
        except Exception:
            manifest = {}
        entry = {
            "id": row["id"],
            "name": row["name"],
            "title": manifest.get("title") or row["name"],
            "trigger": row["trigger_type"] or "manual",
            "enabled": bool(row["enabled"]),
            "system_worker": manifest.get("system_worker", False),
            "is_example": manifest.get("is_example", False),
        }
        if (entry["system_worker"] or entry["is_example"]) and not include_system:
            hidden_system += 1
            continue
        result.append(entry)
    out = {"ok": True, "workers": result, "count": len(result)}
    if hidden_system:
        out["hidden_system_count"] = hidden_system
    return out


def _worker_can_view(conn: Any, worker_id: str, user_id: str) -> bool:
    from chat_service import _effective_worker_visibility_user_id
    """Return True if *user_id* may read *worker_id*.

    Mirrors SqliteAssetAccessRepository._compute:
      can_view = is_owner OR (visibility in {workspace, shared} AND user is
      an active workspace member).

    "shared" is accepted as an alias for "workspace" in case a cloud-side
    migration ever writes that value; the canonical OS value is "workspace".

    File-based stock/example workers (PUBLIC_STOCK_WORKER_IDS,
    PROTECTED_STOCK_WORKER_IDS) do NOT have a DB row; they are shared
    read-execute resources accessible to every user.  When no row exists the
    guard therefore falls back to the same logic used by _get_visible_worker in
    main.py: stock workers are always accessible; in single-user / dev mode
    (filesystem-fallback allowed) unowned on-disk workers are accessible; only
    truly unknown IDs are blocked.  This preserves the pre-#750 behaviour for
    owner/stock access while keeping the cross-user private-worker guard intact.

    If the DB schema is not yet initialised (e.g. unit tests that stub the DB
    at a higher level and don't run migrations), the OperationalError is caught
    and the function returns True — the downstream run path will surface any
    real "not found" error using its own resolution logic.
    """
    import sqlite3 as _sqlite3
    # Stock/public workers are always accessible regardless of DB state.
    # Check this first so a DB row with a different owner_id or restrictive
    # visibility on a stock worker never blocks a valid user.
    from main import (
        PUBLIC_STOCK_WORKER_IDS,
        PROTECTED_STOCK_WORKER_IDS,
        _shared_filesystem_fallback_allowed,
    )
    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    if worker_id in PUBLIC_STOCK_WORKER_IDS or worker_id in PROTECTED_STOCK_WORKER_IDS:
        return True
    try:
        row = conn.execute(
            "SELECT owner_id, workspace_id, visibility FROM workers WHERE id = ? LIMIT 1",
            (worker_id,),
        ).fetchone()
    except _sqlite3.OperationalError:
        # DB not initialised or workers table absent — let the run path decide.
        return True
    if row is None:
        # No DB row — worker is either an unregistered filesystem worker or unknown.
        if _shared_filesystem_fallback_allowed():
            # Single-user / dev mode: unowned on-disk workers are always
            # accessible.  The run path itself will return "not found" if the
            # file doesn't actually exist.
            return True
        # Unknown worker ID in a multi-user deployment — block it.
        return False
    if row["owner_id"] == visibility_user_id:
        return True
    # Admins may view every worker, mirroring the role-aware /workers UI and
    # workers__list_all. Without this, an admin who owns no workers could LIST a
    # worker but get "not found" on read/run. Defensive: no users table (single-
    # user OSS) -> not admin.
    try:
        role_row = conn.execute(
            "SELECT role FROM users WHERE id = ? LIMIT 1", (visibility_user_id,)
        ).fetchone()
        if role_row and str(role_row["role"]).lower() == "admin":
            return True
    except Exception:
        pass
    visibility = (row["visibility"] or "private").lower()
    if visibility not in ("workspace", "shared"):
        return False
    # Check active membership in the worker's workspace. Defensive: the
    # workspace_members table is absent in single-user OSS.
    workspace_id = row["workspace_id"] or "local-default"
    try:
        member_row = conn.execute(
            "SELECT 1 FROM workspace_members "
            "WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
            (workspace_id, visibility_user_id),
        ).fetchone()
    except Exception:
        return False
    return member_row is not None


# Filler tokens stripped before comparing worker references (#892). These are
# words a human adds around a worker name ("run THE node smoke test WORKER")
# that carry no identity, so they must not block an otherwise-exact match nor
# create false token-overlap candidates.
_WORKER_FILLER_TOKENS = {"worker", "workers", "the", "a", "an", "run", "my", "agent", "please"}


def _normalize_worker_token(value: str) -> str:
    """Collapse an arbitrary worker reference to a comparison token.

    Lowercase, replace every run of non-alphanumeric chars (spaces, hyphens,
    underscores, punctuation) with a single hyphen, strip leading/trailing
    hyphens. So "Node Smoke Test", "node_smoke_test", "node-smoke-test" all
    normalize to the same token "node-smoke-test". This is the canonical
    comparison key used by the run resolver (#892) — it does NOT do fuzzy /
    prefix matching, only exact-after-normalization equality.
    """
    return re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")


def _worker_match_key(value: str) -> str:
    """Normalized token of *value* with filler words removed (#892).

    "the node smoke test worker" and "node smoke test" both yield
    "node-smoke-test", so a human's natural phrasing matches the worker id
    without the trailing "worker"/leading "the" blocking the equality.
    """
    tokens = [t for t in _normalize_worker_token(value).split("-") if t and t not in _WORKER_FILLER_TOKENS]
    return "-".join(tokens)


def _list_viewable_workers(conn: Any, user_id: str) -> List[Dict[str, str]]:
    from chat_service import _effective_worker_visibility_user_id
    """Return [{id, name}] for every worker *user_id* may run.

    Mirrors _worker_can_view's visibility model (own + workspace-shared +
    stock/public, with admins seeing all) but, unlike _tool_workers_list_all,
    does NOT hide system/example workers — a by-id run of a stock worker must
    still resolve. Used only by the run resolver to build candidate sets, so it
    is intentionally permissive about WHICH workers exist; the run path itself
    re-checks _worker_can_view before firing.
    """
    from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS

    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    try:
        role_row = conn.execute("SELECT role FROM users WHERE id = ?", (visibility_user_id,)).fetchone()
        is_admin = bool(role_row) and str(role_row["role"]).lower() == "admin"
    except Exception:
        is_admin = False

    base_select = "SELECT w.id, w.name FROM workers w "
    rows: List[Any] = []
    try:
        if is_admin:
            rows = conn.execute(base_select + "ORDER BY w.name").fetchall()
        else:
            rows = conn.execute(
                base_select
                + "WHERE w.owner_id = ? "
                + "OR COALESCE(w.visibility, 'private') IN ('workspace', 'shared', 'public') "
                + "ORDER BY w.name",
                (visibility_user_id,),
            ).fetchall()
    except Exception:
        rows = []

    seen: set[str] = set()
    out: List[Dict[str, str]] = []
    for r in rows:
        wid = str(r["id"])
        if wid in seen:
            continue
        seen.add(wid)
        out.append({"id": wid, "name": str(r["name"] or wid)})

    # Stock/public workers are runnable by everyone even without a DB row.
    for sid in sorted(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS):
        if sid not in seen:
            seen.add(sid)
            out.append({"id": sid, "name": sid})
    return out


def _resolve_runnable_worker(conn: Any, raw_ref: str, user_id: str) -> Dict[str, Any]:
    """Map a natural-language worker reference to a single worker id, SAFELY.

    #892: "run the node smoke test worker" must resolve to `node-smoke-test`
    (or ask), and must NEVER silently fire a different worker (e.g. the live
    proof run fuzzy-matched it to `approval-smoke-e2e` and fired it). The fix:
    only return a worker when the match is HIGH-CONFIDENCE and UNAMBIGUOUS:

      - exact id match, OR
      - exact name match (case-insensitive), OR
      - exactly one worker whose normalized id/name equals the normalized ref.

    On low confidence or ambiguity, return ``{"ok": False, "ambiguous": True,
    "candidates": [...]}`` listing the closest worker ids so the model can ask
    the user which one — it does NOT pick one. The caller must NOT run on an
    ambiguous result.

    Returns ``{"ok": True, "worker_id": <id>}`` on a confident match, or
    ``{"ok": False, ...}`` otherwise.
    """
    from services.worker_access import _canonical_worker_id

    ref = (raw_ref or "").strip()
    if not ref:
        return {"ok": False, "error": "id is required"}

    workers = _list_viewable_workers(conn, user_id)
    by_id = {w["id"]: w for w in workers}

    # 1. Exact id match — the model passed a real worker id verbatim, or the
    #    canonical slug of the ref IS an existing viewable worker id. This is an
    #    EXACT id path only (_canonical_worker_id is a deterministic slugify, not
    #    a fuzzy match), so it can never misroute "node smoke test" to an
    #    unrelated worker. We require the slug to be a REAL enumerated worker
    #    (``in by_id``); we do NOT trust _worker_can_view's dev-mode filesystem
    #    permissiveness here, because that would happily accept a non-existent
    #    slug like "node-smoke-test-worker" and bypass the safe name match below.
    canonical = _canonical_worker_id(ref)
    if ref in by_id:
        return {"ok": True, "worker_id": ref}
    if canonical and canonical in by_id:
        return {"ok": True, "worker_id": canonical}

    # 2. Exact name match (case-insensitive, unambiguous).
    ref_lower = ref.lower()
    name_hits = [w for w in workers if w["name"].lower() == ref_lower]
    if len(name_hits) == 1:
        return {"ok": True, "worker_id": name_hits[0]["id"]}

    # 3. Filler-stripped normalized equality against id OR name (handles "the
    #    node smoke test worker" -> node-smoke-test, "Weekly Update" ->
    #    weekly_update, etc.). Exact-after-normalization only — never a prefix or
    #    substring guess — so it stays high-confidence.
    match_ref = _worker_match_key(ref)
    if match_ref:
        norm_hits: List[Dict[str, str]] = []
        norm_seen: set[str] = set()
        for w in workers:
            if w["id"] in norm_seen:
                continue
            if (
                _worker_match_key(w["id"]) == match_ref
                or _worker_match_key(w["name"]) == match_ref
            ):
                norm_hits.append(w)
                norm_seen.add(w["id"])
        if len(norm_hits) == 1:
            return {"ok": True, "worker_id": norm_hits[0]["id"]}
        if len(norm_hits) > 1:
            return {
                "ok": False,
                "ambiguous": True,
                "error": (
                    f"{len(norm_hits)} workers match {ref!r}. Ask the user which "
                    "one to run; do NOT run any until they confirm."
                ),
                "candidates": [{"id": w["id"], "name": w["name"]} for w in norm_hits],
            }

    # 3b. Exact-id fallback for a viewable worker not in the enumeration window
    #     (e.g. a fresh on-disk worker in dev/single-user mode). Reached ONLY
    #     after every name/normalized match above has failed, so it can never
    #     shadow a safe name match — the #892 misroute lived in the name path,
    #     not here. This preserves the pre-#892 ability to run a worker by its
    #     exact canonical id.
    if canonical and canonical not in by_id and _worker_can_view(conn, canonical, user_id):
        return {"ok": True, "worker_id": canonical}

    # 4. No confident match → offer the closest candidates by shared normalized
    #    tokens, but DO NOT run. Rank by token overlap so the suggestions are
    #    relevant ("node smoke test" surfaces node-smoke-test even when an
    #    unrelated approval-smoke worker also contains "smoke"). Generic filler
    #    tokens ("worker", "the", "run") are ignored so a bare "ghost-worker"
    #    doesn't false-match every worker via the ubiquitous "worker" token.
    ref_tokens = set(t for t in match_ref.split("-") if t)
    scored: List[tuple[int, Dict[str, str]]] = []
    for w in workers:
        w_tokens = set(
            t for t in (
                _worker_match_key(w["id"]).split("-")
                + _worker_match_key(w["name"]).split("-")
            ) if t
        )
        overlap = len(ref_tokens & w_tokens)
        if overlap:
            scored.append((overlap, w))
    scored.sort(key=lambda x: (-x[0], x[1]["id"]))
    candidates = [{"id": w["id"], "name": w["name"]} for _, w in scored[:5]]
    if not candidates:
        # Truly unknown reference (no viewable worker shares any token). Preserve
        # the pre-#892 "not found" contract — the model must surface a clean
        # not-found, never narrate a started/finished run (#877). No success
        # fields, no candidates to guess from.
        return {"ok": False, "error": f"Worker not found: {ref}"}
    return {
        "ok": False,
        "ambiguous": True,
        "error": (
            f"No worker clearly matches {ref!r}. Ask the user to confirm which of "
            "these they mean (use the exact id); do NOT run any worker until they "
            "confirm."
        ),
        "candidates": candidates,
    }


def _tool_workers_get(args: Dict[str, Any], user_id: str) -> Dict[str, Any]:
    from db import get_db as _get_db
    worker_id = str(args.get("id") or "")
    if not worker_id:
        return {"ok": False, "error": "id is required"}
    from services.worker_access import _canonical_worker_id
    worker_id = _canonical_worker_id(worker_id)
    with _get_db() as conn:
        # Security: enforce ownership/visibility before fetching full details.
        if not _worker_can_view(conn, worker_id, user_id):
            return {"ok": False, "error": f"Worker not found: {worker_id}"}
        row = conn.execute(
            """
            SELECT w.id, w.name, w.trigger_type, w.enabled, w.cron_expr,
                   sv.manifest_json
            FROM workers w
            LEFT JOIN skill_versions sv ON sv.id = w.skill_version_id
            WHERE w.id = ?
            """,
            (worker_id,),
        ).fetchone()
    if not row:
        return {"ok": False, "error": f"Worker not found: {worker_id}"}
    try:
        manifest = json.loads(row["manifest_json"] or "{}") if row["manifest_json"] else {}
    except Exception:
        manifest = {}
    return {
        "ok": True,
        "worker": {
            "id": row["id"],
            "name": row["name"],
            "trigger": row["trigger_type"] or "manual",
            "cron": row["cron_expr"],
            "enabled": bool(row["enabled"]),
            "manifest": manifest,
        },
    }


