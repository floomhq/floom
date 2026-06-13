"""Static configuration constants for the WorkerOS API.

These values were previously defined inline in ``main.py``. They are pure data
(no application state, no FastAPI objects) and are consumed across many request
handlers, so they live here as a single source of truth. ``main`` re-exports
every name below for backward compatibility with existing imports.
"""

from __future__ import annotations

import os
import time
import re


# ---------------------------------------------------------------------------
# Deployment mode
# ---------------------------------------------------------------------------

def _is_cloud_deploy() -> bool:
    """True when running in multi-tenant cloud mode.

    In cloud mode the shared filesystem WORKERS_DIR holds bundles from
    multiple tenants and MUST NOT be used as a fallback list source for
    any per-user endpoint. Defaults to False when WORKEROS_DEPLOY is unset
    so OSS single-tenant installs keep their first-time UX (empty DB ->
    enumerate filesystem).
    """
    return (os.environ.get("WORKEROS_DEPLOY") or "").strip().lower() == "cloud"


def _user_scoped_local_mode() -> bool:
    return os.environ.get("WORKEROS_ENABLE_USER_HEADER_SCOPE") == "1"


def _bootstrap_user_id() -> str:
    """The single operator's user id in OSS single-tenant mode (env-overridable)."""
    configured = (os.environ.get("WORKEROS_USER_ID") or "").strip()
    return configured or "federico"


# ---------------------------------------------------------------------------
# Public sharing
# ---------------------------------------------------------------------------

PUBLIC_SHARE_TEXT_PREVIEW_LIMIT = 512 * 1024


# ---------------------------------------------------------------------------
# Request body size limits
# ---------------------------------------------------------------------------

DEFAULT_JSON_BODY_LIMIT_BYTES = 256 * 1024
FROM_BUNDLE_BODY_LIMIT_BYTES = 5 * 1024 * 1024
DEFAULT_CONTEXT_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024
# A workspace template bundles every operator worker + knowledge pack, so it is
# larger than a single worker bundle. Cap it generously but bounded.
WORKSPACE_IMPORT_BODY_LIMIT_BYTES = 50 * 1024 * 1024
# #931: zip-bomb guards for /workspace/import — uncompressed expansion and entry
# count are bounded independently of the compressed body size.
_MAX_IMPORT_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
_MAX_IMPORT_ENTRIES = 5000
DEFAULT_CHAT_MESSAGE_MAX_CHARS = 20_000


# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

DEFAULT_RATE_LIMIT = (60, 60.0)
BODYLESS_METHODS = {"GET", "HEAD", "OPTIONS"}
RATE_LIMIT_RULES = [
    # #601: auth/identity endpoints — strict limits to prevent brute-force and
    # credential-stuffing. 5 attempts per minute per IP is generous for humans
    # while blocking automated attacks. /auth/me is included because it is the
    # primary identity probe used by scanners checking for auth bypass (#594).
    (re.compile(r"^/auth/login$"), (5, 60.0)),
    (re.compile(r"^/auth/setup$"), (5, 60.0)),
    (re.compile(r"^/auth/me$"), (30, 60.0)),
    (re.compile(r"^/auth/tokens$"), (10, 60.0)),
    (re.compile(r"^/auth/magic-link$"), (5, 60.0)),
    (re.compile(r"^/auth/magic/.+$"), (10, 60.0)),
    (re.compile(r"^/cli-auth/devices$"), (5, 60.0)),
    (re.compile(r"^/workers/from-bundle$"), (10, 60.0)),
    (re.compile(r"^/workspace/import$"), (10, 60.0)),
    # #948: a full-workspace ZIP per request — keep bulk re-download slow.
    # 5 per hour is generous for humans and starves scripted exfiltration.
    (re.compile(r"^/workspace/export$"), (5, 3600.0)),
    (re.compile(r"^/workers$"), (20, 60.0)),
    (re.compile(r"^/connections/connect/[^/]+$"), (10, 60.0)),
    (re.compile(r"^/connections$"), (20, 60.0)),
    # #839: the MCP serve endpoint grants workspace-wide capability from a
    # single secret; the 60/min default was generous enough for secret
    # brute-forcing and runs.watch connection-pinning. 10/min matches the
    # other sensitive endpoints above.
    (re.compile(r"^/mcp-tools/serve$"), (10, 60.0)),
]


# ---------------------------------------------------------------------------
# Stock / system worker identifiers
# ---------------------------------------------------------------------------

# #872 SECURITY: PROTECTED_STOCK_WORKER_IDS is ALSO consulted by Emily's
# _worker_can_view (chat_service) as a visibility bypass — `worker_id in
# PUBLIC_STOCK_WORKER_IDS or worker_id in PROTECTED_STOCK_WORKER_IDS` grants
# read/run to EVERY user regardless of owner/visibility. So curating
# PUBLIC_STOCK_WORKER_IDS alone is NOT enough: any tenant-private worker still
# listed here keeps leaking (a non-owner member can view AND run it). This set
# is curated to the same standard — genuine ship-with-product example/demo
# templates + engine/system workers only. Tenant-specific workers that read the
# operator's real Gmail / analytics / search-console / CRM data are removed —
# e.g. a worker that summarizes a real connected inbox, one that reads a real
# product-analytics project, or one that reads real search-console data and
# writes to a connected notes/docs tool. When unsure, EXCLUDE.
# Removing them here also correctly makes them owner-deletable and owner-scoped
# (they were never real stock). When unsure, EXCLUDE.
PROTECTED_STOCK_WORKER_IDS = frozenset(
    {
        # genuine ship-with-product example/demo templates (is_example: true,
        # generic pattern, no person-specific account data)
        "csv_enricher",
        "github-digest",
        "node-smoke-test",
        "openblog",
        "opendraft",
        "outbound-approval-demo",
        "research_brief",
        # engine/system workers that power Workeros itself (not tenant content)
        "slack-listener",
        "whatsapp-listener",
        "worker-author",
        "workspace-agent",
    }
)

# #872 SECURITY: PUBLIC_STOCK_WORKER_IDS are returned to ANY member regardless
# of visibility=private (the ownership guards check stock IDs first, by design
# for genuine ship-with-product templates). This set previously included a
# tenant's REAL private workers (personal Gmail / CRM / analytics / recruiting
# integrations), leaking their existence and letting members trigger runs.
# Curated down to genuinely-shareable example/demo templates only. Stock =
# ships-with-product examples, never a tenant's data. A removed worker now
# correctly 404s for a non-owner member.
#
# Inclusion criterion (deliberately stricter than `is_example: true`): a worker
# belongs here ONLY if it is BOTH (a) marked `is_example: true` in worker.yml
# AND (b) a generic pattern demo that touches no person-specific account data or
# real client/business logic. `is_example: true` alone is NOT sufficient — many
# of the operator's REAL workers carry that flag yet operate on personal
# Gmail/CRM/client data, so they are excluded. When unsure,
# EXCLUDE: a wrongly-excluded worker merely isn't a public template; a
# wrongly-included one leaks a tenant's private worker.
#
# Note: demo workers that READ a connected account (e.g. the gmail-* example
# templates) ship as `is_example: true` examples but are deliberately kept OUT
# of this cross-member visibility-bypass set — a member should only see/run them
# once they own a copy, never via the stock bypass.
PUBLIC_STOCK_WORKER_IDS = frozenset(
    {
        "csv_enricher",          # is_example, enriches arbitrary CSV rows — no real data source
        "github-digest",         # is_example, digest of the runner's own GitHub — generic pattern
        "node-smoke-test",       # is_example, benign runtime smoke (used by E2E)
        "openblog",              # is_example, upstream OpenBlog engine demo
        "opendraft",             # is_example, upstream OpenDraft engine demo
        "outbound-approval-demo",# is_example, HITL two-run approval pattern demo
        "research_brief",        # is_example, research brief on any topic — generic
    }
)

# System/infra workers whose runs are never surfaced in the operator /runs list.
# These run autonomously in the background (trigger-based, high-volume, or
# internal generation agents) and flooding the runs list with them harms UX.
_SYSTEM_WORKER_IDS = frozenset({
    "workspace-agent",
    "worker-author",
    "slack-listener",
    "whatsapp-listener",
})

_INTERNAL_WORKER_ID_PREFIXES = (
    "_mcp_",
    "audit-local-",
    "smoke-",
)


# ---------------------------------------------------------------------------
# System knowledge packs (contexts)
# ---------------------------------------------------------------------------

# Engine/system knowledge packs that power Workeros itself (e.g. the
# worker-generation style guide). They are internal config, not operator
# content, so they are hidden from the /contexts operator view — the contexts
# equivalent of system_worker:true. A pack can also opt in via metadata
# {"system": true}.
SYSTEM_CONTEXT_PACKS = frozenset({"worker-author-style"})

# One-line, operator-facing descriptions for system packs that ship without a
# README.md. Surfaced read-only on the /contexts page so operators understand
# what each engine pack does.
SYSTEM_CONTEXT_DESCRIPTIONS: dict[str, str] = {
    "worker-author-style": (
        "Engine style guide and schema the worker author follows when "
        "generating new workers from your prompts (read-only)."
    ),
}


# Process start time for /system/metrics uptime reporting.
# Public API version string (FastAPI app metadata + GET /system/info).
API_VERSION = "0.2.0"

_PROCESS_START_TIME = time.time()
_PROCESS_STARTED_AT = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_PROCESS_START_TIME))


# Reserved worker id for the worker-authoring meta-worker (Emily generation).
_WORKER_AUTHOR_ID = "worker-author"
