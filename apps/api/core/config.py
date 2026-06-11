"""Static configuration constants for the WorkerOS API.

These values were previously defined inline in ``main.py``. They are pure data
(no application state, no FastAPI objects) and are consumed across many request
handlers, so they live here as a single source of truth. ``main`` re-exports
every name below for backward compatibility with existing imports.
"""

from __future__ import annotations

import os
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
    (re.compile(r"^/workspace/export$"), (20, 60.0)),
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

# #872 SECURITY: PROTECTED_STOCK_WORKER_IDS is also consulted by Emily's
# _worker_can_view (chat_service) as a visibility bypass — so the same tenant
# private workers leaked here too. Curated to genuine ship-with-product
# templates + engine/system workers only; the named-private workers (and the
# Gmail/CRM tenant-specific entries that only appeared here) are removed so a
# non-owner member can neither view nor run them. Removing them from this set
# also correctly makes them owner-deletable (they were never real stock).
PROTECTED_STOCK_WORKER_IDS = frozenset(
    {
        # genuine ship-with-product example/demo templates
        "csv_enricher",
        "github-digest",
        "gmail-summarize-latest",
        "node-smoke-test",
        "openblog",
        "opendraft",
        "openpaper-posthog-daily",
        "outbound-approval-demo",
        "research_brief",
        "seo-opportunity-digest",
        # engine/system workers
        "slack-listener",
        "whatsapp-listener",
        "worker-author",
        "workspace-agent",
    }
)

# #872 SECURITY: PUBLIC_STOCK_WORKER_IDS are returned to ANY member regardless
# of visibility=private (the ownership guards check stock IDs first, by design
# for genuine ship-with-product templates). This set previously included a
# tenant's REAL private workers (Gmail/DACH/kugelaudio/CV/GSC/LinkedIn/CRM/
# weekly_update), leaking their existence and letting members trigger runs.
# Curated down to genuinely-shareable example/demo templates only. Stock =
# ships-with-product examples, never a tenant's data. A removed worker now
# correctly 404s for a non-owner member.
PUBLIC_STOCK_WORKER_IDS = frozenset(
    {
        "csv_enricher",
        "github-digest",
        "gmail-summarize-latest",
        "node-smoke-test",
        "openblog",
        "opendraft",
        "outbound-approval-demo",
        "research_brief",
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
