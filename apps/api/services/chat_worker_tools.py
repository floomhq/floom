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
    # #1027: route through the repository Protocol (was a direct get_db() read)
    # so non-SQLite backends (cloud Supabase) supply their own implementation.
    # The visibility logic now lives in WorkerRepository.list_for_agent; stock
    # ids are passed in (caller owns the PUBLIC/PROTECTED sets) to keep the repo
    # free of a db<-main import cycle.
    from db import get_repositories
    from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS

    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    include_all_users = bool(args.get("include_all_users"))
    stock_id_set = PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS
    all_stock_ids = list(stock_id_set)
    rows = get_repositories().workers.list_for_agent(
        user_id=visibility_user_id,
        include_all_users=include_all_users,
        stock_worker_ids=all_stock_ids,
    )
    # Emily must report the SAME worker set the operator sees in the dashboard
    # worker grid (round-09 #1 split-brain: grid showed 1, Emily showed 9). The
    # grid reads repos.workers.list (owner + workspace-member scoped) and never
    # surfaces seeded stock workers on cloud. Emily's list_for_agent, however,
    # pads in the PUBLIC/PROTECTED stock ids and pulls public-visibility seeds,
    # so it over-counted by the seeded stock/example/test set the operator does
    # NOT own. Hide EXACTLY what the grid hides:
    #   (a) canonical system/internal workers (_worker_hidden_from_api —
    #       workspace-agent, worker-author, slack/whatsapp listeners, ".",
    #       _mcp_/smoke- prefixes) + manifest system_worker:true; PLUS
    #   (b) any worker whose id is in the seeded stock/example/test set
    #       (PUBLIC ∪ PROTECTED) that the operator does NOT own — these are the
    #       cross-tenant seeds the owner-scoped grid never shows.
    # A stock/example worker the operator GENUINELY owns (OSS seed-all, owner_id
    # == visibility user) is still shown — the discriminator is ownership, not
    # the cosmetic is_example label. The hidden set is footnoted in
    # hidden_system_count and include_system opts it all back in.
    from services.worker_access import _worker_hidden_from_api, _build_owned_tracked_ids
    _owned_tracked = _build_owned_tracked_ids()
    include_system = bool(args.get("include_system"))
    hidden_system = 0
    result = []
    for row in rows:
        try:
            manifest = json.loads(row.get("manifest_json") or "{}") if row.get("manifest_json") else {}
        except Exception:
            manifest = {}
        entry = {
            "id": row["id"],
            "name": row["name"],
            "title": manifest.get("title") or row["name"],
            "trigger": row.get("trigger_type") or "manual",
            "enabled": bool(row.get("enabled")),
            "system_worker": manifest.get("system_worker", False),
            "is_example": manifest.get("is_example", False),
        }
        wid = str(row["id"])
        # owner_id may be absent if a backend doesn't supply it; in that case we
        # cannot tell an owned seed from a cross-tenant one, so fall back to the
        # prior behaviour (do not apply the stock-not-owned filter).
        owner_id = row.get("owner_id")
        unowned_stock = (
            wid in stock_id_set
            and owner_id is not None
            and str(owner_id) != str(visibility_user_id)
        )
        is_hidden = (
            _worker_hidden_from_api(wid, _owned_tracked)
            or entry["system_worker"]
            or unowned_stock
        )
        if is_hidden and not include_system:
            hidden_system += 1
            continue
        result.append(entry)
    out = {"ok": True, "workers": result, "count": len(result)}
    if hidden_system:
        out["hidden_system_count"] = hidden_system
    return out


def _worker_can_view(conn: Any, worker_id: str, user_id: str) -> bool:
    """Return True if *user_id* may read/run *worker_id*.

    #237: route through ``WorkerRepository.get_for_agent`` (the same
    workspace-scoped repo path as ``_tool_workers_get`` / #1027) instead of a
    raw ``conn.execute`` against the engine SQLite ``workers`` table. In cloud
    the SQLite table is a co-mingled shadow across every tenant, so a raw
    ``WHERE owner_id=? OR visibility IN (...)`` query leaked other workspaces'
    private workers into the run-resolver. ``get_for_agent`` is implemented by
    each backend (SqliteWorkerRepository for OSS, SupabaseWorkerRepository for
    cloud) and returns None when the worker is not viewable by the caller's
    workspace, so the can-view decision is now workspace-correct on both.

    Visibility model (unchanged, now enforced by the repo): can_view = is_owner
    OR (visibility in {workspace, shared} AND user is an active member of the
    worker's workspace) OR the worker is a stock/public worker, with admins
    seeing all. ``conn`` is retained for signature compatibility (callers still
    pass it) but is no longer used directly.
    """
    from chat_service import _effective_worker_visibility_user_id
    from db import get_repositories
    from main import (
        PUBLIC_STOCK_WORKER_IDS,
        PROTECTED_STOCK_WORKER_IDS,
        _shared_filesystem_fallback_allowed,
    )

    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    all_stock_ids = list(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS)
    fs_fallback = _shared_filesystem_fallback_allowed()
    try:
        row = get_repositories().workers.get_for_agent(
            user_id=visibility_user_id,
            worker_id=worker_id,
            stock_worker_ids=all_stock_ids,
            allow_fs_fallback=fs_fallback,
        )
    except Exception:
        # Repo unavailable (e.g. unit test stubbing the DB at a higher level
        # without migrations). Preserve the pre-#237 fail-open contract: the
        # downstream run path surfaces any real "not found" error itself.
        return True
    if row is not None:
        return True
    # OSS single-user / dev mode only (NEVER cloud — _shared_filesystem_
    # fallback_allowed() is False there): an on-disk worker that has NO DB row
    # yet is still runnable. get_for_agent returns None for such fileless
    # workers even with allow_fs_fallback, so preserve the pre-#237 contract
    # here. CRITICAL: this fallback only applies when the worker has no DB row
    # at all — a worker that HAS a DB row owned by someone else (a private
    # cross-tenant/cross-user worker) must stay blocked, so we re-check
    # existence with the unscoped get_any before allowing. The run path itself
    # returns "not found" if the file is absent.
    if fs_fallback:
        try:
            exists = get_repositories().workers.get_any(worker_id=worker_id) is not None
        except Exception:
            exists = False
        if not exists:
            return True
    return False


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
    """Return [{id, name}] for every worker *user_id* may run.

    #237: route through ``WorkerRepository.list_for_agent`` (the same
    workspace-scoped repo path as ``_tool_workers_list_all`` / #1027) instead of
    a raw ``conn.execute`` against the engine SQLite ``workers`` table. In cloud
    the SQLite table is a co-mingled shadow across every tenant, so the raw
    ``WHERE owner_id=? OR visibility IN (...)`` candidate query returned other
    workspaces' private worker ids/names into the run resolver. ``list_for_agent``
    is backend-scoped (workspace-correct on cloud, owner+member on OSS) and the
    run path still re-checks ``_worker_can_view`` before firing.

    Unlike ``_tool_workers_list_all`` this does NOT hide system/example workers —
    a by-id run of a stock worker must still resolve — so the system/example
    filtering applied by that tool is intentionally skipped here. ``conn`` is
    retained for signature compatibility but is no longer used directly.
    """
    from chat_service import _effective_worker_visibility_user_id
    from db import get_repositories
    from main import PUBLIC_STOCK_WORKER_IDS, PROTECTED_STOCK_WORKER_IDS

    # include_all_users mirrors _tool_workers_list_all's default (member view
    # even for admins, so a personal run-resolve never enumerates another
    # member's private workers). Admin-by-id run still resolves via _worker_
    # can_view's get_for_agent admin path. Use the effective visibility user id,
    # exactly like _tool_workers_list_all.
    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    all_stock_ids = list(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS)
    try:
        rows = get_repositories().workers.list_for_agent(
            user_id=visibility_user_id,
            include_all_users=False,
            stock_worker_ids=all_stock_ids,
        )
    except Exception:
        rows = []

    seen: set[str] = set()
    out: List[Dict[str, str]] = []
    for r in rows:
        wid = str(r.get("id") or "")
        if not wid or wid in seen:
            continue
        seen.add(wid)
        out.append({"id": wid, "name": str(r.get("name") or wid)})

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
    # #1027: route through the repository Protocol (was a direct get_db() read).
    # The can-view gate + fetch now live in WorkerRepository.get_for_agent; the
    # cross-module bits (canonical id, stock ids, fs-fallback) are resolved here
    # and passed in so the repo stays free of a db<-main import cycle.
    from chat_service import _effective_worker_visibility_user_id
    from db import get_repositories
    from services.worker_access import _canonical_worker_id
    from main import (
        PUBLIC_STOCK_WORKER_IDS,
        PROTECTED_STOCK_WORKER_IDS,
        _shared_filesystem_fallback_allowed,
    )

    worker_id = str(args.get("id") or "")
    if not worker_id:
        return {"ok": False, "error": "id is required"}
    worker_id = _canonical_worker_id(worker_id)
    visibility_user_id = _effective_worker_visibility_user_id(user_id)
    all_stock_ids = list(PUBLIC_STOCK_WORKER_IDS | PROTECTED_STOCK_WORKER_IDS)
    row = get_repositories().workers.get_for_agent(
        user_id=visibility_user_id,
        worker_id=worker_id,
        stock_worker_ids=all_stock_ids,
        allow_fs_fallback=_shared_filesystem_fallback_allowed(),
    )
    if not row:
        return {"ok": False, "error": f"Worker not found: {worker_id}"}
    try:
        manifest = json.loads(row.get("manifest_json") or "{}") if row.get("manifest_json") else {}
    except Exception:
        manifest = {}
    return {
        "ok": True,
        "worker": {
            "id": row["id"],
            "name": row["name"],
            "trigger": row.get("trigger_type") or "manual",
            "cron": row.get("cron_expr"),
            "enabled": bool(row.get("enabled")),
            "manifest": manifest,
        },
    }


