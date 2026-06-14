#!/usr/bin/env python3
"""Run bounded Workeros adversarial probes, then ask Kimi to audit the evidence.

The important ordering is: live evidence first, Kimi interpretation second.
This avoids the failure mode where an LLM does code review and misses runtime
response-shape, auth, and deployment drift bugs.
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import hmac
import importlib
import hashlib
import io
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import types
import uuid
import zipfile
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError as exc:  # pragma: no cover - operator setup error
    raise SystemExit("requests is required: python3 -m pip install requests") from exc


DEFAULT_API = "https://workers-api.floom.dev"
DEFAULT_WEB = "https://workers.floom.dev"
DEFAULT_PROFILES = ("api-security", "worker-runtime", "product-flow")
LEAK_STRINGS = (
    "errors.pydantic.dev",
    "ON DELETE CASCADE",
    "derived_token",
    "1-token",
    "May 2026 audit",
    "A May 2026 audit",
    "Authentication accepts either:",
    "?token=<webhook_token>",
    "X-Floom-Signature header",
)
PLATFORM_SECRET_PROBE_NAMES = (
    "OPENAI_API_KEY",
    "FLOOM_SECRET",
    "E2B_API_KEY",
    "COMPOSIO_API_KEY",
    "THIS_SECRET_DOES_NOT_EXIST_AUDIT",
)
SECRET_TEST_LEAK_STRINGS = (
    "OpenAI API key",
    "1-token",
    "chars",
    "not set in the environment",
    "is set",
)
RUN_EXPORT_FORBIDDEN_FILES = (
    "inputs.json",
    "logs.txt",
    "artifacts/transcript.jsonl",
)
RUN_CREATE_QUOTA_RESET_SECONDS = 61
KIMI_PROBE_SEMANTICS: dict[str, str] = {
    "local-foreign-custom-worker-routes-404": (
        "uses a real worker created by user-a plus a real run on that worker; "
        "user-b GET/PATCH/PUT/PUT-files/DELETE/POST-run/POST-replay/GET-timeseries all return 404."
    ),
    "local-foreign-run-routes-404": (
        "uses a real run owned by user-a; user-b GET bundle/download/events/logs/stream and artifact download all return 404."
    ),
    "local-foreign-worker-delete-404": (
        "user-a creates a real custom worker and user-b DELETEs that existing worker; the delete returns 404."
    ),
    "local-contexts-scoped": (
        "user-a creates a real context and file; user-b list/get/file-get/file-put/upload/delete and worker-create-with-foreign-context are all blocked."
    ),
    "local-context-name-collision-isolated": (
        "user-a and user-b both create the same context name and write different file contents; reads stay isolated and filesystem paths diverge."
    ),
    "local-conversations-list-scoped": (
        "user-a creates a conversation through /chat; GET /conversations shows it only to user-a and not to user-b."
    ),
    "local-conversations-list-no-leak": (
        "GET /conversations for user-b does not contain user-a conversation ids or the seeded chat text."
    ),
    "local-chat-foreign-conversation-detached": (
        "user-b attempts /chat with user-a's conversation_id and receives a fresh conversation_id owned by user-b instead of attaching to user-a's conversation."
    ),
    "local-stock-worker-mutations-blocked": (
        "DELETE/PATCH/PUT/PUT-files against a stock worker all return 403."
    ),
    "local-stock-worker-detail-no-secrets": (
        "GET stock worker detail returns 200 without exposing source files, env keys, bundle URLs, or webhook secrets."
    ),
    "local-stock-timeseries-zero-safe": (
        "GET stock worker /runs/timeseries as user-a and user-b both return 200 with zero-safe aggregate rows and no per-user leakage."
    ),
    "local-stock-worker-run-create-rate-limited": (
        "POST /workers/research_brief/runs as an authenticated user hits the per-worker limiter with statuses [200, 200, 429]."
    ),
    "local-draft-and-create-foreign-context-rejected": (
        "user-a creates a real context; user-b uses draft-and-create with worker.yml referencing that context and receives 400 with no worker written."
    ),
    "local-run-create-foreign-file-id-rejected": (
        "user-a uploads a real file id/SHA; user-b tries to run a file-input worker against that uploaded file and receives 403/404."
    ),
    "local-run-create-404-no-secret-leak": (
        "user-b POST /workers/{foreign_worker}/runs returns 404 without secret names, trace ids, or runner metadata in the body."
    ),
    "local-run-env-secret-error-redacted": (
        "a seeded failed run with error COMPOSIO_API_KEY not set is rendered as Required platform secret is not configured "
        "across /runs, /runs/{id}, /runs/{id}/logs, /runs/{id}/events, and /runs/{id}/stream."
    ),
    "local-runs-list-no-worker-name-leak": (
        "GET /runs for each user omits the other user's worker id/name from the response body."
    ),
    "local-reload-keeps-stock-workers-protected": (
        "POST /workers/reload succeeds for the caller, then PATCH on a stock worker still returns 403."
    ),
    "local-restore-stock-worker-blocked": (
        "POST /workers/research_brief/restore returns 403 for a stock worker."
    ),
    "local-sample-input-foreign-404": (
        "GET /workers/{foreign_custom_worker}/sample-input by a non-owner returns 404."
    ),
    "local-upload-content-type-bypass-rejected": (
        "POST /uploads with filename .txt but media type image/svg+xml returns 400."
    ),
    "local-upload-token-cross-file-rejected": (
        "a download token minted for file A returns 404 when reused against file B."
    ),
    "stock-worker-detail-no-secrets": (
        "GET /workers/research_brief on prod returns 200 without source files, env keys, bundle URLs, or webhook secrets."
    ),
    "stock-worker-run-create-auth-and-shape": (
        "POST /workers/research_brief/runs on prod returns 403 without auth and 200 with auth, yielding a real run_id."
    ),
    "stock-worker-run-replay-auth-and-shape": (
        "POST /workers/research_brief/runs/{run_id}/replay on prod returns 200 with auth and yields a new run_id."
    ),
    "stock-worker-run-events-no-sensitive-leak": (
        "GET /runs/{run_id}/events for a real stock-worker run returns 200 and does not leak secret names, trace IDs, or runner metadata."
    ),
    "stock-worker-run-stream-no-sensitive-leak": (
        "GET /runs/{run_id}/stream for a real stock-worker run returns 200 and does not leak secret names, trace IDs, or runner metadata."
    ),
    "stock-worker-run-logs-no-sensitive-leak": (
        "GET /runs/{run_id}/logs for a real stock-worker run returns 200 and does not leak secret names, trace IDs, or runner metadata."
    ),
    "stock-worker-timeseries-auth-and-safe": (
        "GET /workers/research_brief/runs/timeseries returns 403 without auth and 200 with auth, with only aggregate day rows."
    ),
    "stock-worker-reload-keeps-mutations-blocked": (
        "POST /workers/reload on prod returns 200, and a subsequent PATCH on a stock worker still returns 403."
    ),
}


def now_slug() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().strftime("%Y%m%d-%H%M%S")


def read_secret(repo: Path, explicit: str | None) -> str:
    path = Path(explicit) if explicit else repo / ".deploy-secret"
    if not path.is_file():
        raise SystemExit(f"secret file not found: {path}")
    secret = path.read_text().strip()
    if not secret:
        raise SystemExit(f"secret file is empty: {path}")
    return secret


def sanitize(value: str, secret: str) -> str:
    text = value.replace(secret, "$FLOOM_SECRET")
    if len(secret) >= 12:
        text = text.replace(secret[:12], "$FLOOM_SECRET_PREFIX")
    return text


def snippet(text: str, secret: str, limit: int = 1200) -> str:
    text = sanitize(text, secret)
    if len(text) <= limit:
        return text
    return text[:limit] + f"... <truncated {len(text) - limit} chars>"


def request(
    base: str,
    method: str,
    path: str,
    *,
    secret: str | None = None,
    timeout: float = 30,
    **kwargs: Any,
) -> dict[str, Any]:
    headers = dict(kwargs.pop("headers", {}) or {})
    audit_client_ip = os.environ.get("WORKEROS_AUDIT_CLIENT_IP", "").strip()
    if audit_client_ip and "x-forwarded-for" not in {key.lower(): value for key, value in headers.items()}:
        headers["X-Forwarded-For"] = audit_client_ip
    if secret:
        headers["x-floom-secret"] = secret
    started = time.perf_counter()
    url = base.rstrip("/") + path
    try:
        response = requests.request(method, url, headers=headers, timeout=timeout, **kwargs)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "method": method.upper(),
            "path": path,
            "status": response.status_code,
            "elapsed_ms": elapsed_ms,
            "response_bytes": len(response.content),
            "location": response.headers.get("location", ""),
            "body": response.text,
        }
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "method": method.upper(),
            "path": path,
            "status": "EXCEPTION",
            "elapsed_ms": elapsed_ms,
            "response_bytes": 0,
            "location": "",
            "body": f"{type(exc).__name__}: {exc}",
        }


def request_binary(
    base: str,
    method: str,
    path: str,
    *,
    secret: str | None = None,
    timeout: float = 30,
    **kwargs: Any,
) -> dict[str, Any]:
    headers = dict(kwargs.pop("headers", {}) or {})
    audit_client_ip = os.environ.get("WORKEROS_AUDIT_CLIENT_IP", "").strip()
    if audit_client_ip and "x-forwarded-for" not in {key.lower(): value for key, value in headers.items()}:
        headers["X-Forwarded-For"] = audit_client_ip
    if secret:
        headers["x-floom-secret"] = secret
    started = time.perf_counter()
    url = base.rstrip("/") + path
    try:
        response = requests.request(method, url, headers=headers, timeout=timeout, **kwargs)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "method": method.upper(),
            "path": path,
            "status": response.status_code,
            "elapsed_ms": elapsed_ms,
            "response_bytes": len(response.content),
            "content_type": response.headers.get("content-type", ""),
            "location": response.headers.get("location", ""),
            "content": response.content,
            "body": response.text[:1200],
        }
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "method": method.upper(),
            "path": path,
            "status": "EXCEPTION",
            "elapsed_ms": elapsed_ms,
            "response_bytes": 0,
            "content_type": "",
            "location": "",
            "content": b"",
            "body": f"{type(exc).__name__}: {exc}",
        }


def request_stream_text(
    base: str,
    method: str,
    path: str,
    *,
    secret: str | None = None,
    timeout: float = 30,
    max_lines: int = 12,
    max_chars: int = 2000,
    **kwargs: Any,
) -> dict[str, Any]:
    headers = dict(kwargs.pop("headers", {}) or {})
    audit_client_ip = os.environ.get("WORKEROS_AUDIT_CLIENT_IP", "").strip()
    if audit_client_ip and "x-forwarded-for" not in {key.lower(): value for key, value in headers.items()}:
        headers["X-Forwarded-For"] = audit_client_ip
    if secret:
        headers["x-floom-secret"] = secret
    started = time.perf_counter()
    url = base.rstrip("/") + path
    try:
        response = requests.request(method, url, headers=headers, timeout=timeout, stream=True, **kwargs)
        lines: list[str] = []
        char_count = 0
        for raw_line in response.iter_lines(decode_unicode=True):
            line = raw_line or ""
            lines.append(line)
            char_count += len(line) + 1
            if len(lines) >= max_lines or char_count >= max_chars:
                break
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        body = "\n".join(lines)
        return {
            "method": method.upper(),
            "path": path,
            "status": response.status_code,
            "elapsed_ms": elapsed_ms,
            "response_bytes": len(body.encode("utf-8")),
            "location": response.headers.get("location", ""),
            "body": body,
        }
    except Exception as exc:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return {
            "method": method.upper(),
            "path": path,
            "status": "EXCEPTION",
            "elapsed_ms": elapsed_ms,
            "response_bytes": 0,
            "location": "",
            "body": f"{type(exc).__name__}: {exc}",
        }


def record(results: list[dict[str, Any]], probe_id: str, ok: bool, detail: str, raw: dict[str, Any] | None = None) -> None:
    results.append({"id": probe_id, "ok": ok, "detail": detail, "raw": raw or {}})


def extract_route_inventory(openapi_body: str) -> list[dict[str, Any]]:
    try:
        spec = json.loads(openapi_body)
    except Exception:
        return []
    paths = spec.get("paths")
    if not isinstance(paths, dict):
        return []
    inventory: list[dict[str, Any]] = []
    for path, methods in sorted(paths.items()):
        if not isinstance(methods, dict):
            continue
        for method, meta in sorted(methods.items()):
            method_upper = str(method).upper()
            if method_upper not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
                continue
            meta = meta if isinstance(meta, dict) else {}
            params = []
            for param in meta.get("parameters") or []:
                if isinstance(param, dict):
                    params.append({
                        "name": param.get("name"),
                        "in": param.get("in"),
                        "required": param.get("required"),
                    })
            inventory.append({
                "method": method_upper,
                "path": path,
                "operation_id": meta.get("operationId"),
                "summary": meta.get("summary"),
                "has_request_body": "requestBody" in meta,
                "parameters": params,
                "risk_tags": route_risk_tags(method_upper, path),
            })
    return inventory


def route_risk_tags(method: str, path: str) -> list[str]:
    tags: list[str] = []
    if method in {"POST", "PUT", "PATCH", "DELETE"}:
        tags.append("mutating")
    if "{" in path:
        tags.append("object-id")
    if any(token in path for token in ("/chat", "/conversation", "/conversations", "/workspace")):
        tags.append("chat-or-workspace")
    if any(token in path for token in ("/runs", "/artifacts", "/download", "/bundle")):
        tags.append("run-data")
    if any(token in path for token in ("/secrets", "/system", "/settings")):
        tags.append("secret-or-config")
    if any(token in path for token in ("/workers", "/from-bundle", "/files", "/uploads")):
        tags.append("worker-surface")
    if any(token in path for token in ("/connections", "/composio", "/webhooks")):
        tags.append("oauth-or-webhook")
    if any(token in path for token in ("/cancel", "/clear", "/delete", "/rotate")):
        tags.append("destructive-or-state-transition")
    return tags


ROUTE_COVERAGE_HINTS: dict[tuple[str, str], tuple[str, ...]] = {
    ("GET", "/health"): ("health-public", "local-health", "local-deploy-health"),
    ("GET", "/healthz"): ("health-public",),
    ("POST", "/chat"): (
        "chat-auth-required",
        "chat-empty-message-rejected",
        "chat-message-length-limit",
        "local-chat-conversations-scoped",
        "local-chat-foreign-conversation-detached",
        "local-chat-message-length-limit",
    ),
    ("GET", "/workspace"): ("workspace-auth-required", "local-workspace-roundtrip"),
    ("PUT", "/workspace"): ("workspace-auth-required", "local-workspace-roundtrip"),
    ("GET", "/conversations"): (
        "conversations-auth-required",
        "local-chat-conversations-scoped",
        "local-conversations-list-scoped",
        "local-conversations-list-no-leak",
    ),
    ("GET", "/conversations/{conversation_id}"): (
        "conversations-auth-required",
        "local-chat-conversations-scoped",
    ),
    ("GET", "/integrations/catalog"): ("integrations-routes-require-auth",),
    ("GET", "/integrations/triggers"): ("integrations-routes-require-auth",),
    ("GET", "/metrics"): ("prometheus-metrics-auth-and-shape",),
    ("GET", "/contexts"): ("local-contexts-scoped",),
    ("POST", "/contexts/{name}"): ("local-contexts-scoped", "local-context-name-collision-isolated"),
    ("GET", "/contexts/{name}"): ("local-contexts-scoped",),
    ("DELETE", "/contexts/{name}"): ("local-contexts-scoped",),
    ("GET", "/contexts/{name}/files/{file_path}"): ("local-contexts-scoped", "local-context-file-symlink-traversal"),
    ("PUT", "/contexts/{name}/files/{file_path}"): ("local-contexts-scoped", "local-context-file-symlink-traversal"),
    ("DELETE", "/contexts/{name}/files/{file_path}"): ("local-contexts-scoped", "local-context-file-symlink-traversal"),
    ("POST", "/contexts/{name}/upload"): ("local-contexts-scoped",),
    ("GET", "/runs"): (
        "local-runs-list-scoped",
        "local-runs-list-no-worker-name-leak",
        "local-run-env-secret-error-redacted",
    ),
    ("POST", "/runs/clear"): ("runs-clear-requires-confirm", "local-runs-clear-scoped"),
    ("POST", "/runs/{run_id}/cancel"): (
        "run-cancel-no-terminal-existence-oracle",
        "local-foreign-run-routes-404",
    ),
    ("GET", "/runs/{run_id}"): (
        "run-detail-no-sensitive-fields",
        "local-foreign-run-routes-404",
        "local-run-env-secret-error-redacted",
    ),
    ("GET", "/runs/{run_id}/download"): (
        "run-download-no-sensitive-archive-files",
        "local-foreign-run-routes-404",
    ),
    ("GET", "/runs/{run_id}/bundle/{filename}"): (
        "run-bundle-no-snapshot-existence-oracle",
        "run-bundle-path-traversal-rejected",
        "local-foreign-run-routes-404",
    ),
    ("GET", "/runs/{run_id}/artifacts/{artifact_id}/download"): (
        "run-download-no-sensitive-archive-files",
        "local-foreign-run-routes-404",
    ),
    ("GET", "/runs/{run_id}/stream"): (
        "local-foreign-run-routes-404",
        "local-run-stream-no-sensitive-content",
        "local-run-env-secret-error-redacted",
        "stock-worker-run-stream-no-sensitive-leak",
    ),
    ("GET", "/runs/{run_id}/events"): (
        "local-foreign-run-routes-404",
        "local-run-events-no-sensitive-stream",
        "local-run-env-secret-error-redacted",
        "stock-worker-run-events-no-sensitive-leak",
    ),
    ("GET", "/runs/{run_id}/logs"): (
        "run-detail-no-sensitive-fields",
        "local-foreign-run-routes-404",
        "local-run-env-secret-error-redacted",
        "run-logs-no-sensitive-leak",
        "stock-worker-run-logs-no-sensitive-leak",
    ),
    ("POST", "/runs/{run_id}/approve"): (
        "run-approval-routes-require-auth",
        "local-approval-routes-scoped",
    ),
    ("POST", "/runs/{run_id}/reject"): (
        "run-approval-routes-require-auth",
        "local-approval-routes-scoped",
    ),
    ("POST", "/workers/{worker_id}/runs"): (
        "run-create-global-rate-limit",
        "run-create-body-limit-enforced",
        "local-foreign-custom-worker-routes-404",
        "local-run-file-input-foreign-sha-blocked",
        "local-run-create-foreign-file-id-rejected",
        "local-run-create-404-no-secret-leak",
        "local-run-create-per-worker-rate-limit",
        "local-stock-worker-run-create-rate-limited",
        "stock-worker-run-create-auth-and-shape",
    ),
    ("POST", "/workers/{worker_id}/runs/{run_id}/replay"): (
        "run-replay-shares-global-rate-limit",
        "local-foreign-custom-worker-routes-404",
        "local-run-replay-per-run-rate-limit",
        "local-run-replay-cross-worker-same-user-404",
        "stock-worker-run-replay-auth-and-shape",
    ),
    ("PATCH", "/workers/{worker_id}"): (
        "local-stock-worker-mutations-blocked",
        "local-foreign-custom-worker-routes-404",
        "local-worker-owner-mass-assignment-rejected",
    ),
    ("PUT", "/workers/{worker_id}"): (
        "local-stock-worker-mutations-blocked",
        "local-foreign-custom-worker-routes-404",
        "local-worker-owner-mass-assignment-rejected",
    ),
    ("PUT", "/workers/{worker_id}/files"): ("local-stock-worker-mutations-blocked", "local-foreign-custom-worker-routes-404"),
    ("GET", "/workers"): (
        "workers-require-auth",
        "workers-list-stock",
        "local-foreign-custom-worker-hidden",
    ),
    ("POST", "/workers"): (
        "worker-write-routes-require-auth",
        "pydantic-version-redacted",
        "workers-oversized-body",
        "concurrent-create-conflict",
        "local-worker-owner-mass-assignment-rejected",
    ),
    ("POST", "/workers/draft-and-create"): (
        "worker-write-routes-require-auth",
        "local-draft-and-create-files-path-rejected",
        "local-draft-and-create-body-limit",
        "local-draft-and-create-foreign-context-rejected",
    ),
    ("POST", "/workers/reload"): (
        "worker-write-routes-require-auth",
        "local-reload-preserves-owner",
        "local-reload-keeps-stock-workers-protected",
        "stock-worker-reload-keeps-mutations-blocked",
    ),
    ("POST", "/workers/{worker_id}/restore"): (
        "worker-restore-auth-required",
        "local-worker-restore-scoped",
        "local-restore-stock-worker-blocked",
    ),
    ("DELETE", "/workers/{worker_id}"): (
        "stock-worker-delete-blocked",
        "local-stock-worker-mutations-blocked",
        "local-foreign-worker-delete-404",
    ),
    ("GET", "/workers/{worker_id}"): (
        "local-foreign-custom-worker-routes-404",
        "stock-worker-detail-no-secrets",
        "local-stock-worker-detail-no-secrets",
    ),
    ("GET", "/workers/{worker_id}/sample-input"): (
        "sample-input-auth-and-shape",
        "local-sample-input-scoped",
        "local-sample-input-foreign-404",
    ),
    ("GET", "/workers/{worker_id}/runs/timeseries"): (
        "local-foreign-custom-worker-routes-404",
        "local-foreign-timeseries-no-data-leak",
        "local-stock-timeseries-zero-safe",
        "stock-worker-timeseries-auth-and-safe",
    ),
    ("POST", "/workers/draft-from-prompt"): (
        "workers-oversized-body",
        "draft-from-prompt-auth-required",
        "local-draft-from-prompt-url-treated-as-text",
    ),
    ("POST", "/workers/from-bundle"): (
        "from-bundle-auth-required",
        "from-bundle-rate-limit",
        "bundle-symlink-rejected",
        "bundle-traversal-rejected",
        "bundle-nested-traversal-rejected",
        "bundle-absolute-path-rejected",
    ),
    ("POST", "/workers/new/from-prompt"): (
        "new-from-prompt-auth-required",
        "new-from-prompt-body-limit",
    ),
    ("POST", "/uploads"): (
        "upload-auth-required",
        "upload-extension-media-rejected",
        "upload-null-byte-filename-rejected",
        "upload-dangerous-double-extension-rejected",
        "upload-path-traversal-filename-rejected",
        "local-upload-content-type-bypass-rejected",
    ),
    ("GET", "/uploads/{file_id}"): (
        "upload-url-present-and-downloadable",
        "upload-download-requires-signed-token",
        "local-upload-download-user-bound",
        "local-upload-token-expiration-enforced",
        "local-upload-token-cross-file-rejected",
    ),
    ("GET", "/connections"): ("local-connections-scoped",),
    ("POST", "/connections"): ("connections-init-auth-required",),
    ("GET", "/connections/{connection_id}/account-info"): ("local-connections-scoped",),
    ("GET", "/connections/{connection_id}/status"): ("local-connections-scoped",),
    ("POST", "/connections/{connection_id}/test"): ("local-connections-scoped",),
    ("DELETE", "/connections/{connection_id}"): ("local-connections-scoped",),
    ("GET", "/connections/auth-configs/{auth_config_id}"): ("auth-config-endpoint-auth-required",),
    ("GET", "/connections/callback"): ("connections-callback-fixed-redirect",),
    ("POST", "/connections/mcp"): ("connections-mcp-auth-and-validation",),
    ("POST", "/composio-events"): (
        "composio-events-invalid-signature-rejected",
        "local-composio-events-replay-blocked",
    ),
    ("POST", "/webhooks/composio-events"): (
        "composio-events-invalid-signature-rejected",
        "local-composio-events-replay-blocked",
    ),
    ("GET", "/system/metrics"): (
        "system-metrics-no-identifier-leaks",
        "system-metrics-auth-required",
        "local-system-metrics-overview-scoped",
    ),
    ("GET", "/system/overview"): (
        "system-overview-auth-required",
        "local-system-metrics-overview-scoped",
    ),
    ("GET", "/system/platform-config"): (
        "system-endpoints-require-auth",
        "system-platform-config-redacted",
    ),
    ("GET", "/system/info"): (
        "system-endpoints-require-auth",
        "system-info-no-pydantic-leak",
    ),
    ("POST", "/system/sweep-connections"): (
        "sweep-connections-cooldown",
        "local-sweep-connections-user-scoped",
    ),
    ("GET", "/secrets"): ("local-secrets-scoped",),
    ("POST", "/secrets/{name}"): ("local-secrets-scoped",),
    ("DELETE", "/secrets/{name}"): ("local-secrets-scoped",),
    ("POST", "/secrets/{name}/test"): (
        "secret-test-no-platform-enumeration",
        "local-secrets-scoped",
    ),
    ("POST", "/workers/{worker_id}/webhook-secret/rotate"): (
        "stock-worker-webhook-secret-rotate-blocked",
        "local-foreign-webhook-rotate-blocked",
    ),
    ("POST", "/cli-auth/approve"): ("local-cli-auth-approve-user-bound",),
    ("POST", "/cli-auth/deny"): (
        "cli-auth-denied-state-not-enumerable",
        "local-cli-auth-deny-user-bound",
    ),
    ("POST", "/cli-auth/devices"): (
        "cli-auth-denied-state-not-enumerable",
        "cli-auth-device-rate-limit",
    ),
    ("GET", "/cli-auth/poll/{device_code}"): (
        "cli-auth-denied-state-not-enumerable",
        "local-cli-auth-deny-user-bound",
    ),
    ("GET", "/webhooks/oauth-callback"): ("webhooks-oauth-callback-fixed-redirect",),
    ("POST", "/webhooks/{worker_id}"): ("webhook-trigger-auth-required",),
}


def route_coverage_hints(method: str, path: str) -> tuple[str, ...]:
    return ROUTE_COVERAGE_HINTS.get((method, path), ())


def make_worker_yml(name: str, *, trigger_type: str = "manual") -> str:
    if trigger_type == "webhook":
        trigger_block = """
trigger:
  type: webhook
  webhook:
    secret: true
""".strip()
    else:
        trigger_block = f"""
trigger:
  type: {trigger_type}
""".strip()
    return f'''schema_version: "0.3"
name: {name}
title: "Audit Probe {name}"
description: "Temporary audit worker. Safe to delete."
version: "0.1.0"
targets: [generic]
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs: []
  outputs: []
{trigger_block}
'''


def symlink_zip(name: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("worker.yml", make_worker_yml(name))
        info = zipfile.ZipInfo("linked")
        info.external_attr = (0o120777 << 16)
        zf.writestr(info, "target")
    return buf.getvalue()


def traversal_zip(name: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("worker.yml", make_worker_yml(name))
        zf.writestr("../escape.txt", "x")
    return buf.getvalue()


def nested_traversal_zip(name: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("worker.yml", make_worker_yml(name))
        zf.writestr("nested/../../../../etc/passwd", "x")
    return buf.getvalue()


def absolute_path_zip(name: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("worker.yml", make_worker_yml(name))
        zf.writestr("/tmp/workeros-escape.txt", "x")
    return buf.getvalue()


def _local_headers(secret: str, user_id: str) -> dict[str, str]:
    return {"x-floom-secret": secret, "x-floom-user": user_id}


def _local_worker_payload(
    name: str,
    *,
    title: str,
    trigger_type: str = "manual",
    connection_id: str = "conn_local_probe",
    contexts: list[str] | None = None,
) -> dict[str, str]:
    if trigger_type == "webhook":
        trigger_block = """
trigger:
  type: webhook
  webhook:
    secret: true
""".strip()
    elif trigger_type == "composio":
        trigger_block = f"""
trigger:
  type: composio
  composio:
    event: "GMAIL_NEW_EMAIL"
    connection_id: "{connection_id}"
    filters: {{}}
""".strip()
    else:
        trigger_block = """
trigger:
  type: manual
""".strip()
    contexts_block = ""
    if contexts:
        contexts_block = "contexts:\n" + "\n".join(
            f'  - "{context_name}"' for context_name in contexts
        ) + "\n"
    return {
        "worker_yml": f"""schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "local audit worker"
version: "0.1.0"
targets: [generic]
{contexts_block}exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs: []
  outputs: []
{trigger_block}
""",
        "run_py": (
            "def run(inputs, context):\n"
            "    return {'status': 'success', 'outputs': {'ok': True}, 'artifacts': []}\n"
        ),
    }


def _local_file_input_worker_payload(name: str, *, title: str) -> dict[str, str]:
    return {
        "worker_yml": f"""schema_version: "0.3"
name: "{name}"
title: "{title}"
description: "local audit file-input worker"
version: "0.1.0"
targets: [generic]
exec:
  entry: "run.py"
  runtime: "python311"
  runner: "e2b"
  command: "python run.py"
  inputs:
    - name: "upload"
      kind: "file"
      media_type: "text/plain"
      required: true
  outputs: []
trigger:
  type: manual
""",
        "run_py": (
            "def run(inputs, context):\n"
            "    return {'status': 'success', 'outputs': {'ok': True}, 'artifacts': []}\n"
        ),
    }


def _local_signed_composio_headers(body: bytes, signing_key: str) -> dict[str, str]:
    delivery_id = "msg_local_probe"
    timestamp = str(int(time.time()))
    signing_string = f"{delivery_id}.{timestamp}.{body.decode('utf-8')}".encode()
    signature = base64.b64encode(
        hmac.new(signing_key.encode(), signing_string, hashlib.sha256).digest()
    ).decode()
    return {
        "webhook-id": delivery_id,
        "webhook-timestamp": timestamp,
        "webhook-signature": f"v1,{signature}",
        "Content-Type": "application/json",
    }


def _local_insert_connection(main_module: Any, *, user_id: str, app_name: str = "gmail") -> str:
    local_id = f"local_{uuid.uuid4().hex}"
    now = main_module.now_iso()
    with main_module.get_db() as conn:
        conn.execute(
            """
            INSERT INTO composio_connections
                (id, app_name, composio_connection_id, status, created_at, updated_at, user_id)
            VALUES (?, ?, ?, 'active', ?, ?, ?)
            """,
            (
                local_id,
                app_name,
                f"ca_{uuid.uuid4().hex}",
                now,
                now,
                user_id,
            ),
        )
    return local_id


def _tracked_worker_ids(repo: Path) -> set[str]:
    try:
        tracked = subprocess.run(
            ["git", "-C", str(repo), "ls-files", "workers/*/worker.yml"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        tracked = None
    else:
        tracked_ids = {
            Path(line.strip()).parent.name
            for line in tracked.stdout.splitlines()
            if line.strip().endswith("/worker.yml")
        }
        if tracked_ids:
            return tracked_ids

    workers_dir = repo / "workers"
    tracked_ids: set[str] = set()
    for worker_yml in workers_dir.glob("*/worker.yml"):
        if worker_yml.is_file():
            tracked_ids.add(worker_yml.parent.name)
    return tracked_ids


def _local_seed_run_surfaces(main_module: Any, base_dir: Path, *, run_id: str) -> str:
    artifact_id = f"artifact_{uuid.uuid4().hex}"
    artifacts_dir = base_dir / "artifacts"
    artifacts_dir.mkdir(exist_ok=True)
    artifact_path = artifacts_dir / f"{artifact_id}.txt"
    artifact_path.write_text("artifact body")

    bundle_dir = base_dir / "run-bundles" / run_id
    bundle_dir.mkdir(parents=True, exist_ok=True)
    (bundle_dir / "worker.yml").write_text("name: seeded\n")

    with main_module.get_db() as conn:
        conn.execute(
            """
            INSERT INTO logs (run_id, level, message, timestamp, trace_id)
            VALUES (?, 'info', 'scoped log', ?, 'trace_scope')
            """,
            (run_id, main_module.now_iso()),
        )
        conn.execute(
            """
            INSERT INTO artifacts (id, run_id, name, type, path, size_bytes, created_at)
            VALUES (?, ?, 'result.txt', 'file', ?, ?, ?)
            """,
            (
                artifact_id,
                run_id,
                str(artifact_path),
                artifact_path.stat().st_size,
                main_module.now_iso(),
            ),
        )
        conn.execute(
            "UPDATE runs SET bundle_snapshot_path = ? WHERE id = ?",
            (f"run-bundles/{run_id}", run_id),
        )
    return artifact_id


def _restore_env(snapshot: dict[str, str | None], removed: tuple[str, ...]) -> None:
    for key, previous in snapshot.items():
        if previous is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = previous
    for key in removed:
        os.environ.pop(key, None)


def _reset_local_api_modules() -> None:
    reset_prefixes = ("auth.", "db.")
    reset_exact = {
        "main",
        "auth",
        "chat_service",
        "contexts",
        "db",
        "files",
        "models",
        "worker_registry",
        "run_service",
        "composio_client",
        "scheduler",
    }
    for name in list(sys.modules):
        if name in reset_exact or name.startswith(reset_prefixes):
            sys.modules.pop(name, None)


def run_local_probe_matrix(repo: Path) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    env_keys = {
        "FLOOM_DB": None,
        "FLOOM_WORKERS_DIR": None,
        "FLOOM_ARTIFACTS_DIR": None,
        "FLOOM_BLOBS_DIR": None,
        "FLOOM_CONTEXTS_DIR": None,
        "FLOOM_SECRET": None,
        "OPENAI_API_KEY": None,
        "COMPOSIO_API_KEY": None,
        "COMPOSIO_WEBHOOK_SIGNING_KEY": None,
        "COMPOSIO_WEBHOOK_URL": None,
        "WORKEROS_ENABLE_USER_HEADER_SCOPE": None,
        "WORKEROS_USER_ID": None,
    }
    env_snapshot = {key: os.environ.get(key) for key in env_keys}
    removed_keys = ("ALLOWED_ORIGINS", "ALLOWED_ORIGIN_REGEX", "WORKEROS_DEV")
    removed_snapshot = {key: os.environ.get(key) for key in removed_keys}
    local_secret = "local-audit-secret"

    try:
        with tempfile.TemporaryDirectory(prefix="workeros-kimi-local-") as tmp_dir_str:
            tmp_dir = Path(tmp_dir_str)
            workers_dir = tmp_dir / "workers"
            workers_dir.mkdir()
            contexts_dir = tmp_dir / "contexts"
            contexts_dir.mkdir()
            for worker_id in ("research_brief", "linkedin-post-engagements"):
                shutil.copytree(repo / "workers" / worker_id, workers_dir / worker_id)

            os.environ["FLOOM_DB"] = str(tmp_dir / "floom.db")
            os.environ["FLOOM_WORKERS_DIR"] = str(workers_dir)
            os.environ["FLOOM_ARTIFACTS_DIR"] = str(tmp_dir / "artifacts")
            os.environ["FLOOM_BLOBS_DIR"] = str(tmp_dir / "blobs")
            os.environ["FLOOM_CONTEXTS_DIR"] = str(contexts_dir)
            os.environ["FLOOM_SECRET"] = local_secret
            os.environ["OPENAI_API_KEY"] = "sk-local-audit"
            os.environ["COMPOSIO_API_KEY"] = "cmp-local-audit"
            os.environ["COMPOSIO_WEBHOOK_SIGNING_KEY"] = "whsec-local-audit"
            os.environ["COMPOSIO_WEBHOOK_URL"] = "https://example.test/composio-events"
            os.environ["WORKEROS_ENABLE_USER_HEADER_SCOPE"] = "1"
            os.environ["WORKEROS_USER_ID"] = "user-a"
            for key in removed_keys:
                os.environ.pop(key, None)

            api_dir = repo / "apps" / "api"
            if str(api_dir) not in sys.path:
                sys.path.insert(0, str(api_dir))

            _reset_local_api_modules()
            sys.modules["scheduler"] = types.SimpleNamespace(
                start_scheduler=lambda: None,
                stop_scheduler=lambda: None,
            )
            main_module = importlib.import_module("main")
            run_service_module = importlib.import_module("run_service")
            chat_service_module = importlib.import_module("chat_service")
            run_service_module.register_sse_publisher(main_module._sse_publish)
            run_service_module.register_part_publisher(main_module._run_part_publish)
            from fastapi.testclient import TestClient

            client = TestClient(main_module.app)
            main_module.start_run = lambda *args, **kwargs: None
            main_module._rate_buckets.clear()
            chat_service_module.WORKSPACE_MD_PATH = tmp_dir / "workspace.md"
            chat_service_module.WORKSPACE_MD_TEMPLATE = tmp_dir / "workspace.md.template"
            chat_service_module.WORKSPACE_MD_TEMPLATE.write_text("# Workspace\n\nTemplate workspace.\n")

            user_a = _local_headers(local_secret, "user-a")
            user_b = _local_headers(local_secret, "user-b")
            cli_owner_headers = _local_headers(local_secret, main_module._bootstrap_user_id())

            def _insert_local_run(
                worker_id: str,
                *,
                status: str = "running",
                user_id: str = "user-a",
                input_payload: Optional[Dict[str, Any]] = None,
                output_payload: Optional[Dict[str, Any]] = None,
            ) -> str:
                run_id = f"run_{uuid.uuid4().hex[:12]}"
                with main_module.get_db() as conn:
                    conn.execute(
                        """
                        INSERT INTO runs
                            (id, worker_id, status, trigger_source, runner, input_json, output_json, created_at)
                        VALUES (?, ?, ?, 'manual', 'skill', ?, ?, ?)
                        """,
                        (
                            run_id,
                            worker_id,
                            status,
                            json.dumps(input_payload or {}),
                            json.dumps(output_payload or {}),
                            main_module.now_iso(),
                        ),
                    )
                return run_id

            def _insert_pending_approval_run(worker_id: str, *, user_id: str = "user-a") -> str:
                run_id = f"run_{uuid.uuid4().hex[:12]}"
                approval_id = f"approval_{uuid.uuid4().hex[:12]}"
                now = main_module.now_iso()
                decision_input = {"prospect_name": "Acme Corp"}
                with main_module.get_db() as conn:
                    conn.execute(
                        """
                        INSERT INTO runs
                            (id, worker_id, status, trigger_source, runner, input_json, output_json,
                             approval_status, created_at)
                        VALUES (?, ?, 'pending_approval', 'manual', 'skill', ?, ?, 'pending', ?)
                        """,
                        (
                            run_id,
                            worker_id,
                            json.dumps(decision_input),
                            json.dumps({"text": "draft outbound"}),
                            now,
                        ),
                    )
                    conn.execute(
                        """
                        INSERT INTO approvals
                            (id, run_id, worker_id, status, label, preview, created_at,
                             decision_input_json, owner_id)
                        VALUES (?, ?, ?, 'pending', 'Approve output', 'preview', ?, ?, ?)
                        """,
                        (
                            approval_id,
                            run_id,
                            worker_id,
                            now,
                            json.dumps(decision_input),
                            user_id,
                        ),
                    )
                return run_id

            def _stream_sse_body(path: str, headers: dict[str, str]) -> tuple[int, str]:
                lines: list[str] = []
                with client.stream("GET", path, headers=headers) as response:
                    for line in response.iter_lines():
                        lines.append(line)
                        if not line.startswith("data:"):
                            continue
                        payload_text = line[5:].strip()
                        try:
                            payload = json.loads(payload_text)
                        except Exception:
                            payload = None
                        if path.endswith("/events") and isinstance(payload, dict):
                            event_type = str(payload.get("type") or "")
                            event_status = str(payload.get("status") or "")
                            if event_type == "close" or event_status in {
                                main_module.RunStatus.COMPLETED.value,
                                main_module.RunStatus.FAILED.value,
                            }:
                                break
                        if path.endswith("/stream") and isinstance(payload, dict):
                            if str(payload.get("type") or "") == "finish":
                                break
                    return response.status_code, "\n".join(lines)

            def _stream_chat_body(
                headers: dict[str, str],
                *,
                message: str,
                conversation_id: str | None = None,
            ) -> tuple[int, str, dict[str, Any] | None]:
                payload = {"message": message}
                if conversation_id:
                    payload["conversation_id"] = conversation_id
                lines: list[str] = []
                finish_event: dict[str, Any] | None = None
                with client.stream("POST", "/chat", headers=headers, json=payload) as response:
                    for line in response.iter_lines():
                        lines.append(line)
                        if not line.startswith("data:"):
                            continue
                        payload_text = line[5:].strip()
                        try:
                            part = json.loads(payload_text)
                        except Exception:
                            continue
                        if isinstance(part, dict) and part.get("type") == "finish":
                            finish_event = part
                            break
                return response.status_code, "\n".join(lines), finish_event

            local_health = client.get("/health")
            record(
                results,
                "local-health",
                local_health.status_code == 200,
                f"status={local_health.status_code}",
                {"status": local_health.status_code, "body": local_health.text},
            )

            workspace_empty = client.put("/workspace", headers=user_a, content=b"   ")
            workspace_put = client.put(
                "/workspace",
                headers={**user_a, "content-type": "text/markdown; charset=utf-8"},
                content=b"# Audit Workspace\n\nOwner-managed content.\n",
            )
            workspace_owner = client.get("/workspace", headers=user_a)
            workspace_foreign = client.get("/workspace", headers=user_b)
            record(
                results,
                "local-workspace-roundtrip",
                workspace_empty.status_code == 400
                and workspace_put.status_code == 204
                and workspace_owner.status_code == 200
                and "# Audit Workspace" in workspace_owner.text
                and workspace_foreign.status_code == 200
                and workspace_owner.text == workspace_foreign.text,
                (
                    f"empty={workspace_empty.status_code} put={workspace_put.status_code} "
                    f"owner={workspace_owner.status_code} foreign={workspace_foreign.status_code}"
                ),
                {
                    "empty": {"status": workspace_empty.status_code, "body": workspace_empty.text},
                    "put": {"status": workspace_put.status_code, "body": workspace_put.text},
                    "owner": {"status": workspace_owner.status_code, "body": workspace_owner.text},
                    "foreign": {"status": workspace_foreign.status_code, "body": workspace_foreign.text},
                },
            )

            async def _chat_stream_stub(
                *,
                message: str,
                user_id: str,
                conversation_id: str | None,
                part_queue: Any,
            ) -> None:
                resolved_conversation_id = conversation_id
                if resolved_conversation_id:
                    existing = chat_service_module.get_conversation(resolved_conversation_id, user_id)
                    if not existing:
                        resolved_conversation_id = None
                if not resolved_conversation_id:
                    resolved_conversation_id = chat_service_module.create_conversation(
                        user_id,
                        title=message[:60],
                    )
                chat_service_module.insert_message(resolved_conversation_id, "user", message)
                message_id = chat_service_module.insert_message(
                    resolved_conversation_id,
                    "assistant",
                    f"stub reply: {message}",
                )
                await part_queue.put({"type": "text", "text": f"stub reply: {message}"})
                await part_queue.put(
                    {
                        "type": "finish",
                        "conversation_id": resolved_conversation_id,
                        "message_id": message_id,
                    }
                )

            chat_service_module.stream_chat = _chat_stream_stub
            chat_empty_local = client.post("/chat", headers=user_a, json={"message": "   "})
            chat_status, _chat_body, chat_finish = _stream_chat_body(user_a, message="audit chat scoped")
            chat_conversation_id = str((chat_finish or {}).get("conversation_id") or "")
            owner_conversations = client.get("/conversations", headers=user_a)
            foreign_conversations = client.get("/conversations", headers=user_b)
            owner_conversation_detail = (
                client.get(f"/conversations/{chat_conversation_id}", headers=user_a)
                if chat_conversation_id
                else None
            )
            foreign_conversation_detail = (
                client.get(f"/conversations/{chat_conversation_id}", headers=user_b)
                if chat_conversation_id
                else None
            )
            owner_conversation_ids = {
                item.get("id")
                for item in (owner_conversations.json() if owner_conversations.status_code == 200 else [])
                if isinstance(item, dict)
            }
            foreign_conversation_ids = {
                item.get("id")
                for item in (foreign_conversations.json() if foreign_conversations.status_code == 200 else [])
                if isinstance(item, dict)
            }
            owner_messages = []
            if owner_conversation_detail is not None and owner_conversation_detail.status_code == 200:
                owner_messages = owner_conversation_detail.json().get("messages") or []
            foreign_chat_status = None
            foreign_chat_finish = None
            if chat_conversation_id:
                foreign_chat_status, _foreign_chat_body, foreign_chat_finish = _stream_chat_body(
                    user_b,
                    message="foreign conversation probe",
                    conversation_id=chat_conversation_id,
                )
            record(
                results,
                "local-chat-conversations-scoped",
                chat_empty_local.status_code == 400
                and chat_status == 200
                and bool(chat_conversation_id)
                and owner_conversations.status_code == 200
                and foreign_conversations.status_code == 200
                and chat_conversation_id in owner_conversation_ids
                and chat_conversation_id not in foreign_conversation_ids
                and owner_conversation_detail is not None
                and owner_conversation_detail.status_code == 200
                and foreign_conversation_detail is not None
                and foreign_conversation_detail.status_code == 404
                and len(owner_messages) >= 2,
                (
                    f"empty={chat_empty_local.status_code} chat={chat_status} conv_id={chat_conversation_id!r} "
                    f"owner={owner_conversation_detail.status_code if owner_conversation_detail else None} "
                    f"foreign={foreign_conversation_detail.status_code if foreign_conversation_detail else None}"
                ),
                {
                    "empty": {"status": chat_empty_local.status_code, "body": chat_empty_local.text},
                    "chat_finish": chat_finish,
                    "owner_list": {
                        "status": owner_conversations.status_code,
                        "ids": sorted(str(item) for item in owner_conversation_ids if item),
                    },
                    "foreign_list": {
                        "status": foreign_conversations.status_code,
                        "ids": sorted(str(item) for item in foreign_conversation_ids if item),
                    },
                    "owner_detail": (
                        {
                            "status": owner_conversation_detail.status_code,
                            "messages": owner_messages,
                        }
                        if owner_conversation_detail is not None
                        else {}
                    ),
                    "foreign_detail": (
                        {
                            "status": foreign_conversation_detail.status_code,
                            "body": foreign_conversation_detail.text,
                        }
                        if foreign_conversation_detail is not None
                        else {}
                    ),
                },
            )
            record(
                results,
                "local-conversations-list-scoped",
                owner_conversations.status_code == 200
                and foreign_conversations.status_code == 200
                and chat_conversation_id in owner_conversation_ids
                and chat_conversation_id not in foreign_conversation_ids,
                (
                    f"owner={owner_conversations.status_code} foreign={foreign_conversations.status_code} "
                    f"conv_id={chat_conversation_id!r}"
                ),
                {
                    "owner_list": {"status": owner_conversations.status_code, "body": owner_conversations.text},
                    "foreign_list": {"status": foreign_conversations.status_code, "body": foreign_conversations.text},
                },
            )
            record(
                results,
                "local-conversations-list-no-leak",
                owner_conversations.status_code == 200
                and foreign_conversations.status_code == 200
                and chat_conversation_id not in foreign_conversations.text
                and "audit chat scoped" not in foreign_conversations.text,
                f"foreign={foreign_conversations.status_code}",
                {"status": foreign_conversations.status_code, "body": foreign_conversations.text},
            )
            record(
                results,
                "local-chat-foreign-conversation-detached",
                bool(chat_conversation_id)
                and foreign_chat_status == 200
                and isinstance(foreign_chat_finish, dict)
                and str(foreign_chat_finish.get("conversation_id") or "") not in ("", chat_conversation_id),
                (
                    f"status={foreign_chat_status} "
                    f"foreign_conv={str((foreign_chat_finish or {}).get('conversation_id') or '')!r}"
                ),
                {"status": foreign_chat_status, "finish": foreign_chat_finish},
            )

            chat_oversized_local = client.post("/chat", headers=user_a, json={"message": "x" * 20001})
            record(
                results,
                "local-chat-message-length-limit",
                chat_oversized_local.status_code == 413
                and "character limit" in chat_oversized_local.text.lower(),
                f"status={chat_oversized_local.status_code}",
                {"status": chat_oversized_local.status_code, "body": chat_oversized_local.text},
            )

            approval_created = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload("approval-probe", title="Approval Probe"),
            )
            approve_run_id = ""
            reject_run_id = ""
            foreign_approve = owner_approve = approve_replay = None
            foreign_reject = owner_reject = reject_replay = None
            if approval_created.status_code == 200:
                approve_run_id = _insert_pending_approval_run("approval-probe", user_id="user-a")
                reject_run_id = _insert_pending_approval_run("approval-probe", user_id="user-a")
                foreign_approve = client.post(f"/runs/{approve_run_id}/approve", headers=user_b)
                owner_approve = client.post(f"/runs/{approve_run_id}/approve", headers=user_a)
                approve_replay = client.post(f"/runs/{approve_run_id}/approve", headers=user_a)
                foreign_reject = client.post(
                    f"/runs/{reject_run_id}/reject",
                    headers=user_b,
                    json={"reason": "foreign"},
                )
                owner_reject = client.post(
                    f"/runs/{reject_run_id}/reject",
                    headers=user_a,
                    json={"reason": "owner"},
                )
                reject_replay = client.post(
                    f"/runs/{reject_run_id}/reject",
                    headers=user_a,
                    json={"reason": "repeat"},
                )
            record(
                results,
                "local-approval-routes-scoped",
                approval_created.status_code == 200
                and bool(approve_run_id)
                and bool(reject_run_id)
                and foreign_approve is not None
                and foreign_approve.status_code == 404
                and owner_approve is not None
                and owner_approve.status_code == 200
                and approve_replay is not None
                and approve_replay.status_code == 409
                and foreign_reject is not None
                and foreign_reject.status_code == 404
                and owner_reject is not None
                and owner_reject.status_code == 200
                and reject_replay is not None
                and reject_replay.status_code == 409,
                (
                    f"create={approval_created.status_code} foreign_approve={foreign_approve.status_code if foreign_approve else None} "
                    f"owner_approve={owner_approve.status_code if owner_approve else None} "
                    f"approve_replay={approve_replay.status_code if approve_replay else None} "
                    f"foreign_reject={foreign_reject.status_code if foreign_reject else None} "
                    f"owner_reject={owner_reject.status_code if owner_reject else None} "
                    f"reject_replay={reject_replay.status_code if reject_replay else None}"
                ),
                {
                    "create": {"status": approval_created.status_code, "body": approval_created.text},
                    "approve_run_id": approve_run_id,
                    "reject_run_id": reject_run_id,
                    "foreign_approve": (
                        {"status": foreign_approve.status_code, "body": foreign_approve.text}
                        if foreign_approve is not None
                        else {}
                    ),
                    "owner_approve": (
                        {"status": owner_approve.status_code, "body": owner_approve.text}
                        if owner_approve is not None
                        else {}
                    ),
                    "approve_replay": (
                        {"status": approve_replay.status_code, "body": approve_replay.text}
                        if approve_replay is not None
                        else {}
                    ),
                    "foreign_reject": (
                        {"status": foreign_reject.status_code, "body": foreign_reject.text}
                        if foreign_reject is not None
                        else {}
                    ),
                    "owner_reject": (
                        {"status": owner_reject.status_code, "body": owner_reject.text}
                        if owner_reject is not None
                        else {}
                    ),
                    "reject_replay": (
                        {"status": reject_replay.status_code, "body": reject_replay.text}
                        if reject_replay is not None
                        else {}
                    ),
                },
            )

            restore_created = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload("restore-probe", title="Restore Probe"),
            )
            restore_foreign = restore_owner = restore_stock = None
            restore_path = workers_dir / "restore-probe" / "worker.yml"
            if restore_created.status_code == 200:
                restore_path.write_text(restore_path.read_text() + "\narchived: true\narchive_reason: local-audit\n")
                restore_foreign = client.post("/workers/restore-probe/restore", headers=user_b)
                restore_owner = client.post("/workers/restore-probe/restore", headers=user_a)
                restore_stock = client.post("/workers/research_brief/restore", headers=user_a)
            record(
                results,
                "local-worker-restore-scoped",
                restore_created.status_code == 200
                and restore_foreign is not None
                and restore_foreign.status_code == 404
                and restore_owner is not None
                and restore_owner.status_code == 200
                and restore_stock is not None
                and restore_stock.status_code == 403
                and "archived: true" not in restore_path.read_text(),
                (
                    f"create={restore_created.status_code} foreign={restore_foreign.status_code if restore_foreign else None} "
                    f"owner={restore_owner.status_code if restore_owner else None} "
                    f"stock={restore_stock.status_code if restore_stock else None}"
                ),
                {
                    "create": {"status": restore_created.status_code, "body": restore_created.text},
                    "foreign": (
                        {"status": restore_foreign.status_code, "body": restore_foreign.text}
                        if restore_foreign is not None
                        else {}
                    ),
                    "owner": (
                        {"status": restore_owner.status_code, "body": restore_owner.text}
                        if restore_owner is not None
                        else {}
                    ),
                    "stock": (
                        {"status": restore_stock.status_code, "body": restore_stock.text}
                        if restore_stock is not None
                        else {}
                    ),
                    "worker_yml": restore_path.read_text() if restore_path.exists() else "",
                },
            )
            record(
                results,
                "local-restore-stock-worker-blocked",
                restore_stock is not None and restore_stock.status_code == 403,
                f"status={restore_stock.status_code if restore_stock is not None else None}",
                {"status": restore_stock.status_code if restore_stock is not None else None, "body": restore_stock.text if restore_stock is not None else ""},
            )

            sample_created = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload("sample-probe", title="Sample Probe"),
            )
            owner_sample = foreign_sample = None
            if sample_created.status_code == 200:
                sample_inputs_dir = tmp_dir / "docs" / "workers" / "inputs"
                sample_inputs_dir.mkdir(parents=True, exist_ok=True)
                (sample_inputs_dir / "sample-probe.json").write_text(json.dumps({"topic": "launch"}))
                owner_sample = client.get("/workers/sample-probe/sample-input", headers=user_a)
                foreign_sample = client.get("/workers/sample-probe/sample-input", headers=user_b)
            record(
                results,
                "local-sample-input-scoped",
                sample_created.status_code == 200
                and owner_sample is not None
                and owner_sample.status_code == 200
                and owner_sample.json() == {"topic": "launch"}
                and foreign_sample is not None
                and foreign_sample.status_code == 404,
                (
                    f"create={sample_created.status_code} owner={owner_sample.status_code if owner_sample else None} "
                    f"foreign={foreign_sample.status_code if foreign_sample else None}"
                ),
                {
                    "create": {"status": sample_created.status_code, "body": sample_created.text},
                    "owner": (
                        {"status": owner_sample.status_code, "body": owner_sample.text}
                        if owner_sample is not None
                        else {}
                    ),
                    "foreign": (
                        {"status": foreign_sample.status_code, "body": foreign_sample.text}
                        if foreign_sample is not None
                        else {}
                    ),
                },
            )
            record(
                results,
                "local-sample-input-foreign-404",
                foreign_sample is not None and foreign_sample.status_code == 404,
                f"status={foreign_sample.status_code if foreign_sample is not None else None}",
                {"status": foreign_sample.status_code if foreign_sample is not None else None, "body": foreign_sample.text if foreign_sample is not None else ""},
            )

            draft_capture: dict[str, Any] = {}
            original_openai = sys.modules.get("openai")
            original_create_connection = socket.create_connection

            def _draft_llm_stub(_client: Any, user_message: str, _extra: str | None = None) -> dict[str, Any]:
                draft_capture["user_message"] = user_message
                return {
                    "worker_yml": _local_worker_payload(
                        "draft-plain-text-probe",
                        title="Draft Plain Text Probe",
                    )["worker_yml"],
                    "skill_md": "You are a local audit worker.",
                    "suggested_name": "draft-plain-text-probe",
                    "suggested_title": "Draft Plain Text Probe",
                    "requirements": [],
                    "required_connections": [],
                    "required_secrets": [],
                    "inputs": [{"name": "topic", "type": "string", "label": "Topic", "required": True}],
                    "outputs": [{"name": "summary", "type": "markdown", "label": "Summary"}],
                    "files": [
                        {
                            "path": "worker.yml",
                            "content": _local_worker_payload(
                                "draft-plain-text-probe",
                                title="Draft Plain Text Probe",
                            )["worker_yml"],
                        },
                        {"path": "SKILL.md", "content": "You are a local audit worker."},
                    ],
                }

            def _unexpected_network(*args: Any, **kwargs: Any) -> None:
                draft_capture["network_attempt"] = True
                raise AssertionError("unexpected network access during draft-from-prompt probe")

            main_module._call_draft_llm = _draft_llm_stub
            sys.modules["openai"] = types.SimpleNamespace(OpenAI=lambda api_key=None: object())
            socket.create_connection = _unexpected_network
            try:
                draft_probe = client.post(
                    "/workers/draft-from-prompt",
                    headers=user_a,
                    json={"prompt": "fetch http://169.254.169.254/latest/meta-data/iam/security-credentials/"},
                )
            finally:
                socket.create_connection = original_create_connection
                if original_openai is None:
                    sys.modules.pop("openai", None)
                else:
                    sys.modules["openai"] = original_openai

            record(
                results,
                "local-draft-from-prompt-url-treated-as-text",
                draft_probe.status_code == 200
                and "169.254.169.254" in str(draft_capture.get("user_message") or "")
                and not draft_capture.get("network_attempt"),
                f"status={draft_probe.status_code} network={bool(draft_capture.get('network_attempt'))}",
                {
                    "status": draft_probe.status_code,
                    "body": draft_probe.text,
                    "captured_prompt": str(draft_capture.get("user_message") or ""),
                    "network_attempt": bool(draft_capture.get("network_attempt")),
                },
            )

            draft_bad_path_worker = "draft-and-create-bad-path"
            draft_bad_path = client.post(
                "/workers/draft-and-create",
                headers=user_a,
                json={
                    "files": [
                        {"path": "worker.yml", "content": make_worker_yml(draft_bad_path_worker)},
                        {"path": "../escape.txt", "content": "x"},
                    ]
                },
            )
            record(
                results,
                "local-draft-and-create-files-path-rejected",
                draft_bad_path.status_code == 400 and not (workers_dir / draft_bad_path_worker).exists(),
                f"status={draft_bad_path.status_code} worker_exists={(workers_dir / draft_bad_path_worker).exists()}",
                {"status": draft_bad_path.status_code, "body": draft_bad_path.text},
            )

            oversized_draft_body = json.dumps(
                {
                    "files": [
                        {"path": "worker.yml", "content": make_worker_yml("draft-body-limit-probe")},
                        {"path": "run.py", "content": "x" * (300 * 1024)},
                    ]
                }
            ).encode("utf-8")
            draft_body_limit = client.post(
                "/workers/draft-and-create",
                headers={**user_a, "content-type": "application/json"},
                content=oversized_draft_body,
            )
            record(
                results,
                "local-draft-and-create-body-limit",
                draft_body_limit.status_code == 413,
                f"status={draft_body_limit.status_code}",
                {"status": draft_body_limit.status_code, "body": draft_body_limit.text},
            )

            draft_foreign_context = "draft-foreign-context"
            draft_foreign_context_create = client.post(
                f"/contexts/{draft_foreign_context}",
                headers=user_a,
                json={"writeable": True},
            )
            draft_foreign_worker = "draft-foreign-context-probe"
            draft_foreign_context_attempt = client.post(
                "/workers/draft-and-create",
                headers=user_b,
                json={
                    "files": [
                        {
                            "path": "worker.yml",
                            "content": _local_worker_payload(
                                draft_foreign_worker,
                                title="Draft Foreign Context Probe",
                                contexts=[draft_foreign_context],
                            )["worker_yml"],
                        },
                        {
                            "path": "run.py",
                            "content": _local_worker_payload(
                                draft_foreign_worker,
                                title="Draft Foreign Context Probe",
                                contexts=[draft_foreign_context],
                            )["run_py"],
                        },
                    ]
                },
            )
            draft_foreign_context_delete = client.delete(f"/contexts/{draft_foreign_context}", headers=user_a)
            record(
                results,
                "local-draft-and-create-foreign-context-rejected",
                draft_foreign_context_create.status_code == 200
                and draft_foreign_context_attempt.status_code == 400
                and not (workers_dir / draft_foreign_worker).exists()
                and draft_foreign_context_delete.status_code == 200,
                (
                    f"context_create={draft_foreign_context_create.status_code} "
                    f"draft={draft_foreign_context_attempt.status_code} "
                    f"context_delete={draft_foreign_context_delete.status_code}"
                ),
                {
                    "context_create": {
                        "status": draft_foreign_context_create.status_code,
                        "body": draft_foreign_context_create.text,
                    },
                    "draft": {
                        "status": draft_foreign_context_attempt.status_code,
                        "body": draft_foreign_context_attempt.text,
                    },
                    "context_delete": {
                        "status": draft_foreign_context_delete.status_code,
                        "body": draft_foreign_context_delete.text,
                    },
                },
            )

            tracked_worker_ids = _tracked_worker_ids(repo)
            protected = set(main_module.PROTECTED_STOCK_WORKER_IDS)
            on_disk_protected = {
                worker_id
                for worker_id in protected
                if (repo / "workers" / worker_id / "worker.yml").is_file()
            }
            missing_stock = sorted(protected - on_disk_protected)
            extra_stock = sorted(tracked_worker_ids - protected)
            record(
                results,
                "local-stock-worker-set-complete",
                not missing_stock and not extra_stock,
                f"missing={missing_stock} extra={extra_stock}",
                {
                    "missing": missing_stock,
                    "extra": extra_stock,
                    "tracked": sorted(tracked_worker_ids),
                    "protected": sorted(protected),
                },
            )

            stock_detail_local = client.get("/workers/research_brief", headers=user_a)
            stock_detail_local_ok = False
            stock_detail_local_body: dict[str, Any] = {}
            if stock_detail_local.status_code == 200:
                try:
                    parsed_stock_detail_local = stock_detail_local.json()
                except Exception:
                    parsed_stock_detail_local = None
                if isinstance(parsed_stock_detail_local, dict):
                    config_keys = set((parsed_stock_detail_local.get("config") or {}).keys())
                    file_paths = [
                        str(item.get("path"))
                        for item in (parsed_stock_detail_local.get("files") or [])
                        if isinstance(item, dict)
                    ]
                    stock_detail_local_body = {
                        "config_keys": sorted(config_keys),
                        "file_paths": file_paths[:20],
                        "new_webhook_secret": parsed_stock_detail_local.get("new_webhook_secret"),
                    }
                    stock_detail_local_ok = (
                        parsed_stock_detail_local.get("new_webhook_secret") in (None, "")
                        and not (config_keys & {"env", "webhook_secret", "source", "bundle_url"})
                        and ".env" not in file_paths
                    )
            record(
                results,
                "local-stock-worker-detail-no-secrets",
                stock_detail_local_ok,
                f"status={stock_detail_local.status_code}",
                stock_detail_local_body or {"status": stock_detail_local.status_code, "body": stock_detail_local.text},
            )

            stock_timeseries_owner = client.get("/workers/research_brief/runs/timeseries", headers=user_a)
            stock_timeseries_foreign = client.get("/workers/research_brief/runs/timeseries", headers=user_b)
            owner_totals: list[int] = []
            foreign_totals: list[int] = []
            if stock_timeseries_owner.status_code == 200:
                owner_totals = [
                    int(item.get("total") or 0)
                    for item in stock_timeseries_owner.json()
                    if isinstance(item, dict)
                ]
            if stock_timeseries_foreign.status_code == 200:
                foreign_totals = [
                    int(item.get("total") or 0)
                    for item in stock_timeseries_foreign.json()
                    if isinstance(item, dict)
                ]
            record(
                results,
                "local-stock-timeseries-zero-safe",
                stock_timeseries_owner.status_code == 200
                and stock_timeseries_foreign.status_code == 200
                and owner_totals == foreign_totals
                and all(total == 0 for total in owner_totals),
                (
                    f"owner={stock_timeseries_owner.status_code} foreign={stock_timeseries_foreign.status_code} "
                    f"owner_totals={owner_totals[:5]} foreign_totals={foreign_totals[:5]}"
                ),
                {
                    "owner": {"status": stock_timeseries_owner.status_code, "body": stock_timeseries_owner.text},
                    "foreign": {"status": stock_timeseries_foreign.status_code, "body": stock_timeseries_foreign.text},
                },
            )

            stock_payload = _local_worker_payload("linkedin-post-engagements", title="Probe Replacement")
            stock_files_payload = {
                "files": [
                    {"path": "worker.yml", "content": stock_payload["worker_yml"]},
                    {"path": "run.py", "content": stock_payload["run_py"]},
                ]
            }
            stock_delete = client.delete("/workers/linkedin-post-engagements", headers=user_a)
            stock_patch = client.patch(
                "/workers/linkedin-post-engagements",
                headers=user_a,
                json={"trigger_type": "manual"},
            )
            stock_put = client.put(
                "/workers/linkedin-post-engagements",
                headers=user_a,
                json=stock_payload,
            )
            stock_put_files = client.put(
                "/workers/linkedin-post-engagements/files",
                headers=user_a,
                json=stock_files_payload,
            )
            record(
                results,
                "local-stock-worker-mutations-blocked",
                all(resp.status_code == 403 for resp in (stock_delete, stock_patch, stock_put, stock_put_files)),
                (
                    f"delete={stock_delete.status_code} patch={stock_patch.status_code} "
                    f"put={stock_put.status_code} files={stock_put_files.status_code}"
                ),
                {
                    "delete": {"status": stock_delete.status_code, "body": stock_delete.text},
                    "patch": {"status": stock_patch.status_code, "body": stock_patch.text},
                    "put": {"status": stock_put.status_code, "body": stock_put.text},
                    "put_files": {"status": stock_put_files.status_code, "body": stock_put_files.text},
                },
            )

            shared_worker = "shared-probe"
            shared_payload = _local_worker_payload(shared_worker, title="Shared Probe")
            created = client.post("/workers", headers=user_a, json=shared_payload)
            list_a = client.get("/workers", headers=user_a)
            list_b = client.get("/workers", headers=user_b)
            owner_ids = {item.get("id") for item in (list_a.json() if list_a.status_code == 200 else [])}
            foreign_ids = {item.get("id") for item in (list_b.json() if list_b.status_code == 200 else [])}
            record(
                results,
                "local-foreign-custom-worker-hidden",
                created.status_code == 200
                and list_a.status_code == 200
                and list_b.status_code == 200
                and {"research_brief", shared_worker} <= owner_ids
                and "research_brief" in foreign_ids
                and shared_worker not in foreign_ids,
                f"create={created.status_code} owner_ids={sorted(owner_ids)} foreign_ids={sorted(foreign_ids)}",
                {
                    "create": {"status": created.status_code, "body": created.text},
                    "owner_list": {"status": list_a.status_code, "ids": sorted(owner_ids)},
                    "foreign_list": {"status": list_b.status_code, "ids": sorted(foreign_ids)},
                },
            )

            owner_mass_create = client.post(
                "/workers",
                headers=user_a,
                json={**_local_worker_payload("mass-owner-create", title="Mass Owner Create"), "owner_id": "user-b"},
            )
            owner_mass_created = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload("mass-owner-update", title="Mass Owner Update"),
            )
            owner_mass_patch = client.patch(
                "/workers/mass-owner-update",
                headers=user_a,
                json={"trigger_type": "manual", "owner_id": "user-b"},
            )
            owner_mass_put = client.put(
                "/workers/mass-owner-update",
                headers=user_a,
                json={**_local_worker_payload("mass-owner-update", title="Mass Owner Update"), "owner_id": "user-b"},
            )
            owner_mass_foreign = client.get("/workers/mass-owner-update", headers=user_b)
            owner_mass_row = None
            owner_mass_missing = None
            if owner_mass_created.status_code == 200:
                with main_module.get_db() as conn:
                    owner_mass_row = conn.execute(
                        "SELECT owner_id FROM workers WHERE id = ?",
                        ("mass-owner-update",),
                    ).fetchone()
                    owner_mass_missing = conn.execute(
                        "SELECT owner_id FROM workers WHERE id = ?",
                        ("mass-owner-create",),
                    ).fetchone()
            record(
                results,
                "local-worker-owner-mass-assignment-rejected",
                owner_mass_create.status_code == 422
                and owner_mass_created.status_code == 200
                and owner_mass_patch.status_code == 422
                and owner_mass_put.status_code == 422
                and owner_mass_foreign.status_code == 404
                and owner_mass_row is not None
                and owner_mass_row["owner_id"] == "user-a"
                and owner_mass_missing is None,
                (
                    f"create_extra={owner_mass_create.status_code} create_clean={owner_mass_created.status_code} "
                    f"patch_extra={owner_mass_patch.status_code} put_extra={owner_mass_put.status_code} "
                    f"foreign={owner_mass_foreign.status_code}"
                ),
                {
                    "create_extra": {"status": owner_mass_create.status_code, "body": owner_mass_create.text},
                    "create_clean": {"status": owner_mass_created.status_code, "body": owner_mass_created.text},
                    "patch_extra": {"status": owner_mass_patch.status_code, "body": owner_mass_patch.text},
                    "put_extra": {"status": owner_mass_put.status_code, "body": owner_mass_put.text},
                    "foreign_detail": {"status": owner_mass_foreign.status_code, "body": owner_mass_foreign.text},
                    "owner_id": owner_mass_row["owner_id"] if owner_mass_row is not None else None,
                },
            )

            owner_run = client.post(
                f"/workers/{shared_worker}/runs",
                headers=user_a,
                json={"inputs": {}, "trigger_source": "audit"},
            )
            run_id = ""
            if owner_run.status_code == 200:
                try:
                    run_id = str(owner_run.json().get("run_id") or "")
                except Exception:
                    run_id = ""
            overwrite_payload = _local_worker_payload(shared_worker, title="Overwritten Probe")
            overwrite_files_payload = {
                "files": [
                    {"path": "worker.yml", "content": overwrite_payload["worker_yml"]},
                    {"path": "run.py", "content": overwrite_payload["run_py"]},
                ]
            }
            foreign_worker_checks = {
                "detail": client.get(f"/workers/{shared_worker}", headers=user_b),
                "timeseries": client.get(f"/workers/{shared_worker}/runs/timeseries", headers=user_b),
                "patch": client.patch(
                    f"/workers/{shared_worker}",
                    headers=user_b,
                    json={"trigger_type": "manual"},
                ),
                "put": client.put(
                    f"/workers/{shared_worker}",
                    headers=user_b,
                    json=overwrite_payload,
                ),
                "put_files": client.put(
                    f"/workers/{shared_worker}/files",
                    headers=user_b,
                    json=overwrite_files_payload,
                ),
                "delete": client.delete(f"/workers/{shared_worker}", headers=user_b),
                "create_run": client.post(
                    f"/workers/{shared_worker}/runs",
                    headers=user_b,
                    json={"inputs": {}, "trigger_source": "audit"},
                ),
            }
            if run_id:
                foreign_worker_checks["replay"] = client.post(
                    f"/workers/{shared_worker}/runs/{run_id}/replay",
                    headers=user_b,
                )
                foreign_worker_checks["stream"] = client.get(f"/runs/{run_id}/stream", headers=user_b)
                foreign_worker_checks["events"] = client.get(f"/runs/{run_id}/events", headers=user_b)
                foreign_worker_checks["logs"] = client.get(f"/runs/{run_id}/logs", headers=user_b)
            foreign_worker_ok = created.status_code == 200 and owner_run.status_code == 200 and run_id
            foreign_worker_ok = bool(foreign_worker_ok) and all(
                response.status_code == 404 for response in foreign_worker_checks.values()
            )
            record(
                results,
                "local-foreign-custom-worker-routes-404",
                foreign_worker_ok,
                f"owner_run={owner_run.status_code} run_id={run_id!r}",
                {
                    "owner_run": {"status": owner_run.status_code, "body": owner_run.text},
                    "checks": {
                        name: {"status": response.status_code, "body": response.text}
                        for name, response in foreign_worker_checks.items()
                    },
                },
            )
            foreign_run_create_body = foreign_worker_checks["create_run"].text
            record(
                results,
                "local-run-create-404-no-secret-leak",
                foreign_worker_checks["create_run"].status_code == 404
                and all(
                    token not in foreign_run_create_body
                    for token in ("Missing secrets:", "API_KEY", "sk-", "BEGIN PRIVATE KEY", "trace_", "runner=e2b")
                ),
                f"status={foreign_worker_checks['create_run'].status_code}",
                {
                    "status": foreign_worker_checks["create_run"].status_code,
                    "body": foreign_run_create_body,
                },
            )
            owner_timeseries = client.get(f"/workers/{shared_worker}/runs/timeseries", headers=user_a)
            owner_timeseries_total = 0
            if owner_timeseries.status_code == 200:
                try:
                    owner_timeseries_total = sum(
                        int(item.get("total") or item.get("count") or 0)
                        for item in owner_timeseries.json()
                        if isinstance(item, dict)
                    )
                except Exception:
                    owner_timeseries_total = 0
            record(
                results,
                "local-foreign-timeseries-no-data-leak",
                owner_timeseries.status_code == 200
                and owner_timeseries_total >= 1
                and foreign_worker_checks["timeseries"].status_code == 404,
                (
                    f"owner={owner_timeseries.status_code} owner_total={owner_timeseries_total} "
                    f"foreign={foreign_worker_checks['timeseries'].status_code}"
                ),
                {
                    "owner_timeseries": {"status": owner_timeseries.status_code, "body": owner_timeseries.text},
                    "foreign_timeseries": {
                        "status": foreign_worker_checks["timeseries"].status_code,
                        "body": foreign_worker_checks["timeseries"].text,
                    },
                },
            )
            record(
                results,
                "local-foreign-worker-delete-404",
                created.status_code == 200 and foreign_worker_checks["delete"].status_code == 404,
                f"create={created.status_code} delete={foreign_worker_checks['delete'].status_code}",
                {
                    "create": {"status": created.status_code, "body": created.text},
                    "delete": {
                        "status": foreign_worker_checks["delete"].status_code,
                        "body": foreign_worker_checks["delete"].text,
                    },
                },
            )

            foreign_run_checks: dict[str, Any] = {}
            artifact_id = ""
            if run_id:
                artifact_id = _local_seed_run_surfaces(main_module, tmp_dir, run_id=run_id)
                foreign_run_checks = {
                    "detail": client.get(f"/runs/{run_id}", headers=user_b),
                    "download": client.get(f"/runs/{run_id}/download", headers=user_b),
                    "bundle": client.get(f"/runs/{run_id}/bundle/worker.yml", headers=user_b),
                    "artifact": client.get(
                        f"/runs/{run_id}/artifacts/{artifact_id}/download",
                        headers=user_b,
                    ),
                    "stream": client.get(f"/runs/{run_id}/stream", headers=user_b),
                    "events": client.get(f"/runs/{run_id}/events", headers=user_b),
                    "logs": client.get(f"/runs/{run_id}/logs", headers=user_b),
                    "cancel": client.post(f"/runs/{run_id}/cancel", headers=user_b),
                }
            record(
                results,
                "local-foreign-run-routes-404",
                bool(run_id)
                and bool(artifact_id)
                and all(response.status_code == 404 for response in foreign_run_checks.values()),
                f"run_id={run_id!r} artifact_id={artifact_id!r}",
                {
                    "checks": {
                        name: {"status": response.status_code, "body": response.text}
                        for name, response in foreign_run_checks.items()
                    },
                },
            )

            sensitive_tokens = (
                "trace_a2278662e7ae4e05",
                "\"trace_id\"",
                "mode=agent",
                "runner=e2b",
                "thread_a2278662e7ae4e05",
            )
            events_run_id = _insert_local_run(shared_worker, user_id="user-a", status="running")

            def _emit_events() -> None:
                time.sleep(0.05)
                run_service_module.add_log(
                    events_run_id,
                    "trace_a2278662e7ae4e05 mode=agent runner=e2b private log",
                    trace_id="trace_a2278662e7ae4e05",
                    user_id="user-a",
                )
                run_service_module.update_run_status(
                    events_run_id,
                    main_module.RunStatus.COMPLETED.value,
                    error="thread_a2278662e7ae4e05 runner=e2b",
                    user_id="user-a",
                )

            events_emitter = threading.Thread(target=_emit_events, daemon=True)
            events_emitter.start()
            events_status, events_body = _stream_sse_body(f"/runs/{events_run_id}/events", user_a)
            events_emitter.join(timeout=1)
            record(
                results,
                "local-run-events-no-sensitive-stream",
                events_status == 200
                and all(token not in events_body for token in sensitive_tokens)
                and "[redacted-id]" in events_body
                and "[redacted-metadata]" in events_body,
                f"status={events_status}",
                {"status": events_status, "body": events_body},
            )

            logs_resp = client.get(f"/runs/{events_run_id}/logs", headers=user_a)
            record(
                results,
                "run-logs-no-sensitive-leak",
                logs_resp.status_code == 200 and all(token not in logs_resp.text for token in sensitive_tokens),
                f"status={logs_resp.status_code}",
                {"status": logs_resp.status_code, "body": logs_resp.text},
            )

            stream_run_id = _insert_local_run(shared_worker, user_id="user-a", status="running")

            def _emit_parts() -> None:
                time.sleep(0.05)
                run_service_module.publish_run_part(stream_run_id, {"type": "step-start", "stepNumber": 1})
                run_service_module.publish_run_part(stream_run_id, {"type": "text", "text": "safe text"})
                run_service_module.publish_run_part(stream_run_id, {"type": "finish", "status": "completed"})

            stream_emitter = threading.Thread(target=_emit_parts, daemon=True)
            stream_emitter.start()
            stream_status, stream_body = _stream_sse_body(f"/runs/{stream_run_id}/stream", user_a)
            stream_emitter.join(timeout=1)
            record(
                results,
                "local-run-stream-no-sensitive-content",
                stream_status == 200 and all(token not in stream_body for token in sensitive_tokens),
                f"status={stream_status}",
                {"status": stream_status, "body": stream_body},
            )

            env_secret_run_id = _insert_local_run(shared_worker, user_id="user-a", status="queued")
            env_secret_error = "COMPOSIO_API_KEY not set"
            run_service_module.add_log(
                env_secret_run_id,
                env_secret_error,
                level="error",
                user_id="user-a",
            )
            run_service_module.update_run_status(
                env_secret_run_id,
                main_module.RunStatus.FAILED.value,
                error=env_secret_error,
                user_id="user-a",
            )
            env_list = client.get("/runs", headers=user_a)
            env_detail = client.get(f"/runs/{env_secret_run_id}", headers=user_a)
            env_logs = client.get(f"/runs/{env_secret_run_id}/logs", headers=user_a)
            env_stream = client.get(f"/runs/{env_secret_run_id}/stream", headers=user_a)
            env_events = client.get(f"/runs/{env_secret_run_id}/events", headers=user_a)
            env_expected = "Required platform secret is not configured"
            env_list_error = None
            try:
                env_list_error = next(
                    item.get("error")
                    for item in env_list.json()
                    if item.get("id") == env_secret_run_id
                )
            except Exception:
                env_list_error = None
            env_leak_tokens = ("COMPOSIO_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GMAIL_SERVICE_ACCOUNT_JSON")
            env_texts = [
                env_detail.text,
                env_logs.text,
                env_stream.text,
                env_events.text,
            ]
            record(
                results,
                "local-run-env-secret-error-redacted",
                env_list.status_code == 200
                and env_detail.status_code == 200
                and env_logs.status_code == 200
                and env_stream.status_code == 200
                and env_events.status_code == 200
                and env_list_error == env_expected
                and env_detail.json().get("error") == env_expected
                and bool(env_detail.json().get("logs"))
                and env_detail.json()["logs"][0].get("message") == env_expected
                and bool(env_logs.json())
                and env_logs.json()[0].get("message") == env_expected
                and env_expected in env_stream.text
                and env_expected in env_events.text
                and all(token not in text for token in env_leak_tokens for text in env_texts),
                (
                    f"list={env_list.status_code} detail={env_detail.status_code} logs={env_logs.status_code} "
                    f"stream={env_stream.status_code} events={env_events.status_code}"
                ),
                {
                    "list_status": env_list.status_code,
                    "list_error": env_list_error,
                    "detail": {"status": env_detail.status_code, "body": env_detail.text},
                    "logs": {"status": env_logs.status_code, "body": env_logs.text},
                    "stream": {"status": env_stream.status_code, "body": env_stream.text},
                    "events": {"status": env_events.status_code, "body": env_events.text},
                },
            )

            webhook_worker = "shared-webhook"
            webhook_created = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload(webhook_worker, title="Shared Webhook", trigger_type="webhook"),
            )
            foreign_rotate = client.post(
                f"/workers/{webhook_worker}/webhook-secret/rotate",
                headers=user_b,
            )
            record(
                results,
                "local-foreign-webhook-rotate-blocked",
                webhook_created.status_code == 200 and foreign_rotate.status_code == 404,
                f"create={webhook_created.status_code} rotate={foreign_rotate.status_code}",
                {
                    "create": {"status": webhook_created.status_code, "body": webhook_created.text},
                    "rotate": {"status": foreign_rotate.status_code, "body": foreign_rotate.text},
                },
            )

            with main_module.get_db() as conn:
                before_owner = conn.execute(
                    "SELECT owner_id FROM workers WHERE id = ?",
                    (shared_worker,),
                ).fetchone()
            reload_resp = client.post("/workers/reload", headers=user_b)
            with main_module.get_db() as conn:
                after_owner = conn.execute(
                    "SELECT owner_id FROM workers WHERE id = ?",
                    (shared_worker,),
                ).fetchone()
            record(
                results,
                "local-reload-preserves-owner",
                reload_resp.status_code == 200
                and before_owner is not None
                and after_owner is not None
                and before_owner["owner_id"] == "user-a"
                and after_owner["owner_id"] == "user-a",
                (
                    f"reload={reload_resp.status_code} before={before_owner['owner_id'] if before_owner else None} "
                    f"after={after_owner['owner_id'] if after_owner else None}"
                ),
                {
                    "reload": {"status": reload_resp.status_code, "body": reload_resp.text},
                    "before_owner": before_owner["owner_id"] if before_owner else None,
                    "after_owner": after_owner["owner_id"] if after_owner else None,
                },
            )

            stock_detail_after_reload = client.get("/workers/research_brief", headers=user_a)
            stock_patch_after_reload = client.patch(
                "/workers/research_brief",
                headers=user_a,
                json={"trigger_type": "manual"},
            )
            record(
                results,
                "local-reload-keeps-stock-workers-protected",
                reload_resp.status_code == 200
                and stock_detail_after_reload.status_code == 200
                and stock_patch_after_reload.status_code == 403,
                (
                    f"reload={reload_resp.status_code} detail={stock_detail_after_reload.status_code} "
                    f"patch={stock_patch_after_reload.status_code}"
                ),
                {
                    "reload": {"status": reload_resp.status_code, "body": reload_resp.text},
                    "detail": {"status": stock_detail_after_reload.status_code, "body": stock_detail_after_reload.text},
                    "patch": {"status": stock_patch_after_reload.status_code, "body": stock_patch_after_reload.text},
                },
            )

            conn_a = _local_insert_connection(main_module, user_id="user-a", app_name="gmail")
            _local_insert_connection(main_module, user_id="user-b", app_name="slack")
            list_conn_a = client.get("/connections", headers=user_a)
            foreign_conn_checks = {
                "status": client.get(f"/connections/{conn_a}/status", headers=user_b),
                "account_info": client.get(f"/connections/{conn_a}/account-info", headers=user_b),
                "test": client.post(f"/connections/{conn_a}/test", headers=user_b),
                "delete": client.delete(f"/connections/{conn_a}", headers=user_b),
            }
            conn_ids_a = [item.get("id") for item in (list_conn_a.json() if list_conn_a.status_code == 200 else [])]
            record(
                results,
                "local-connections-scoped",
                list_conn_a.status_code == 200
                and conn_ids_a == [conn_a]
                and all(response.status_code == 404 for response in foreign_conn_checks.values()),
                (
                    f"list={list_conn_a.status_code} ids={conn_ids_a} "
                    f"foreign_statuses={[resp.status_code for resp in foreign_conn_checks.values()]}"
                ),
                {
                    "list": {"status": list_conn_a.status_code, "ids": conn_ids_a},
                    "foreign_checks": {
                        name: {"status": response.status_code, "body": response.text}
                        for name, response in foreign_conn_checks.items()
                    },
                },
            )

            import composio_client

            composio_client.enable_trigger = lambda *args, **kwargs: "ct_local_probe"
            composio_worker = "local-composio-probe"
            composio_create = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload(
                    composio_worker,
                    title="Local Composio Probe",
                    trigger_type="composio",
                    connection_id=conn_a,
                ),
            )
            composio_body = json.dumps(
                {
                    "id": "msg_local_probe",
                    "type": "composio.trigger.message",
                    "metadata": {
                        "trigger_id": "ct_local_probe",
                        "trigger_slug": "GMAIL_NEW_EMAIL",
                        "connected_account_id": conn_a,
                    },
                    "data": {"subject": "Replay me"},
                }
            ).encode()
            composio_headers = _local_signed_composio_headers(
                composio_body,
                os.environ["COMPOSIO_WEBHOOK_SIGNING_KEY"],
            )
            composio_first = client.post(
                "/composio-events",
                content=composio_body,
                headers=composio_headers,
            )
            composio_second = client.post(
                "/webhooks/composio-events",
                content=composio_body,
                headers=composio_headers,
            )
            with main_module.get_db() as conn:
                composio_run_count = conn.execute(
                    "SELECT COUNT(*) AS count FROM runs WHERE worker_id = ?",
                    (composio_worker,),
                ).fetchone()["count"]
            record(
                results,
                "local-composio-events-replay-blocked",
                composio_create.status_code == 200
                and composio_first.status_code == 200
                and composio_second.status_code == 200
                and composio_first.json().get("status") == "queued"
                and composio_second.json().get("status") == "duplicate_ignored"
                and composio_run_count == 1,
                (
                    f"create={composio_create.status_code} first={composio_first.status_code} "
                    f"second={composio_second.status_code} runs={composio_run_count}"
                ),
                {
                    "create": {"status": composio_create.status_code, "body": composio_create.text},
                    "first": {"status": composio_first.status_code, "body": composio_first.text},
                    "second": {"status": composio_second.status_code, "body": composio_second.text},
                    "run_count": composio_run_count,
                },
            )

            secret_a = client.post("/secrets/AUDIT_SECRET_A", headers=user_a, json={"value": "value-a"})
            secret_b = client.post("/secrets/AUDIT_SECRET_B", headers=user_b, json={"value": "value-b"})
            secret_list_a = client.get("/secrets", headers=user_a)
            secret_list_b = client.get("/secrets", headers=user_b)
            foreign_secret_test = client.post("/secrets/AUDIT_SECRET_A/test", headers=user_b)
            foreign_secret_delete = client.delete("/secrets/AUDIT_SECRET_A", headers=user_b)
            secret_names_a = [item.get("name") for item in (secret_list_a.json() if secret_list_a.status_code == 200 else [])]
            secret_names_b = [item.get("name") for item in (secret_list_b.json() if secret_list_b.status_code == 200 else [])]
            record(
                results,
                "local-secrets-scoped",
                secret_a.status_code == 200
                and secret_b.status_code == 200
                and "AUDIT_SECRET_A" in secret_names_a
                and "AUDIT_SECRET_A" not in secret_names_b
                and "AUDIT_SECRET_B" in secret_names_b
                and foreign_secret_test.status_code == 404
                and foreign_secret_delete.status_code == 404,
                (
                    f"upserts=({secret_a.status_code},{secret_b.status_code}) "
                    f"lists=({secret_names_a},{secret_names_b}) "
                    f"foreign=({foreign_secret_test.status_code},{foreign_secret_delete.status_code})"
                ),
                {
                    "upsert_a": {"status": secret_a.status_code, "body": secret_a.text},
                    "upsert_b": {"status": secret_b.status_code, "body": secret_b.text},
                    "list_a": {"status": secret_list_a.status_code, "names": secret_names_a},
                    "list_b": {"status": secret_list_b.status_code, "names": secret_names_b},
                    "foreign_test": {"status": foreign_secret_test.status_code, "body": foreign_secret_test.text},
                    "foreign_delete": {"status": foreign_secret_delete.status_code, "body": foreign_secret_delete.text},
                },
            )

            context_name = "shared-context"
            context_create = client.post(
                f"/contexts/{context_name}",
                headers=user_a,
                json={"writeable": True},
            )
            context_put = client.put(
                f"/contexts/{context_name}/files/notes.txt",
                headers=user_a,
                content=b"owner-only notes",
            )
            context_owner_file = client.get(
                f"/contexts/{context_name}/files/notes.txt",
                headers=user_a,
            )
            context_owner_list = client.get("/contexts", headers=user_a)
            context_foreign_list = client.get("/contexts", headers=user_b)
            context_foreign_get = client.get(f"/contexts/{context_name}", headers=user_b)
            context_foreign_file = client.get(
                f"/contexts/{context_name}/files/notes.txt",
                headers=user_b,
            )
            context_foreign_put = client.put(
                f"/contexts/{context_name}/files/pwned.txt",
                headers=user_b,
                content=b"nope",
            )
            context_foreign_upload = client.post(
                f"/contexts/{context_name}/upload",
                headers=user_b,
                files={"files": ("upload.txt", b"nope", "text/plain")},
            )
            context_foreign_delete = client.delete(f"/contexts/{context_name}", headers=user_b)
            context_foreign_worker = client.post(
                "/workers",
                headers=user_b,
                json=_local_worker_payload(
                    "foreign-context-worker",
                    title="Foreign Context Worker",
                    contexts=[context_name],
                ),
            )
            context_owner_delete = client.delete(f"/contexts/{context_name}", headers=user_a)
            owner_context_names = [
                item.get("name")
                for item in (context_owner_list.json() if context_owner_list.status_code == 200 else [])
                if isinstance(item, dict)
            ]
            foreign_context_names = [
                item.get("name")
                for item in (context_foreign_list.json() if context_foreign_list.status_code == 200 else [])
                if isinstance(item, dict)
            ]
            record(
                results,
                "local-contexts-scoped",
                context_create.status_code == 200
                and context_put.status_code == 200
                and context_owner_file.status_code == 200
                and owner_context_names == [context_name]
                and foreign_context_names == []
                and context_foreign_get.status_code == 404
                and context_foreign_file.status_code == 404
                and context_foreign_put.status_code == 404
                and context_foreign_upload.status_code == 404
                and context_foreign_delete.status_code == 404
                and context_foreign_worker.status_code == 400
                and context_owner_delete.status_code == 200,
                (
                    f"create={context_create.status_code} put={context_put.status_code} "
                    f"foreign={[context_foreign_get.status_code, context_foreign_file.status_code, context_foreign_put.status_code, context_foreign_upload.status_code, context_foreign_delete.status_code]} "
                    f"worker={context_foreign_worker.status_code} delete={context_owner_delete.status_code}"
                ),
                {
                    "owner_list": owner_context_names,
                    "foreign_list": foreign_context_names,
                    "foreign_get": {"status": context_foreign_get.status_code, "body": context_foreign_get.text},
                    "foreign_file": {"status": context_foreign_file.status_code, "body": context_foreign_file.text},
                    "foreign_put": {"status": context_foreign_put.status_code, "body": context_foreign_put.text},
                    "foreign_upload": {"status": context_foreign_upload.status_code, "body": context_foreign_upload.text},
                    "foreign_delete": {"status": context_foreign_delete.status_code, "body": context_foreign_delete.text},
                    "foreign_worker": {"status": context_foreign_worker.status_code, "body": context_foreign_worker.text},
                    "owner_delete": {"status": context_owner_delete.status_code, "body": context_owner_delete.text},
                },
            )

            collision_context = "shared-collision-context"
            collision_create_a = client.post(
                f"/contexts/{collision_context}",
                headers=user_a,
                json={"writeable": True},
            )
            collision_create_b = client.post(
                f"/contexts/{collision_context}",
                headers=user_b,
                json={"writeable": True},
            )
            collision_put_a = client.put(
                f"/contexts/{collision_context}/files/notes.txt",
                headers=user_a,
                content=b"owner-a",
            )
            collision_put_b = client.put(
                f"/contexts/{collision_context}/files/notes.txt",
                headers=user_b,
                content=b"owner-b",
            )
            collision_get_a = client.get(
                f"/contexts/{collision_context}/files/notes.txt",
                headers=user_a,
            )
            collision_get_b = client.get(
                f"/contexts/{collision_context}/files/notes.txt",
                headers=user_b,
            )
            collision_root = contexts_dir / collision_context
            collision_owner_a = contexts_dir / "user-a" / collision_context / "notes.txt"
            collision_owner_b = contexts_dir / "user-b" / collision_context / "notes.txt"
            collision_root_exists = collision_root.exists()
            collision_owner_a_bytes = collision_owner_a.read_bytes() if collision_owner_a.is_file() else b""
            collision_owner_b_bytes = collision_owner_b.read_bytes() if collision_owner_b.is_file() else b""
            collision_delete_a = client.delete(f"/contexts/{collision_context}", headers=user_a)
            collision_delete_b = client.delete(f"/contexts/{collision_context}", headers=user_b)
            record(
                results,
                "local-context-name-collision-isolated",
                collision_create_a.status_code == 200
                and collision_create_b.status_code == 200
                and collision_put_a.status_code == 200
                and collision_put_b.status_code == 200
                and collision_get_a.status_code == 200
                and collision_get_a.content == b"owner-a"
                and collision_get_b.status_code == 200
                and collision_get_b.content == b"owner-b"
                and not collision_root_exists
                and collision_owner_a_bytes == b"owner-a"
                and collision_owner_b_bytes == b"owner-b"
                and collision_delete_a.status_code == 200
                and collision_delete_b.status_code == 200,
                (
                    f"creates={[collision_create_a.status_code, collision_create_b.status_code]} "
                    f"puts={[collision_put_a.status_code, collision_put_b.status_code]} "
                    f"gets={[collision_get_a.status_code, collision_get_b.status_code]} "
                    f"deletes={[collision_delete_a.status_code, collision_delete_b.status_code]}"
                ),
                {
                    "create_a": {"status": collision_create_a.status_code, "body": collision_create_a.text},
                    "create_b": {"status": collision_create_b.status_code, "body": collision_create_b.text},
                    "get_a": {"status": collision_get_a.status_code, "body": collision_get_a.text},
                    "get_b": {"status": collision_get_b.status_code, "body": collision_get_b.text},
                    "delete_a": {"status": collision_delete_a.status_code, "body": collision_delete_a.text},
                    "delete_b": {"status": collision_delete_b.status_code, "body": collision_delete_b.text},
                },
            )

            symlink_context = "symlink-context"
            symlink_context_create = client.post(
                f"/contexts/{symlink_context}",
                headers=user_a,
                json={"writeable": True},
            )
            outside_target = tmp_dir / "outside-context-target.txt"
            outside_target.write_text("outside")
            symlink_path = contexts_dir / symlink_context / "escape.txt"
            symlink_get = symlink_put = symlink_delete = None
            if symlink_context_create.status_code == 200:
                with main_module.use_context_scope(main_module.context_scope_for_user("user-a")):
                    symlink_path = main_module.context_dir(symlink_context) / "escape.txt"
                    symlink_path.parent.mkdir(parents=True, exist_ok=True)
                os.symlink(outside_target, symlink_path)
                symlink_get = client.get(
                    f"/contexts/{symlink_context}/files/escape.txt",
                    headers=user_a,
                )
                symlink_put = client.put(
                    f"/contexts/{symlink_context}/files/escape.txt",
                    headers=user_a,
                    content=b"hijack",
                )
                symlink_delete = client.delete(
                    f"/contexts/{symlink_context}/files/escape.txt",
                    headers=user_a,
                )
            record(
                results,
                "local-context-file-symlink-traversal",
                symlink_context_create.status_code == 200
                and symlink_get is not None
                and symlink_put is not None
                and symlink_delete is not None
                and symlink_get.status_code == 400
                and symlink_put.status_code == 400
                and symlink_delete.status_code == 400
                and outside_target.read_text() == "outside",
                (
                    f"create={symlink_context_create.status_code} get={symlink_get.status_code if symlink_get is not None else None} "
                    f"put={symlink_put.status_code if symlink_put is not None else None} "
                    f"delete={symlink_delete.status_code if symlink_delete is not None else None}"
                ),
                {
                    "create": {"status": symlink_context_create.status_code, "body": symlink_context_create.text},
                    "get": (
                        {"status": symlink_get.status_code, "body": symlink_get.text}
                        if symlink_get is not None
                        else {}
                    ),
                    "put": (
                        {"status": symlink_put.status_code, "body": symlink_put.text}
                        if symlink_put is not None
                        else {}
                    ),
                    "delete": (
                        {"status": symlink_delete.status_code, "body": symlink_delete.text}
                        if symlink_delete is not None
                        else {}
                    ),
                    "outside": outside_target.read_text(),
                },
            )

            upload_resp = client.post(
                "/uploads",
                headers=user_a,
                files={"file": ("audit.txt", b"upload body", "text/plain")},
            )
            upload_url = ""
            if upload_resp.status_code == 200:
                try:
                    upload_url = str(upload_resp.json().get("url") or "")
                except Exception:
                    upload_url = ""
            owner_download = client.get(upload_url, headers=user_a) if upload_url else None
            foreign_download = client.get(upload_url, headers=user_b) if upload_url else None
            record(
                results,
                "local-upload-download-user-bound",
                upload_resp.status_code == 200
                and bool(upload_url)
                and owner_download is not None
                and foreign_download is not None
                and owner_download.status_code == 200
                and owner_download.content == b"upload body"
                and foreign_download.status_code == 404,
                (
                    f"upload={upload_resp.status_code} owner={owner_download.status_code if owner_download is not None else None} "
                    f"foreign={foreign_download.status_code if foreign_download is not None else None}"
                ),
                {
                    "upload": {"status": upload_resp.status_code, "body": upload_resp.text},
                    "owner_download": {
                        "status": owner_download.status_code if owner_download is not None else None,
                        "body": owner_download.text if owner_download is not None else "",
                    },
                    "foreign_download": {
                        "status": foreign_download.status_code if foreign_download is not None else None,
                        "body": foreign_download.text if foreign_download is not None else "",
                    },
                },
            )

            main_module._rate_buckets.clear()
            with main_module.get_db() as conn:
                conn.execute(
                    "CREATE TABLE IF NOT EXISTS run_create_rate_limits (key TEXT NOT NULL, ts REAL NOT NULL)"
                )
                conn.execute("DELETE FROM run_create_rate_limits")
            file_worker_a = "file-input-owner"
            file_worker_b = "file-input-foreign"
            file_worker_owner_create = client.post(
                "/workers",
                headers=user_a,
                json=_local_file_input_worker_payload(file_worker_a, title="File Input Owner"),
            )
            file_worker_foreign_create = client.post(
                "/workers",
                headers=user_b,
                json=_local_file_input_worker_payload(file_worker_b, title="File Input Foreign"),
            )
            file_upload = client.post(
                "/uploads",
                headers=user_a,
                files={"file": ("bound.txt", b"bound upload", "text/plain")},
            )
            file_sha = ""
            if file_upload.status_code == 200:
                try:
                    file_sha = str(file_upload.json().get("sha256") or "")
                except Exception:
                    file_sha = ""
            owner_file_run = client.post(
                f"/workers/{file_worker_a}/runs",
                headers=user_a,
                json={"inputs": {"upload": file_sha}, "trigger_source": "audit"},
            )
            foreign_file_run = client.post(
                f"/workers/{file_worker_b}/runs",
                headers=user_b,
                json={"inputs": {"upload": file_sha}, "trigger_source": "audit"},
            )
            record(
                results,
                "local-run-file-input-foreign-sha-blocked",
                file_worker_owner_create.status_code == 200
                and file_worker_foreign_create.status_code == 200
                and file_upload.status_code == 200
                and bool(file_sha)
                and owner_file_run.status_code == 200
                and foreign_file_run.status_code in (403, 404),
                (
                    f"workers={[file_worker_owner_create.status_code, file_worker_foreign_create.status_code]} "
                    f"upload={file_upload.status_code} owner_run={owner_file_run.status_code} "
                    f"foreign_run={foreign_file_run.status_code}"
                ),
                {
                    "owner_worker": {"status": file_worker_owner_create.status_code, "body": file_worker_owner_create.text},
                    "foreign_worker": {"status": file_worker_foreign_create.status_code, "body": file_worker_foreign_create.text},
                    "upload": {"status": file_upload.status_code, "body": file_upload.text},
                    "owner_run": {"status": owner_file_run.status_code, "body": owner_file_run.text},
                    "foreign_run": {"status": foreign_file_run.status_code, "body": foreign_file_run.text},
                },
            )
            record(
                results,
                "local-run-create-foreign-file-id-rejected",
                file_worker_owner_create.status_code == 200
                and file_worker_foreign_create.status_code == 200
                and file_upload.status_code == 200
                and bool(file_sha)
                and foreign_file_run.status_code in (403, 404),
                f"file_id={file_sha!r} foreign_run={foreign_file_run.status_code}",
                {
                    "upload": {"status": file_upload.status_code, "body": file_upload.text},
                    "foreign_run": {"status": foreign_file_run.status_code, "body": foreign_file_run.text},
                },
            )

            upload_content_type_bypass = client.post(
                "/uploads",
                headers=user_a,
                files={"file": ("evil.txt", b"<svg><script>alert(1)</script></svg>", "image/svg+xml")},
            )
            record(
                results,
                "local-upload-content-type-bypass-rejected",
                upload_content_type_bypass.status_code == 400,
                f"status={upload_content_type_bypass.status_code}",
                {"status": upload_content_type_bypass.status_code, "body": upload_content_type_bypass.text},
            )

            expired_upload_token = ""
            original_upload_token = ""
            original_upload_url = ""
            if file_upload.status_code == 200:
                try:
                    original_upload_url = str(file_upload.json().get("url") or "")
                    if "download_token=" in original_upload_url:
                        original_upload_token = original_upload_url.split("download_token=", 1)[1]
                except Exception:
                    original_upload_url = ""
                    original_upload_token = ""
            if file_sha:
                expired_payload = main_module._b64url_encode(
                    json.dumps(
                        {
                            "file_id": file_sha,
                            "uploaded_by": "user-a",
                            "expires_at": int(time.time()) - 60,
                        },
                        separators=(",", ":"),
                    ).encode("utf-8")
                )
                expired_signature = hmac.new(
                    main_module._upload_signing_key(),
                    expired_payload.encode("ascii"),
                    hashlib.sha256,
                ).hexdigest()
                expired_upload_token = f"{expired_payload}.{expired_signature}"
            expired_download = (
                client.get(f"/uploads/{file_sha}?download_token={expired_upload_token}", headers=user_a)
                if file_sha and expired_upload_token
                else None
            )
            record(
                results,
                "local-upload-token-expiration-enforced",
                bool(file_sha)
                and bool(expired_upload_token)
                and expired_download is not None
                and expired_download.status_code == 404,
                f"status={expired_download.status_code if expired_download is not None else None}",
                {
                    "status": expired_download.status_code if expired_download is not None else None,
                    "body": expired_download.text if expired_download is not None else "",
                },
            )
            second_upload = client.post(
                "/uploads",
                headers=user_a,
                files={"file": ("second.txt", b"second upload", "text/plain")},
            )
            second_sha = ""
            if second_upload.status_code == 200:
                try:
                    second_sha = str(second_upload.json().get("sha256") or "")
                except Exception:
                    second_sha = ""
            cross_file_download = (
                client.get(f"/uploads/{second_sha}?download_token={original_upload_token}", headers=user_a)
                if second_sha and original_upload_token
                else None
            )
            record(
                results,
                "local-upload-token-cross-file-rejected",
                bool(second_sha)
                and bool(original_upload_token)
                and cross_file_download is not None
                and cross_file_download.status_code == 404,
                f"status={cross_file_download.status_code if cross_file_download is not None else None}",
                {
                    "first_url": original_upload_url,
                    "second_upload": {"status": second_upload.status_code, "body": second_upload.text},
                    "cross_file": {
                        "status": cross_file_download.status_code if cross_file_download is not None else None,
                        "body": cross_file_download.text if cross_file_download is not None else "",
                    },
                },
            )

            main_module._rate_buckets.clear()
            device_create = client.post("/cli-auth/devices", json={"client_name": "audit-cli"})
            user_code = ""
            if device_create.status_code == 200:
                try:
                    user_code = str(device_create.json().get("user_code") or "")
                except Exception:
                    user_code = ""
            foreign_approve = client.post("/cli-auth/approve", headers=user_b, json={"user_code": user_code})
            owner_approve = client.post("/cli-auth/approve", headers=cli_owner_headers, json={"user_code": user_code})
            owner_reapprove = client.post("/cli-auth/approve", headers=cli_owner_headers, json={"user_code": user_code})
            record(
                results,
                "local-cli-auth-approve-user-bound",
                device_create.status_code == 200
                and user_code
                and foreign_approve.status_code == 404
                and owner_approve.status_code == 200
                and owner_reapprove.status_code == 409,
                (
                    f"create={device_create.status_code} foreign={foreign_approve.status_code} "
                    f"owner={owner_approve.status_code} replay={owner_reapprove.status_code}"
                ),
                {
                    "create": {"status": device_create.status_code, "body": device_create.text},
                    "foreign_approve": {"status": foreign_approve.status_code, "body": foreign_approve.text},
                    "owner_approve": {"status": owner_approve.status_code, "body": owner_approve.text},
                    "owner_reapprove": {"status": owner_reapprove.status_code, "body": owner_reapprove.text},
                },
            )

            main_module._rate_buckets.clear()
            deny_create = client.post("/cli-auth/devices", json={"client_name": "audit-deny"})
            deny_user_code = ""
            deny_device_code = ""
            if deny_create.status_code == 200:
                try:
                    deny_payload = deny_create.json()
                    deny_user_code = str(deny_payload.get("user_code") or "")
                    deny_device_code = str(deny_payload.get("device_code") or "")
                except Exception:
                    deny_user_code = ""
                    deny_device_code = ""
            foreign_deny = client.post("/cli-auth/deny", headers=user_b, json={"user_code": deny_user_code})
            owner_deny = client.post("/cli-auth/deny", headers=cli_owner_headers, json={"user_code": deny_user_code})
            owner_redeny = client.post("/cli-auth/deny", headers=cli_owner_headers, json={"user_code": deny_user_code})
            deny_poll = client.get(f"/cli-auth/poll/{deny_device_code}") if deny_device_code else None
            record(
                results,
                "local-cli-auth-deny-user-bound",
                deny_create.status_code == 200
                and deny_user_code
                and deny_device_code
                and foreign_deny.status_code == 404
                and owner_deny.status_code == 200
                and owner_redeny.status_code == 409
                and deny_poll is not None
                and deny_poll.status_code == 404,
                (
                    f"create={deny_create.status_code} foreign={foreign_deny.status_code} "
                    f"owner={owner_deny.status_code} replay={owner_redeny.status_code} "
                    f"poll={deny_poll.status_code if deny_poll is not None else None}"
                ),
                {
                    "create": {"status": deny_create.status_code, "body": deny_create.text},
                    "foreign_deny": {"status": foreign_deny.status_code, "body": foreign_deny.text},
                    "owner_deny": {"status": owner_deny.status_code, "body": owner_deny.text},
                    "owner_redeny": {"status": owner_redeny.status_code, "body": owner_redeny.text},
                    "poll": {"status": deny_poll.status_code if deny_poll is not None else None, "body": deny_poll.text if deny_poll is not None else ""},
                },
            )

            main_module._rate_buckets.clear()
            runs_owner_worker = "runs-owner-probe"
            runs_foreign_worker = "runs-foreign-probe"
            runs_owner_create = client.post(
                "/workers",
                headers=user_a,
                json=_local_worker_payload(runs_owner_worker, title="Runs Owner Probe"),
            )
            runs_foreign_create = client.post(
                "/workers",
                headers=user_b,
                json=_local_worker_payload(runs_foreign_worker, title="Runs Foreign Probe"),
            )
            runs_owner_seed = client.post(
                f"/workers/{runs_owner_worker}/runs",
                headers=user_a,
                json={"inputs": {}, "trigger_source": "audit"},
            )
            runs_foreign_seed = client.post(
                f"/workers/{runs_foreign_worker}/runs",
                headers=user_b,
                json={"inputs": {}, "trigger_source": "audit"},
            )
            runs_owner_id = runs_foreign_id = ""
            if runs_owner_seed.status_code == 200:
                runs_owner_id = str(runs_owner_seed.json().get("run_id") or "")
            if runs_foreign_seed.status_code == 200:
                runs_foreign_id = str(runs_foreign_seed.json().get("run_id") or "")
            runs_owner_list = client.get("/runs", headers=user_a)
            runs_foreign_list = client.get("/runs", headers=user_b)
            owner_run_ids = [item.get("id") for item in (runs_owner_list.json() if runs_owner_list.status_code == 200 else [])]
            foreign_run_ids = [item.get("id") for item in (runs_foreign_list.json() if runs_foreign_list.status_code == 200 else [])]
            record(
                results,
                "local-runs-list-scoped",
                runs_owner_create.status_code == 200
                and runs_foreign_create.status_code == 200
                and runs_owner_seed.status_code == 200
                and runs_foreign_seed.status_code == 200
                and runs_owner_id in owner_run_ids
                and runs_foreign_id not in owner_run_ids
                and runs_foreign_id in foreign_run_ids
                and runs_owner_id not in foreign_run_ids,
                (
                    f"create={[runs_owner_create.status_code, runs_foreign_create.status_code]} "
                    f"seed={[runs_owner_seed.status_code, runs_foreign_seed.status_code]}"
                ),
                {
                    "owner_list": owner_run_ids,
                    "foreign_list": foreign_run_ids,
                },
            )
            record(
                results,
                "local-runs-list-no-worker-name-leak",
                runs_owner_list.status_code == 200
                and runs_foreign_list.status_code == 200
                and runs_foreign_worker not in runs_owner_list.text
                and runs_owner_worker not in runs_foreign_list.text,
                f"owner={runs_owner_list.status_code} foreign={runs_foreign_list.status_code}",
                {
                    "owner": {"status": runs_owner_list.status_code, "body": runs_owner_list.text},
                    "foreign": {"status": runs_foreign_list.status_code, "body": runs_foreign_list.text},
                },
            )

            clear_owner = client.post(
                "/runs/clear?confirm=yes-wipe-all-runs",
                headers=user_a,
            )
            owner_after_clear = client.get("/runs", headers=user_a)
            foreign_after_clear = client.get("/runs", headers=user_b)
            owner_after_ids = [item.get("id") for item in (owner_after_clear.json() if owner_after_clear.status_code == 200 else [])]
            foreign_after_ids = [item.get("id") for item in (foreign_after_clear.json() if foreign_after_clear.status_code == 200 else [])]
            record(
                results,
                "local-runs-clear-scoped",
                clear_owner.status_code == 200
                and clear_owner.json().get("deleted_runs") >= 1
                and runs_owner_id not in owner_after_ids
                and runs_foreign_id in foreign_after_ids,
                (
                    f"clear={clear_owner.status_code} deleted={clear_owner.json().get('deleted_runs') if clear_owner.status_code == 200 else None}"
                ),
                {
                    "clear": {"status": clear_owner.status_code, "body": clear_owner.text},
                    "owner_after": owner_after_ids,
                    "foreign_after": foreign_after_ids,
                },
            )

            run_limit_env = {
                "WORKEROS_RUN_CREATE_RATE_LIMIT": os.environ.get("WORKEROS_RUN_CREATE_RATE_LIMIT"),
                "WORKEROS_RUN_CREATE_PER_WORKER_RATE_LIMIT": os.environ.get("WORKEROS_RUN_CREATE_PER_WORKER_RATE_LIMIT"),
                "WORKEROS_RUN_REPLAY_PER_RUN_RATE_LIMIT": os.environ.get("WORKEROS_RUN_REPLAY_PER_RUN_RATE_LIMIT"),
            }
            try:
                os.environ["WORKEROS_RUN_CREATE_RATE_LIMIT"] = "10"
                os.environ["WORKEROS_RUN_CREATE_PER_WORKER_RATE_LIMIT"] = "2"
                os.environ["WORKEROS_RUN_REPLAY_PER_RUN_RATE_LIMIT"] = "2"
                main_module._rate_buckets.clear()
                with main_module.get_db() as conn:
                    conn.execute("DELETE FROM run_create_rate_limits")

                limited_worker_a = "quota-worker-a"
                limited_worker_b = "quota-worker-b"
                limited_create_a = client.post(
                    "/workers",
                    headers=user_a,
                    json=_local_worker_payload(limited_worker_a, title="Quota Worker A"),
                )
                limited_create_b = client.post(
                    "/workers",
                    headers=user_a,
                    json=_local_worker_payload(limited_worker_b, title="Quota Worker B"),
                )
                limited_statuses = [
                    client.post(
                        f"/workers/{limited_worker_a}/runs",
                        headers=user_a,
                        json={"inputs": {}, "trigger_source": "audit"},
                    ).status_code
                    for _ in range(3)
                ]
                other_worker_run = client.post(
                    f"/workers/{limited_worker_b}/runs",
                    headers=user_a,
                    json={"inputs": {}, "trigger_source": "audit"},
                )
                record(
                    results,
                    "local-run-create-per-worker-rate-limit",
                    limited_create_a.status_code == 200
                    and limited_create_b.status_code == 200
                    and limited_statuses == [200, 200, 429]
                    and other_worker_run.status_code == 200,
                    f"limited={limited_statuses} other_worker={other_worker_run.status_code}",
                    {
                        "create_a": {"status": limited_create_a.status_code, "body": limited_create_a.text},
                        "create_b": {"status": limited_create_b.status_code, "body": limited_create_b.text},
                        "other_worker": {"status": other_worker_run.status_code, "body": other_worker_run.text},
                    },
                )

                with main_module.get_db() as conn:
                    conn.execute("DELETE FROM run_create_rate_limits")
                stock_inputs = json.loads((repo / "docs" / "workers" / "inputs" / "research_brief.json").read_text())
                stock_run_statuses = [
                    client.post(
                        "/workers/research_brief/runs",
                        headers=user_a,
                        json={"inputs": stock_inputs, "trigger_source": "audit"},
                    ).status_code
                    for _ in range(3)
                ]
                record(
                    results,
                    "local-stock-worker-run-create-rate-limited",
                    stock_run_statuses == [200, 200, 429],
                    f"statuses={stock_run_statuses}",
                    {"statuses": stock_run_statuses},
                )

                with main_module.get_db() as conn:
                    conn.execute("DELETE FROM run_create_rate_limits")
                os.environ["WORKEROS_RUN_CREATE_PER_WORKER_RATE_LIMIT"] = "10"
                replay_worker = "quota-replay-worker"
                replay_create = client.post(
                    "/workers",
                    headers=user_a,
                    json=_local_worker_payload(replay_worker, title="Quota Replay Worker"),
                )
                replay_seed = client.post(
                    f"/workers/{replay_worker}/runs",
                    headers=user_a,
                    json={"inputs": {}, "trigger_source": "audit"},
                )
                replay_run_id = ""
                if replay_seed.status_code == 200:
                    try:
                        replay_run_id = str(replay_seed.json().get("run_id") or "")
                    except Exception:
                        replay_run_id = ""
                replay_statuses = []
                if replay_run_id:
                    replay_statuses = [
                        client.post(
                            f"/workers/{replay_worker}/runs/{replay_run_id}/replay",
                            headers=user_a,
                        ).status_code
                        for _ in range(3)
                    ]
                record(
                    results,
                    "local-run-replay-per-run-rate-limit",
                    replay_create.status_code == 200
                    and replay_seed.status_code == 200
                    and replay_statuses == [200, 200, 429],
                    f"seed={replay_seed.status_code} replay_statuses={replay_statuses}",
                    {
                        "create": {"status": replay_create.status_code, "body": replay_create.text},
                        "seed": {"status": replay_seed.status_code, "body": replay_seed.text},
                        "replay_statuses": replay_statuses,
                    },
                )

                with main_module.get_db() as conn:
                    conn.execute("DELETE FROM run_create_rate_limits")
                replay_cross_a = client.post(
                    "/workers",
                    headers=user_a,
                    json=_local_worker_payload("cross-replay-a", title="Cross Replay A"),
                )
                replay_cross_b = client.post(
                    "/workers",
                    headers=user_a,
                    json=_local_worker_payload("cross-replay-b", title="Cross Replay B"),
                )
                replay_cross_seed = client.post(
                    "/workers/cross-replay-a/runs",
                    headers=user_a,
                    json={"inputs": {}, "trigger_source": "audit"},
                )
                replay_cross_run_id = ""
                if replay_cross_seed.status_code == 200:
                    try:
                        replay_cross_run_id = str(replay_cross_seed.json().get("run_id") or "")
                    except Exception:
                        replay_cross_run_id = ""
                replay_cross_wrong = (
                    client.post(
                        f"/workers/cross-replay-b/runs/{replay_cross_run_id}/replay",
                        headers=user_a,
                    )
                    if replay_cross_run_id
                    else None
                )
                replay_cross_right = (
                    client.post(
                        f"/workers/cross-replay-a/runs/{replay_cross_run_id}/replay",
                        headers=user_a,
                    )
                    if replay_cross_run_id
                    else None
                )
                record(
                    results,
                    "local-run-replay-cross-worker-same-user-404",
                    replay_cross_a.status_code == 200
                    and replay_cross_b.status_code == 200
                    and replay_cross_seed.status_code == 200
                    and bool(replay_cross_run_id)
                    and replay_cross_wrong is not None
                    and replay_cross_wrong.status_code == 404
                    and replay_cross_right is not None
                    and replay_cross_right.status_code == 200,
                    (
                        f"create={[replay_cross_a.status_code, replay_cross_b.status_code]} "
                        f"seed={replay_cross_seed.status_code} "
                        f"wrong={replay_cross_wrong.status_code if replay_cross_wrong is not None else None} "
                        f"right={replay_cross_right.status_code if replay_cross_right is not None else None}"
                    ),
                    {
                        "create_a": {"status": replay_cross_a.status_code, "body": replay_cross_a.text},
                        "create_b": {"status": replay_cross_b.status_code, "body": replay_cross_b.text},
                        "seed": {"status": replay_cross_seed.status_code, "body": replay_cross_seed.text},
                        "wrong": (
                            {"status": replay_cross_wrong.status_code, "body": replay_cross_wrong.text}
                            if replay_cross_wrong is not None
                            else {}
                        ),
                        "right": (
                            {"status": replay_cross_right.status_code, "body": replay_cross_right.text}
                            if replay_cross_right is not None
                            else {}
                        ),
                    },
                )
            finally:
                for key, previous in run_limit_env.items():
                    if previous is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = previous

            worker_a = "metrics-a"
            worker_b = "metrics-b"
            created_a = client.post("/workers", headers=user_a, json=_local_worker_payload(worker_a, title="Metrics A"))
            created_b = client.post("/workers", headers=user_b, json=_local_worker_payload(worker_b, title="Metrics B"))
            run_a = client.post(
                f"/workers/{worker_a}/runs",
                headers=user_a,
                json={"inputs": {}, "trigger_source": "audit"},
            )
            run_b = client.post(
                f"/workers/{worker_b}/runs",
                headers=user_b,
                json={"inputs": {}, "trigger_source": "audit"},
            )
            metrics_a = client.get("/system/metrics", headers=user_a)
            metrics_b = client.get("/system/metrics", headers=user_b)
            overview_a = client.get("/system/overview", headers=user_a)
            overview_b = client.get("/system/overview", headers=user_b)
            metrics_ok = False
            overview_ok = False
            metrics_a_body = metrics_b_body = {}
            overview_a_body = overview_b_body = {}
            if metrics_a.status_code == 200 and metrics_b.status_code == 200:
                metrics_a_body = metrics_a.json()
                metrics_b_body = metrics_b.json()
                metrics_ok = (
                    int(metrics_a_body.get("runs_total") or 0) >= 1
                    and int(metrics_b_body.get("runs_total") or 0) >= 1
                    and metrics_a_body.get("connections_count") == 1
                    and metrics_b_body.get("connections_count") == 1
                    and metrics_a_body.get("secrets_count") == 1
                    and metrics_b_body.get("secrets_count") == 1
                )
            if overview_a.status_code == 200 and overview_b.status_code == 200:
                overview_a_body = overview_a.json()
                overview_b_body = overview_b.json()
                recent_a = {item.get("worker_id") for item in overview_a_body.get("recent_runs") or []}
                recent_b = {item.get("worker_id") for item in overview_b_body.get("recent_runs") or []}
                overview_ok = (
                    overview_a_body.get("stats", {}).get("connections_total") == 1
                    and overview_b_body.get("stats", {}).get("connections_total") == 1
                    and worker_b in recent_b
                    and worker_a not in recent_b
                    and worker_a in recent_a
                    and worker_b not in recent_a
                )
            record(
                results,
                "local-system-metrics-overview-scoped",
                all(resp.status_code == 200 for resp in (created_a, created_b, run_a, run_b, metrics_a, metrics_b, overview_a, overview_b))
                and metrics_ok
                and overview_ok,
                (
                    f"creates={[created_a.status_code, created_b.status_code]} "
                    f"runs={[run_a.status_code, run_b.status_code]} "
                    f"metrics={[metrics_a.status_code, metrics_b.status_code]} "
                    f"overview={[overview_a.status_code, overview_b.status_code]}"
                ),
                {
                    "metrics_a": metrics_a_body,
                    "metrics_b": metrics_b_body,
                    "overview_a_recent": [item.get("worker_id") for item in overview_a_body.get("recent_runs", [])],
                    "overview_b_recent": [item.get("worker_id") for item in overview_b_body.get("recent_runs", [])],
                },
            )

            original_local_sweep = main_module._run_connection_sweep
            sweep_seen_user_ids: List[Optional[str]] = []

            async def _fake_local_sweep(*, user_id: Optional[str] = None) -> None:
                sweep_seen_user_ids.append(user_id)

            main_module._run_connection_sweep = _fake_local_sweep
            sweep_last_started = getattr(
                main_module,
                "_connection_sweep_last_started_at_by_user",
                getattr(main_module, "_connection_sweep_last_started_at", None),
            )
            if isinstance(sweep_last_started, dict):
                sweep_last_started.clear()
            try:
                sweep_user_a = client.post("/system/sweep-connections", headers=user_a)
                sweep_user_b = client.post("/system/sweep-connections", headers=user_b)
                sweep_user_a_repeat = client.post("/system/sweep-connections", headers=user_a)
                time.sleep(0.05)
            finally:
                main_module._run_connection_sweep = original_local_sweep
            record(
                results,
                "local-sweep-connections-user-scoped",
                sweep_user_a.status_code == 200
                and sweep_user_b.status_code == 200
                and sweep_user_a_repeat.status_code == 429
                and sweep_seen_user_ids == ["user-a", "user-b"],
                (
                    f"statuses={[sweep_user_a.status_code, sweep_user_b.status_code, sweep_user_a_repeat.status_code]} "
                    f"seen={sweep_seen_user_ids}"
                ),
                {
                    "user_a": {"status": sweep_user_a.status_code, "body": sweep_user_a.text},
                    "user_b": {"status": sweep_user_b.status_code, "body": sweep_user_b.text},
                    "user_a_repeat": {"status": sweep_user_a_repeat.status_code, "body": sweep_user_a_repeat.text},
                    "seen_user_ids": sweep_seen_user_ids,
                },
            )
    finally:
        _reset_local_api_modules()
        _restore_env(env_snapshot, ())
        for key, previous in removed_snapshot.items():
            if previous is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = previous

    return results


def run_probe_matrix(args: argparse.Namespace, repo: Path, secret: str, out_dir: Path) -> dict[str, Any]:
    api = args.api_base.rstrip("/")
    local_api = args.local_api_base.rstrip("/")
    workers_dir = repo / "workers"
    results: list[dict[str, Any]] = []

    health = request(api, "GET", "/health")
    healthz = request(api, "GET", "/healthz")
    record(
        results,
        "health-public",
        health["status"] in (200, 403) and healthz["status"] in (200, 403),
        f"health={health['status']} healthz={healthz['status']}",
        {"health": health, "healthz": healthz},
    )

    chat_noauth = request(api, "POST", "/chat", json={"message": "audit chat"})
    record(
        results,
        "chat-auth-required",
        chat_noauth["status"] in (401, 403),
        f"status={chat_noauth['status']}",
        chat_noauth,
    )

    chat_empty = request(api, "POST", "/chat", secret=secret, json={"message": "   "})
    record(
        results,
        "chat-empty-message-rejected",
        chat_empty["status"] == 400 and "message is required" in chat_empty["body"].lower(),
        f"status={chat_empty['status']}",
        chat_empty,
    )

    chat_oversized = request(api, "POST", "/chat", secret=secret, json={"message": "x" * 20001})
    record(
        results,
        "chat-message-length-limit",
        chat_oversized["status"] == 413 and "character limit" in chat_oversized["body"].lower(),
        f"status={chat_oversized['status']}",
        chat_oversized,
    )

    workspace_noauth = {
        "get": request(api, "GET", "/workspace"),
        "put": request(api, "PUT", "/workspace", data=b"audit workspace"),
    }
    record(
        results,
        "workspace-auth-required",
        all(item["status"] in (401, 403) for item in workspace_noauth.values()),
        f"get={workspace_noauth['get']['status']} put={workspace_noauth['put']['status']}",
        workspace_noauth,
    )

    conversations_noauth = {
        "list": request(api, "GET", "/conversations"),
        "detail": request(api, "GET", "/conversations/conv_audit_probe"),
    }
    record(
        results,
        "conversations-auth-required",
        all(item["status"] in (401, 403) for item in conversations_noauth.values()),
        f"list={conversations_noauth['list']['status']} detail={conversations_noauth['detail']['status']}",
        conversations_noauth,
    )

    approval_noauth = {
        "approve": request(api, "POST", "/runs/run_audit_approve/approve"),
        "reject": request(
            api,
            "POST",
            "/runs/run_audit_approve/reject",
            json={"reason": "audit"},
        ),
    }
    record(
        results,
        "run-approval-routes-require-auth",
        all(item["status"] in (401, 403) for item in approval_noauth.values()),
        f"approve={approval_noauth['approve']['status']} reject={approval_noauth['reject']['status']}",
        approval_noauth,
    )

    restore_noauth = request(api, "POST", "/workers/research_brief/restore")
    record(
        results,
        "worker-restore-auth-required",
        restore_noauth["status"] in (401, 403),
        f"status={restore_noauth['status']}",
        restore_noauth,
    )

    sample_input_noauth = request(api, "GET", "/workers/research_brief/sample-input")
    sample_input_auth = request(api, "GET", "/workers/research_brief/sample-input", secret=secret)
    sample_input_value: Any = None
    sample_input_ok = sample_input_noauth["status"] in (401, 403)
    if sample_input_auth["status"] == 200:
        try:
            sample_input_value = json.loads(sample_input_auth["body"])
        except Exception:
            sample_input_ok = False
        else:
            sample_input_ok = sample_input_ok and isinstance(sample_input_value, dict) and bool(sample_input_value)
    else:
        sample_input_ok = False
    record(
        results,
        "sample-input-auth-and-shape",
        sample_input_ok,
        f"noauth={sample_input_noauth['status']} auth={sample_input_auth['status']}",
        {
            "noauth": sample_input_noauth,
            "auth": sample_input_auth if sample_input_value is None else {**sample_input_auth, "body": json.dumps(sample_input_value, indent=2)},
        },
    )

    no_auth = request(api, "GET", "/workers")
    record(results, "workers-require-auth", no_auth["status"] in (401, 403), f"status={no_auth['status']}", no_auth)

    integrations_noauth = {
        "catalog": request(api, "GET", "/integrations/catalog?limit=1"),
        "triggers": request(api, "GET", "/integrations/triggers?app=gmail"),
    }
    integrations_noauth_statuses = {
        name: item["status"] for name, item in integrations_noauth.items()
    }
    record(
        results,
        "integrations-routes-require-auth",
        all(item["status"] in (401, 403) for item in integrations_noauth.values()),
        f"statuses={integrations_noauth_statuses}",
        integrations_noauth,
    )

    metrics_noauth = request(api, "GET", "/metrics")
    metrics_auth = request(api, "GET", "/metrics", secret=secret)
    metrics_auth_ok = metrics_auth["status"] == 200 and "workeros_runs_total" in metrics_auth["body"]
    record(
        results,
        "prometheus-metrics-auth-and-shape",
        metrics_noauth["status"] in (401, 403) and metrics_auth_ok,
        f"noauth={metrics_noauth['status']} auth={metrics_auth['status']}",
        {"noauth": metrics_noauth, "auth": metrics_auth},
    )

    worker_create_name = f"audit-auth-create-{uuid.uuid4().hex[:8]}"
    worker_draft_name = f"audit-auth-draft-{uuid.uuid4().hex[:8]}"
    worker_write_noauth = {
        "create": request(
            api,
            "POST",
            "/workers",
            json={
                "worker_yml": make_worker_yml(worker_create_name),
                "run_py": "def run(inputs, context):\n    return {'status': 'success'}\n",
            },
        ),
        "draft_and_create": request(
            api,
            "POST",
            "/workers/draft-and-create",
            json={
                "files": [
                    {"path": "worker.yml", "content": make_worker_yml(worker_draft_name)},
                    {"path": "run.py", "content": "def run(inputs, context):\n    return {'status': 'success'}\n"},
                ]
            },
        ),
        "reload": request(api, "POST", "/workers/reload"),
    }
    worker_write_cleanups = {
        "create": request(api, "DELETE", f"/workers/{worker_create_name}", secret=secret),
        "draft_and_create": request(api, "DELETE", f"/workers/{worker_draft_name}", secret=secret),
    }
    record(
        results,
        "worker-write-routes-require-auth",
        all(item["status"] in (401, 403) for item in worker_write_noauth.values()),
        (
            f"create={worker_write_noauth['create']['status']} "
            f"draft_and_create={worker_write_noauth['draft_and_create']['status']} "
            f"reload={worker_write_noauth['reload']['status']}"
        ),
        {"checks": worker_write_noauth, "cleanups": worker_write_cleanups},
    )

    draft_from_prompt_noauth = request(
        api,
        "POST",
        "/workers/draft-from-prompt",
        json={"prompt": "draft a worker"},
    )
    record(
        results,
        "draft-from-prompt-auth-required",
        draft_from_prompt_noauth["status"] in (401, 403),
        f"status={draft_from_prompt_noauth['status']}",
        draft_from_prompt_noauth,
    )

    new_from_prompt_noauth = request(
        api,
        "POST",
        "/workers/new/from-prompt",
        json={"prompt": "draft a worker"},
    )
    record(
        results,
        "new-from-prompt-auth-required",
        new_from_prompt_noauth["status"] in (401, 403),
        f"status={new_from_prompt_noauth['status']}",
        new_from_prompt_noauth,
    )

    new_from_prompt_oversized = request(
        api,
        "POST",
        "/workers/new/from-prompt",
        secret=secret,
        json={"prompt": "x" * (300 * 1024)},
    )
    record(
        results,
        "new-from-prompt-body-limit",
        new_from_prompt_oversized["status"] == 413,
        f"status={new_from_prompt_oversized['status']}",
        new_from_prompt_oversized,
    )

    system_noauth = {
        "info": request(api, "GET", "/system/info"),
        "metrics": request(api, "GET", "/system/metrics"),
        "overview": request(api, "GET", "/system/overview"),
        "platform_config": request(api, "GET", "/system/platform-config"),
        "sweep_connections": request(api, "POST", "/system/sweep-connections"),
    }
    system_noauth_statuses = {name: item["status"] for name, item in system_noauth.items()}
    record(
        results,
        "system-endpoints-require-auth",
        all(status in (401, 403) for status in system_noauth_statuses.values()),
        f"statuses={system_noauth_statuses}",
        system_noauth,
    )
    record(
        results,
        "system-metrics-auth-required",
        system_noauth["metrics"]["status"] in (401, 403),
        f"status={system_noauth['metrics']['status']}",
        system_noauth["metrics"],
    )
    record(
        results,
        "system-overview-auth-required",
        system_noauth["overview"]["status"] in (401, 403),
        f"status={system_noauth['overview']['status']}",
        system_noauth["overview"],
    )

    connections_noauth = request(api, "POST", "/connections", json={"app_name": "audit-not-a-real-app"})
    record(
        results,
        "connections-init-auth-required",
        connections_noauth["status"] in (401, 403),
        f"status={connections_noauth['status']}",
        connections_noauth,
    )

    auth_config_noauth = request(api, "GET", "/connections/auth-configs/audit-probe")
    record(
        results,
        "auth-config-endpoint-auth-required",
        auth_config_noauth["status"] in (401, 403),
        f"status={auth_config_noauth['status']}",
        auth_config_noauth,
    )

    mcp_label = f"auditmcp{uuid.uuid4().hex[:8]}"
    connections_mcp_noauth = request(
        api,
        "POST",
        "/connections/mcp",
        json={"label": mcp_label, "url": "https://example.invalid/mcp"},
    )
    connections_mcp_invalid = request(
        api,
        "POST",
        "/connections/mcp",
        secret=secret,
        json={"label": "bad label", "url": "ftp://example.invalid/mcp"},
    )
    mcp_cleanup: list[dict[str, Any]] = []
    current_connections = request(api, "GET", "/connections", secret=secret)
    if current_connections["status"] == 200:
        try:
            for item in json.loads(current_connections["body"]):
                if isinstance(item, dict) and str(item.get("mcp_label") or "") == mcp_label and item.get("id"):
                    mcp_cleanup.append(
                        request(api, "DELETE", f"/connections/{item['id']}", secret=secret)
                    )
        except Exception:
            pass
    record(
        results,
        "connections-mcp-auth-and-validation",
        connections_mcp_noauth["status"] in (401, 403)
        and connections_mcp_invalid["status"] == 400,
        f"noauth={connections_mcp_noauth['status']} invalid={connections_mcp_invalid['status']} cleanup={[item['status'] for item in mcp_cleanup]}",
        {
            "noauth": connections_mcp_noauth,
            "invalid": connections_mcp_invalid,
            "cleanup": mcp_cleanup,
        },
    )

    expected_callback_location = f"{args.web_base.rstrip('/')}/connections?connected=1"
    callback = request(
        api,
        "GET",
        "/connections/callback?connection_id=unknown-audit&status=active&state=https://evil.example&next=https://evil.example",
        allow_redirects=False,
    )
    callback_alias = request(
        api,
        "GET",
        "/webhooks/oauth-callback?connection_id=unknown-audit&status=active&state=https://evil.example&next=https://evil.example",
        allow_redirects=False,
    )
    record(
        results,
        "connections-callback-fixed-redirect",
        callback["status"] in (302, 307)
        and callback["location"] == expected_callback_location,
        f"status={callback['status']} location={callback['location']!r}",
        callback,
    )
    record(
        results,
        "webhooks-oauth-callback-fixed-redirect",
        callback_alias["status"] in (302, 307)
        and callback_alias["location"] == expected_callback_location,
        f"status={callback_alias['status']} location={callback_alias['location']!r}",
        callback_alias,
    )

    sweep_statuses = []
    for _ in range(5):
        r = request(api, "POST", "/system/sweep-connections", secret=secret)
        sweep_statuses.append(r["status"])
    sweep_ok = False
    if sweep_statuses:
        first_success = next((idx for idx, status in enumerate(sweep_statuses) if status == 200), None)
        if first_success is None:
            sweep_ok = all(status == 429 for status in sweep_statuses)
        else:
            sweep_ok = (
                all(status == 429 for status in sweep_statuses[:first_success])
                and all(status == 429 for status in sweep_statuses[first_success + 1 :])
            )
    record(
        results,
        "sweep-connections-cooldown",
        bool(sweep_ok),
        f"statuses={sweep_statuses}",
        {"statuses": sweep_statuses},
    )

    workers = request(api, "GET", "/workers", secret=secret)
    worker_ids: list[str] = []
    if workers["status"] == 200:
        try:
            worker_ids = [str(item.get("id")) for item in json.loads(workers["body"])]
        except Exception:
            worker_ids = []
    record(
        results,
        "workers-list-stock",
        workers["status"] == 200 and "csv_enricher" in worker_ids,
        f"status={workers['status']} count={len(worker_ids)} csv_enricher={'csv_enricher' in worker_ids}",
        {**workers, "body": json.dumps({"ids": worker_ids}, indent=2)},
    )

    stock_detail = request(api, "GET", "/workers/research_brief", secret=secret)
    stock_detail_ok = False
    stock_detail_summary: dict[str, Any] = {}
    if stock_detail["status"] == 200:
        try:
            parsed_stock_detail = json.loads(stock_detail["body"])
        except Exception:
            parsed_stock_detail = None
        if isinstance(parsed_stock_detail, dict):
            config_keys = set((parsed_stock_detail.get("config") or {}).keys())
            file_paths = [
                str(item.get("path"))
                for item in (parsed_stock_detail.get("files") or [])
                if isinstance(item, dict)
            ]
            forbidden_keys = {"env", "webhook_secret", "source", "bundle_url"}
            stock_detail_summary = {
                "config_keys": sorted(config_keys),
                "file_paths": file_paths[:20],
                "new_webhook_secret": parsed_stock_detail.get("new_webhook_secret"),
            }
            stock_detail_ok = (
                parsed_stock_detail.get("new_webhook_secret") in (None, "")
                and not (config_keys & forbidden_keys)
                and ".env" not in file_paths
                and all(token not in stock_detail["body"] for token in ("sk-", "whsec_", "BEGIN PRIVATE KEY"))
            )
    record(
        results,
        "stock-worker-detail-no-secrets",
        stock_detail_ok,
        f"status={stock_detail['status']}",
        stock_detail if not stock_detail_summary else {**stock_detail, "body": json.dumps(stock_detail_summary, indent=2)},
    )

    metrics = request(api, "GET", "/system/metrics", secret=secret)
    metrics_keys: set[str] = set()
    if metrics["status"] == 200:
        try:
            metrics_keys = set(json.loads(metrics["body"]).keys())
        except Exception:
            metrics_keys = set()
    record(
        results,
        "system-metrics-no-identifier-leaks",
        metrics["status"] == 200
        and not {"user_id", "worker_id", "run_id"} & metrics_keys
        and all(token not in metrics["body"] for token in ("user_id", "worker_id", "run_id")),
        f"status={metrics['status']} keys={sorted(metrics_keys)}",
        metrics,
    )

    system_info = request(api, "GET", "/system/info", secret=secret)
    system_info_leaks = [needle for needle in LEAK_STRINGS if needle in system_info["body"]]
    record(
        results,
        "system-info-no-pydantic-leak",
        system_info["status"] == 200 and not system_info_leaks,
        f"status={system_info['status']} leak_hits={system_info_leaks}",
        system_info,
    )

    platform_config = request(api, "GET", "/system/platform-config", secret=secret)
    platform_config_keys: set[str] = set()
    platform_config_has_urls = False
    if platform_config["status"] == 200:
        try:
            parsed_platform_config = json.loads(platform_config["body"])
            if isinstance(parsed_platform_config, dict):
                platform_config_keys = set(parsed_platform_config.keys())
                platform_config_has_urls = any(
                    isinstance(value, str) and "://" in value
                    for value in parsed_platform_config.values()
                )
        except Exception:
            platform_config_keys = set()
            platform_config_has_urls = True
    record(
        results,
        "system-platform-config-redacted",
        platform_config["status"] == 200
        and platform_config_keys == {"all_required_set", "missing", "set_count", "required_count"}
        and not platform_config_has_urls,
        f"status={platform_config['status']} keys={sorted(platform_config_keys)} urls={platform_config_has_urls}",
        platform_config,
    )

    delete_stock = request(api, "DELETE", "/workers/research_brief", secret=secret)
    stock_source_exists = (workers_dir / "research_brief" / "worker.yml").is_file()
    record(
        results,
        "stock-worker-delete-blocked",
        delete_stock["status"] == 403 and stock_source_exists,
        f"status={delete_stock['status']} research_brief_source={stock_source_exists}",
        delete_stock,
    )

    stock_update_payload = {"worker_yml": make_worker_yml("research_brief"), "run_py": "print('blocked')\n"}
    stock_put = request(api, "PUT", "/workers/research_brief", secret=secret, json=stock_update_payload)
    stock_patch = request(api, "PATCH", "/workers/research_brief", secret=secret, json={"input_values": {"topic": "blocked"}})
    stock_files = request(
        api,
        "PUT",
        "/workers/research_brief/files",
        secret=secret,
        json={"files": [{"path": "worker.yml", "content": make_worker_yml("research_brief")}]},
    )
    record(
        results,
        "stock-worker-mutation-blocked",
        stock_put["status"] == 403 and stock_patch["status"] == 403 and stock_files["status"] == 403,
        f"put={stock_put['status']} patch={stock_patch['status']} files={stock_files['status']}",
        {"put": stock_put, "patch": stock_patch, "files": stock_files},
    )

    invalid_payload = {"worker_yml": "name: bad\ndescription: bad\n", "run_py": "print('ok')\n"}
    invalid_worker = request(api, "POST", "/workers", secret=secret, json=invalid_payload)
    invalid_body = invalid_worker["body"]
    record(
        results,
        "pydantic-version-redacted",
        invalid_worker["status"] == 400 and not any(s in invalid_body for s in ("errors.pydantic.dev", "input_value", "input_type")),
        f"status={invalid_worker['status']} leak_hits={[s for s in ('errors.pydantic.dev', 'input_value', 'input_type') if s in invalid_body]}",
        invalid_worker,
    )

    secret_probe_details = []
    secret_probe_ok = True
    for name in PLATFORM_SECRET_PROBE_NAMES:
        r = request(api, "POST", f"/secrets/{name}/test", secret=secret)
        body = r["body"]
        leaks = [needle for needle in SECRET_TEST_LEAK_STRINGS + (name,) if needle in body]
        ok = r["status"] == 404 and not leaks
        secret_probe_ok = secret_probe_ok and ok
        secret_probe_details.append({"name": name, "status": r["status"], "leaks": leaks, "body": snippet(body, secret, 400)})
    record(
        results,
        "secret-test-no-platform-enumeration",
        secret_probe_ok,
        " ".join(f"{item['name']}={item['status']} leaks={item['leaks']}" for item in secret_probe_details),
        {"results": secret_probe_details},
    )

    runs = request(api, "GET", "/runs?limit=5", secret=secret)
    run_rows: list[dict[str, Any]] = []
    run_ids: list[str] = []
    terminal_run_ids: list[str] = []
    if runs["status"] == 200:
        try:
            payload = json.loads(runs["body"])
            if isinstance(payload, list):
                run_rows = [item for item in payload if isinstance(item, dict) and item.get("id")]
                run_ids = [str(item.get("id")) for item in run_rows]
                terminal_run_ids = [
                    str(item.get("id"))
                    for item in run_rows
                    if str(item.get("status") or "") in {"completed", "failed"} and item.get("id")
                ]
        except Exception:
            run_rows = []
            run_ids = []
            terminal_run_ids = []
    export_details: list[dict[str, Any]] = []
    export_ok = runs["status"] == 200
    for run_id in run_ids[:5]:
        r = request_binary(api, "GET", f"/runs/{run_id}/download", secret=secret)
        names: list[str] = []
        leaks: list[str] = []
        if r["status"] == 200:
            try:
                with zipfile.ZipFile(io.BytesIO(r["content"]), "r") as zf:
                    names = zf.namelist()
                leaks = [
                    name
                    for name in names
                    if name in RUN_EXPORT_FORBIDDEN_FILES or Path(name).name.lower() == "transcript.jsonl"
                ]
            except Exception as exc:
                leaks = [f"zip-parse-error:{type(exc).__name__}"]
        else:
            leaks = [f"status:{r['status']}"]
        export_ok = export_ok and not leaks
        export_details.append(
            {
                "run_id": run_id,
                "status": r["status"],
                "content_type": r.get("content_type"),
                "names": names[:30],
                "leaks": leaks,
            }
        )
    record(
        results,
        "run-download-no-sensitive-archive-files",
        export_ok and bool(run_ids),
        f"runs_checked={len(export_details)} leaks={sum(len(item['leaks']) for item in export_details)}",
        {"runs_status": runs["status"], "runs_checked": export_details},
    )

    detail_ok = runs["status"] == 200 and bool(run_ids)
    detail_details: list[dict[str, Any]] = []
    for run_id in run_ids[:3]:
        r = request(api, "GET", f"/runs/{run_id}", secret=secret)
        body = r["body"]
        leaks = [
            needle
            for needle in ("transcript.jsonl", "trace_", "mode=agent", "runner=e2b")
            if needle in body
        ]
        parsed_input = None
        try:
            parsed = json.loads(body)
            parsed_input = parsed.get("input")
            if parsed.get("transcript") not in ([], None):
                leaks.append("transcript-field-populated")
            for artifact in parsed.get("artifacts") or []:
                if Path(str(artifact.get("name") or "")).name.lower() == "transcript.jsonl":
                    leaks.append("transcript-artifact-listed")
        except Exception:
            leaks.append("json-parse-error")
        if parsed_input not in ({}, None):
            leaks.append("input-field-populated")
        detail_ok = detail_ok and r["status"] == 200 and not leaks
        detail_details.append({"run_id": run_id, "status": r["status"], "input": parsed_input, "leaks": leaks})
    record(
        results,
        "run-detail-no-sensitive-fields",
        detail_ok,
        f"runs_checked={len(detail_details)} leaks={sum(len(item['leaks']) for item in detail_details)}",
        {"runs_checked": detail_details},
    )

    cancel_ok = runs["status"] == 200 and bool(terminal_run_ids)
    cancel_details: list[dict[str, Any]] = []
    if terminal_run_ids:
        terminal_run_id = terminal_run_ids[0]
        existing_cancel = request(api, "POST", f"/runs/{terminal_run_id}/cancel", secret=secret)
        missing_cancel = request(api, "POST", "/runs/run_missing_cancel_probe/cancel", secret=secret)
        existing_body = existing_cancel["body"]
        missing_body = missing_cancel["body"]
        cancel_ok = (
            existing_cancel["status"] == 404
            and missing_cancel["status"] == 404
            and existing_body == missing_body
            and "completed" not in existing_body.lower()
            and terminal_run_id not in existing_body
        )
        cancel_details = [
            {"run_id": terminal_run_id, "status": existing_cancel["status"], "body": snippet(existing_body, secret, 400)},
            {"run_id": "run_missing_cancel_probe", "status": missing_cancel["status"], "body": snippet(missing_body, secret, 400)},
        ]
    record(
        results,
        "run-cancel-no-terminal-existence-oracle",
        cancel_ok,
        f"checked={len(cancel_details)} statuses={[item['status'] for item in cancel_details]}",
        {"cancel_checks": cancel_details},
    )

    bundle_oracle_ok = runs["status"] == 200 and bool(run_ids)
    bundle_oracle_details: list[dict[str, Any]] = []
    if run_ids:
        missing_filename = f"__audit_missing_{uuid.uuid4().hex}.txt"
        existing_bundle = request(api, "GET", f"/runs/{run_ids[0]}/bundle/{missing_filename}", secret=secret)
        missing_bundle = request(api, "GET", f"/runs/run_missing_bundle_probe/bundle/{missing_filename}", secret=secret)
        bundle_oracle_ok = (
            existing_bundle["status"] == 404
            and missing_bundle["status"] == 404
            and existing_bundle["body"] == missing_bundle["body"]
            and run_ids[0] not in existing_bundle["body"]
        )
        bundle_oracle_details = [
            {"run_id": run_ids[0], "status": existing_bundle["status"], "body": snippet(existing_bundle["body"], secret, 400)},
            {"run_id": "run_missing_bundle_probe", "status": missing_bundle["status"], "body": snippet(missing_bundle["body"], secret, 400)},
        ]
    record(
        results,
        "run-bundle-no-snapshot-existence-oracle",
        bundle_oracle_ok,
        f"checked={len(bundle_oracle_details)} statuses={[item['status'] for item in bundle_oracle_details]}",
        {"bundle_checks": bundle_oracle_details},
    )

    oversized = request(api, "POST", "/workers", secret=secret, data=b"x" * (256 * 1024 + 1))
    record(results, "workers-oversized-body", oversized["status"] == 413, f"status={oversized['status']}", oversized)

    upload_noauth = request(
        api,
        "POST",
        "/uploads",
        files={"file": ("audit.txt", io.BytesIO(b"data"), "text/plain")},
    )
    record(
        results,
        "upload-auth-required",
        upload_noauth["status"] in (401, 403),
        f"status={upload_noauth['status']}",
        upload_noauth,
    )

    upload_empty = request(
        api,
        "POST",
        "/uploads",
        secret=secret,
        files={"file": ("upload", io.BytesIO(b"data"), "application/octet-stream")},
    )
    record(results, "upload-extension-media-rejected", upload_empty["status"] == 400, f"status={upload_empty['status']}", upload_empty)

    upload_null = request(
        api,
        "POST",
        "/uploads",
        secret=secret,
        files={"file": ("test.txt\x00.jpg", io.BytesIO(b"data"), "image/jpeg")},
    )
    record(
        results,
        "upload-null-byte-filename-rejected",
        upload_null["status"] == 400,
        f"status={upload_null['status']}",
        upload_null,
    )

    upload_double_ext = request(
        api,
        "POST",
        "/uploads",
        secret=secret,
        files={"file": ("shell.php.jpg", io.BytesIO(b"<?php echo 1; ?>"), "image/jpeg")},
    )
    record(
        results,
        "upload-dangerous-double-extension-rejected",
        upload_double_ext["status"] == 400,
        f"status={upload_double_ext['status']}",
        upload_double_ext,
    )

    upload_path_traversal = request(
        api,
        "POST",
        "/uploads",
        secret=secret,
        files={"file": ("../../etc/passwd.txt", io.BytesIO(b"data"), "text/plain")},
    )
    record(
        results,
        "upload-path-traversal-filename-rejected",
        upload_path_traversal["status"] == 400,
        f"status={upload_path_traversal['status']}",
        upload_path_traversal,
    )

    upload_owner = f"audit-upload-{uuid.uuid4().hex[:8]}"
    upload_content = f"upload-url-probe-{uuid.uuid4().hex}".encode()
    upload_ok = request(
        api,
        "POST",
        "/uploads",
        secret=secret,
        headers={"x-floom-user": upload_owner},
        files={"file": ("audit.txt", io.BytesIO(upload_content), "text/plain")},
    )
    upload_url = ""
    upload_download: dict[str, Any] = {}
    upload_spoof: dict[str, Any] = {}
    upload_tamper: dict[str, Any] = {}
    try:
        upload_body = json.loads(upload_ok["body"])
        upload_url = str(upload_body.get("url") or "")
        if upload_url:
            upload_download = request_binary(
                api,
                "GET",
                upload_url,
                secret=secret,
                headers={"x-floom-user": upload_owner},
            )
            upload_spoof = request(
                api,
                "GET",
                upload_url.split("?", 1)[0],
                secret=secret,
                headers={"x-floom-user": upload_owner},
            )
            upload_tamper = request(api, "GET", upload_url.replace("download_token=", "download_token=x"), secret=secret)
    except Exception as exc:
        upload_download = {"status": "EXCEPTION", "body": f"{type(exc).__name__}: {exc}"}
    record(
        results,
        "upload-url-present-and-downloadable",
        upload_ok["status"] == 200
        and upload_url.startswith("/uploads/")
        and upload_download.get("status") == 200
        and upload_download.get("content") == upload_content,
        f"upload={upload_ok['status']} url={upload_url!r} download={upload_download.get('status')}",
        {"upload": upload_ok, "download": {k: v for k, v in upload_download.items() if k != "content"}},
    )
    record(
        results,
        "upload-download-requires-signed-token",
        upload_spoof.get("status") == 404 and upload_tamper.get("status") == 404,
        f"missing_token={upload_spoof.get('status')} tampered_token={upload_tamper.get('status')}",
        {"missing_token": upload_spoof, "tampered_token": upload_tamper},
    )

    get_body = request(api, "GET", "/workers", secret=secret, data=b"x" * 1024)
    record(
        results,
        "get-request-body-rejected",
        get_body["status"] == 413,
        f"status={get_body['status']}",
        get_body,
    )

    runs_clear = request(api, "POST", "/runs/clear", secret=secret)
    record(
        results,
        "runs-clear-requires-confirm",
        runs_clear["status"] == 400 and "yes-wipe-all-runs" in runs_clear["body"],
        f"status={runs_clear['status']}",
        runs_clear,
    )

    run_body_limit = request(
        api,
        "POST",
        "/workers/research_brief/runs",
        secret=secret,
        json={"inputs": {"blob": "x" * (300 * 1024)}, "trigger_source": "audit"},
    )
    record(
        results,
        "run-create-body-limit-enforced",
        run_body_limit["status"] == 413,
        f"status={run_body_limit['status']}",
        run_body_limit,
    )

    replay_name = f"audit-replay-{uuid.uuid4().hex[:8]}"
    replay_create = request(
        api,
        "POST",
        "/workers",
        secret=secret,
        json={
            "worker_yml": make_worker_yml(replay_name),
            "run_py": "def run(inputs, context):\n    return {'status': 'success', 'outputs': {'echo': inputs}, 'artifacts': []}\n",
        },
    )
    replay_seed: dict[str, Any] = {}
    replay_statuses: list[Any] = []
    bundle_traversal: dict[str, Any] = {}
    if replay_create["status"] == 200:
        replay_seed = request(
            api,
            "POST",
            f"/workers/{replay_name}/runs",
            secret=secret,
            json={"inputs": {"topic": "audit"}, "trigger_source": "audit"},
            timeout=10,
        )
        if replay_seed["status"] == 429:
            time.sleep(RUN_CREATE_QUOTA_RESET_SECONDS)
            replay_seed = request(
                api,
                "POST",
                f"/workers/{replay_name}/runs",
                secret=secret,
                json={"inputs": {"topic": "audit"}, "trigger_source": "audit"},
                timeout=10,
            )
        if replay_seed["status"] == 200:
            try:
                replay_seed_body = json.loads(replay_seed["body"])
                replay_run_id = str(replay_seed_body.get("run_id") or "")
            except Exception:
                replay_run_id = ""
            if replay_run_id:
                bundle_traversal = request(
                    api,
                    "GET",
                    f"/runs/{replay_run_id}/bundle/../../../../etc/passwd",
                    secret=secret,
                )
                for _ in range(10):
                    replay_resp = request(
                        api,
                        "POST",
                        f"/workers/{replay_name}/runs/{replay_run_id}/replay",
                        secret=secret,
                        timeout=10,
                    )
                    replay_statuses.append(replay_resp["status"])
                    if replay_resp["status"] == 429:
                        break
    replay_cleanup = request(api, "DELETE", f"/workers/{replay_name}", secret=secret)
    record(
        results,
        "run-replay-shares-global-rate-limit",
        replay_create["status"] == 200 and replay_seed.get("status") == 200 and 429 in replay_statuses,
        f"create={replay_create['status']} seed={replay_seed.get('status')} replay_statuses={replay_statuses} cleanup={replay_cleanup['status']}",
        {"create": replay_create, "seed": replay_seed, "replay_statuses": replay_statuses, "cleanup": replay_cleanup},
    )
    record(
        results,
        "run-bundle-path-traversal-rejected",
        bundle_traversal.get("status") in {400, 404},
        f"status={bundle_traversal.get('status')}",
        bundle_traversal,
    )

    # Replay shares the same global run-create bucket as direct create. Reset the
    # default 60-second window before the direct create quota probe.
    time.sleep(RUN_CREATE_QUOTA_RESET_SECONDS)

    run_quota_names = [f"audit-runquota-{uuid.uuid4().hex[:8]}-{idx}" for idx in range(3)]
    run_quota_creates: list[dict[str, Any]] = []
    run_quota_statuses: list[Any] = []
    run_quota_cleanups: list[dict[str, Any]] = []
    for name in run_quota_names:
        request(api, "DELETE", f"/workers/{name}", secret=secret)
        created = request(
            api,
            "POST",
            "/workers",
            secret=secret,
            json={
                "worker_yml": make_worker_yml(name),
                "run_py": "def run(inputs, context):\n    return {'status': 'success', 'outputs': {'ok': True}, 'artifacts': []}\n",
            },
        )
        run_quota_creates.append(created)
    if all(item["status"] == 200 for item in run_quota_creates):
        for idx in range(11):
            created_run = request(
                api,
                "POST",
                f"/workers/{run_quota_names[idx % len(run_quota_names)]}/runs",
                secret=secret,
                headers={"X-Forwarded-For": f"198.51.100.{idx + 1}"},
                json={"inputs": {}, "trigger_source": "audit"},
                timeout=10,
            )
            run_quota_statuses.append(created_run["status"])
            if created_run["status"] == 429:
                break
    for name in run_quota_names:
        run_quota_cleanups.append(request(api, "DELETE", f"/workers/{name}", secret=secret))
    record(
        results,
        "run-create-global-rate-limit",
        429 in run_quota_statuses,
        f"creates={[item['status'] for item in run_quota_creates]} run_statuses={run_quota_statuses} cleanups={[item['status'] for item in run_quota_cleanups]}",
        {"creates": run_quota_creates, "run_statuses": run_quota_statuses, "cleanups": run_quota_cleanups},
    )

    # Reset the global run-create bucket before exercising real stock-worker routes.
    time.sleep(RUN_CREATE_QUOTA_RESET_SECONDS)

    stock_sensitive_tokens = (
        "Missing secrets:",
        "COMPOSIO_API_KEY",
        "OPENAI_API_KEY",
        "NOTION_API_KEY",
        "SLACK_BOT_TOKEN",
        "LINEAR_API_KEY",
        "LINEAR_TEAM_ID",
        "ANTHROPIC_API_KEY",
        "GMAIL_SERVICE_ACCOUNT_JSON",
        "\"trace_id\"",
        "trace_",
        "thread_",
        "runner=e2b",
        "mode=agent",
    )
    stock_inputs = json.loads((repo / "docs" / "workers" / "inputs" / "research_brief.json").read_text())
    stock_run_noauth = request(
        api,
        "POST",
        "/workers/research_brief/runs",
        json={"inputs": stock_inputs, "trigger_source": "audit"},
        timeout=20,
    )
    stock_run_auth = request(
        api,
        "POST",
        "/workers/research_brief/runs",
        secret=secret,
        json={
            "inputs": {
                "topic": "Audit stock probe",
                "audience": "executive",
                "depth": "summary",
            },
            "trigger_source": "audit",
        },
        timeout=30,
    )
    stock_run_id = ""
    if stock_run_auth["status"] == 200:
        try:
            stock_run_id = str(json.loads(stock_run_auth["body"]).get("run_id") or "")
        except Exception:
            stock_run_id = ""
    stock_events = (
        request_stream_text(api, "GET", f"/runs/{stock_run_id}/events", secret=secret, timeout=30)
        if stock_run_id
        else {}
    )
    stock_stream = (
        request_stream_text(api, "GET", f"/runs/{stock_run_id}/stream", secret=secret, timeout=30)
        if stock_run_id
        else {}
    )
    stock_logs = (
        request(api, "GET", f"/runs/{stock_run_id}/logs", secret=secret, timeout=30)
        if stock_run_id
        else {}
    )
    stock_replay = (
        request(
            api,
            "POST",
            f"/workers/research_brief/runs/{stock_run_id}/replay",
            secret=secret,
            timeout=30,
        )
        if stock_run_id
        else {}
    )
    stock_replay_id = ""
    if stock_replay.get("status") == 200:
        try:
            stock_replay_id = str(json.loads(stock_replay["body"]).get("run_id") or "")
        except Exception:
            stock_replay_id = ""
    stock_timeseries_noauth = request(api, "GET", "/workers/research_brief/runs/timeseries")
    stock_timeseries_auth = request(api, "GET", "/workers/research_brief/runs/timeseries", secret=secret)
    stock_reload = request(api, "POST", "/workers/reload", secret=secret, timeout=30)
    stock_patch_after_reload = request(
        api,
        "PATCH",
        "/workers/research_brief",
        secret=secret,
        json={"input_values": {"topic": "blocked"}},
        timeout=20,
    )
    stock_timeseries_rows: list[dict[str, Any]] = []
    if stock_timeseries_auth.get("status") == 200:
        try:
            parsed_stock_timeseries = json.loads(stock_timeseries_auth["body"])
            if isinstance(parsed_stock_timeseries, list):
                stock_timeseries_rows = [
                    row for row in parsed_stock_timeseries if isinstance(row, dict)
                ]
        except Exception:
            stock_timeseries_rows = []
    record(
        results,
        "stock-worker-run-create-auth-and-shape",
        stock_run_noauth["status"] in (401, 403)
        and stock_run_auth["status"] == 200
        and stock_run_id.startswith("run_"),
        f"noauth={stock_run_noauth['status']} auth={stock_run_auth['status']} run_id={stock_run_id!r}",
        {"noauth": stock_run_noauth, "auth": stock_run_auth},
    )
    record(
        results,
        "stock-worker-run-replay-auth-and-shape",
        stock_run_auth["status"] == 200
        and stock_replay.get("status") == 200
        and stock_replay_id.startswith("run_"),
        f"seed={stock_run_auth['status']} replay={stock_replay.get('status')} replay_run_id={stock_replay_id!r}",
        {"seed": stock_run_auth, "replay": stock_replay},
    )
    record(
        results,
        "stock-worker-run-events-no-sensitive-leak",
        stock_events.get("status") == 200
        and all(token not in stock_events.get("body", "") for token in stock_sensitive_tokens),
        f"status={stock_events.get('status')}",
        stock_events,
    )
    record(
        results,
        "stock-worker-run-stream-no-sensitive-leak",
        stock_stream.get("status") == 200
        and all(token not in stock_stream.get("body", "") for token in stock_sensitive_tokens),
        f"status={stock_stream.get('status')}",
        stock_stream,
    )
    record(
        results,
        "stock-worker-run-logs-no-sensitive-leak",
        stock_logs.get("status") == 200
        and all(token not in stock_logs.get("body", "") for token in stock_sensitive_tokens),
        f"status={stock_logs.get('status')}",
        stock_logs,
    )
    record(
        results,
        "stock-worker-timeseries-auth-and-safe",
        stock_timeseries_noauth["status"] in (401, 403)
        and stock_timeseries_auth["status"] == 200
        and bool(stock_timeseries_rows)
        and all(set(row.keys()) <= {"date", "total", "completed", "failed"} for row in stock_timeseries_rows)
        and all("user_id" not in json.dumps(row) and "owner_id" not in json.dumps(row) for row in stock_timeseries_rows),
        f"noauth={stock_timeseries_noauth['status']} auth={stock_timeseries_auth['status']} rows={len(stock_timeseries_rows)}",
        {"noauth": stock_timeseries_noauth, "auth": stock_timeseries_auth},
    )
    record(
        results,
        "stock-worker-reload-keeps-mutations-blocked",
        stock_reload["status"] == 200 and stock_patch_after_reload["status"] == 403,
        f"reload={stock_reload['status']} patch={stock_patch_after_reload['status']}",
        {"reload": stock_reload, "patch": stock_patch_after_reload},
    )

    stock_rotate = request(api, "POST", "/workers/research_brief/webhook-secret/rotate", secret=secret)
    record(
        results,
        "stock-worker-webhook-secret-rotate-blocked",
        stock_rotate["status"] == 403,
        f"status={stock_rotate['status']}",
        stock_rotate,
    )

    webhook_name = f"audit-webhook-{uuid.uuid4().hex[:8]}"
    webhook_create = request(
        api,
        "POST",
        "/workers",
        secret=secret,
        json={
            "worker_yml": make_worker_yml(webhook_name, trigger_type="webhook"),
            "run_py": "def run(inputs, context):\n    return {'status': 'success', 'outputs': {'ok': True}, 'artifacts': []}\n",
        },
    )
    webhook_rotate: dict[str, Any] = {}
    webhook_missing_auth: dict[str, Any] = {}
    webhook_bad_token: dict[str, Any] = {}
    if webhook_create["status"] == 200:
        webhook_rotate = request(
            api,
            "POST",
            f"/workers/{webhook_name}/webhook-secret/rotate",
            secret=secret,
        )
        webhook_missing_auth = request(
            api,
            "POST",
            f"/webhooks/{webhook_name}",
            json={"probe": "missing-auth"},
        )
        webhook_bad_token = request(
            api,
            "POST",
            f"/webhooks/{webhook_name}?token=wrong-token",
            json={"probe": "bad-token"},
        )
    webhook_cleanup = request(api, "DELETE", f"/workers/{webhook_name}", secret=secret)
    record(
        results,
        "webhook-trigger-auth-required",
        webhook_create["status"] == 200
        and webhook_rotate.get("status") == 200
        and webhook_missing_auth.get("status") == 401
        and webhook_bad_token.get("status") == 401,
        f"create={webhook_create['status']} rotate={webhook_rotate.get('status')} missing={webhook_missing_auth.get('status')} bad_token={webhook_bad_token.get('status')} cleanup={webhook_cleanup['status']}",
        {
            "create": webhook_create,
            "rotate": webhook_rotate,
            "missing_auth": webhook_missing_auth,
            "bad_token": webhook_bad_token,
            "cleanup": webhook_cleanup,
        },
    )

    composio_invalid = request(
        api,
        "POST",
        "/composio-events",
        headers={"Content-Type": "application/json"},
        data=b'{"type":"audit"}',
    )
    composio_alias_invalid = request(
        api,
        "POST",
        "/webhooks/composio-events",
        headers={"Content-Type": "application/json"},
        data=b'{"type":"audit"}',
    )
    record(
        results,
        "composio-events-invalid-signature-rejected",
        composio_invalid["status"] == 401 and composio_alias_invalid["status"] == 401,
        f"primary={composio_invalid['status']} alias={composio_alias_invalid['status']}",
        {"primary": composio_invalid, "alias": composio_alias_invalid},
    )

    from_bundle_noauth = request(
        api,
        "POST",
        "/workers/from-bundle",
        files={"bundle": ("bad.zip", io.BytesIO(b"not a zip"), "application/zip")},
    )
    record(
        results,
        "from-bundle-auth-required",
        from_bundle_noauth["status"] in (401, 403),
        f"status={from_bundle_noauth['status']}",
        from_bundle_noauth,
    )

    symlink_name = f"audit-symlink-{uuid.uuid4().hex[:8]}"
    symlink = request(
        api,
        "POST",
        "/workers/from-bundle",
        secret=secret,
        files={"bundle": ("symlink.zip", io.BytesIO(symlink_zip(symlink_name)), "application/zip")},
    )
    record(
        results,
        "bundle-symlink-rejected",
        symlink["status"] == 400 and "symlink" in symlink["body"].lower(),
        f"status={symlink['status']} created={(workers_dir / symlink_name).exists()}",
        symlink,
    )

    traversal_name = f"audit-traversal-{uuid.uuid4().hex[:8]}"
    traversal = request(
        api,
        "POST",
        "/workers/from-bundle",
        secret=secret,
        files={"bundle": ("traversal.zip", io.BytesIO(traversal_zip(traversal_name)), "application/zip")},
    )
    record(
        results,
        "bundle-traversal-rejected",
        traversal["status"] == 400,
        f"status={traversal['status']} created={(workers_dir / traversal_name).exists()}",
        traversal,
    )

    nested_name = f"audit-nested-{uuid.uuid4().hex[:8]}"
    nested_traversal = request(
        api,
        "POST",
        "/workers/from-bundle",
        secret=secret,
        files={"bundle": ("nested-traversal.zip", io.BytesIO(nested_traversal_zip(nested_name)), "application/zip")},
    )
    record(
        results,
        "bundle-nested-traversal-rejected",
        nested_traversal["status"] == 400 and not (workers_dir / nested_name).exists(),
        f"status={nested_traversal['status']} created={(workers_dir / nested_name).exists()}",
        nested_traversal,
    )

    absolute_name = f"audit-absolute-{uuid.uuid4().hex[:8]}"
    absolute = request(
        api,
        "POST",
        "/workers/from-bundle",
        secret=secret,
        files={"bundle": ("absolute.zip", io.BytesIO(absolute_path_zip(absolute_name)), "application/zip")},
    )
    record(
        results,
        "bundle-absolute-path-rejected",
        absolute["status"] == 400 and not (workers_dir / absolute_name).exists(),
        f"status={absolute['status']} created={(workers_dir / absolute_name).exists()}",
        absolute,
    )

    bundle_rate_statuses = []
    for _ in range(11):
        r = request(
            api,
            "POST",
            "/workers/from-bundle",
            secret=secret,
            files={"bundle": ("bad.zip", io.BytesIO(b"not a zip"), "application/zip")},
        )
        bundle_rate_statuses.append(r["status"])
    record(
        results,
        "from-bundle-rate-limit",
        429 in bundle_rate_statuses,
        f"statuses={bundle_rate_statuses}",
        {"statuses": bundle_rate_statuses},
    )

    race_name = f"audit-race-{uuid.uuid4().hex[:8]}"
    payload = {"worker_yml": make_worker_yml(race_name), "run_py": "print('audit race')\n"}
    request(api, "DELETE", f"/workers/{race_name}", secret=secret)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(
            pool.map(
                lambda _: request(api, "POST", "/workers", secret=secret, json=payload)["status"],
                range(2),
            )
        )
    cleanup = request(api, "DELETE", f"/workers/{race_name}", secret=secret)
    record(
        results,
        "concurrent-create-conflict",
        sorted(statuses) == [200, 409] and cleanup["status"] in (200, 204, 404) and not (workers_dir / race_name).exists(),
        f"statuses={statuses} cleanup={cleanup['status']} source_exists={(workers_dir / race_name).exists()}",
        {"statuses": statuses, "cleanup": cleanup},
    )

    openapi = request(api, "GET", "/openapi.json", secret=secret)
    route_inventory = extract_route_inventory(openapi["body"])
    openapi_hits = [needle for needle in LEAK_STRINGS if needle in openapi["body"]]
    record(
        results,
        "openapi-leak-scan",
        openapi["status"] == 200 and not openapi_hits,
        f"status={openapi['status']} hits={openapi_hits}",
        {**openapi, "body": json.dumps({"hits": openapi_hits})},
    )

    cli_oracle = {"create": {}, "deny": {}, "poll": {}}
    created_device = request(api, "POST", "/cli-auth/devices", json={"client_name": "audit-deny-oracle"})
    cli_oracle["create"] = created_device
    cli_oracle_ok = created_device["status"] == 200
    if created_device["status"] == 200:
        try:
            created_payload = json.loads(created_device["body"])
            deny = request(
                api,
                "POST",
                "/cli-auth/deny",
                secret=secret,
                json={"user_code": created_payload.get("user_code")},
            )
            poll = request(api, "GET", f"/cli-auth/poll/{created_payload.get('device_code')}")
            cli_oracle["deny"] = deny
            cli_oracle["poll"] = poll
            cli_oracle_ok = deny["status"] == 200 and poll["status"] == 404 and "denied" not in poll["body"].lower()
        except Exception as exc:
            cli_oracle_ok = False
            cli_oracle["error"] = {"body": f"{type(exc).__name__}: {exc}", "status": "EXCEPTION"}
    record(
        results,
        "cli-auth-denied-state-not-enumerable",
        cli_oracle_ok,
        f"create={cli_oracle.get('create', {}).get('status')} deny={cli_oracle.get('deny', {}).get('status')} poll={cli_oracle.get('poll', {}).get('status')}",
        cli_oracle,
    )

    device_statuses = []
    for i in range(6):
        r = request(api, "POST", "/cli-auth/devices", json={"client_name": f"audit-{i}"})
        device_statuses.append(r["status"])
    record(
        results,
        "cli-auth-device-rate-limit",
        429 in device_statuses,
        f"statuses={device_statuses}",
        {"statuses": device_statuses},
    )

    if args.include_deep_json:
        nested = '{"a":' * 3000 + "1" + "}" * 3000
        deep = request(api, "POST", "/workers", secret=secret, headers={"content-type": "application/json"}, data=nested.encode())
        record(results, "deep-json-bounded", deep["status"] in (400, 413, 422), f"status={deep['status']}", deep)

    local_health = request(local_api, "GET", "/health") if args.local_checks else None
    if local_health:
        record(
            results,
            "local-deploy-health",
            local_health["status"] == 200,
            f"status={local_health['status']}",
            local_health,
        )
    if args.local_checks:
        results.extend(run_local_probe_matrix(repo))

    sanitized_results = []
    for item in results:
        raw = dict(item.get("raw") or {})
        if "body" in raw:
            raw["body"] = snippet(str(raw["body"]), secret)
        sanitized_results.append({**item, "raw": raw})

    transcript = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "api_base": api,
        "web_base": args.web_base,
        "repo": str(repo),
        "mode": "bounded-live-prod-probes+local-scoped-checks" if args.local_checks else "bounded-live-prod-probes",
        "include_deep_json": args.include_deep_json,
        "route_inventory": route_inventory,
        "route_inventory_count": len(route_inventory),
        "results": sanitized_results,
    }
    (out_dir / "probe-results.json").write_text(json.dumps(transcript, indent=2) + "\n")
    write_probe_markdown(transcript, out_dir / "probe-results.md")
    return transcript


def write_probe_markdown(transcript: dict[str, Any], path: Path) -> None:
    lines = [
        "# Workeros Kimi Audit Probe Results",
        "",
        f"- Generated: `{transcript['generated_at']}`",
        f"- API: `{transcript['api_base']}`",
        f"- Web: `{transcript['web_base']}`",
        "",
        "| Probe | Result | Detail |",
        "|---|---:|---|",
    ]
    for item in transcript["results"]:
        lines.append(f"| `{item['id']}` | {'PASS' if item['ok'] else 'FAIL'} | {item['detail']} |")
    routes = transcript.get("route_inventory") or []
    if routes:
        lines.append("")
        lines.append("## Route Inventory")
        lines.append("")
        lines.append("| Method | Path | Risk tags | Covered by probe |")
        lines.append("|---|---|---|---|")
        for route in routes:
            tags = ", ".join(route.get("risk_tags") or [])
            covered = ", ".join(route_coverage_hints(str(route.get("method")), str(route.get("path"))))
            lines.append(
                f"| `{route.get('method')}` | `{route.get('path')}` | {tags} | {covered or 'none'} |"
            )
    lines.append("")
    lines.append("## Raw Snippets")
    for item in transcript["results"]:
        lines.append(f"\n### {item['id']}")
        lines.append("```json")
        lines.append(json.dumps(item["raw"], indent=2)[:4000])
        lines.append("```")
    path.write_text("\n".join(lines) + "\n")


def build_kimi_prompt(profile: str, transcript: dict[str, Any], repo: Path) -> str:
    profile_focus = {
        "api-security": "API auth boundaries, validation, resource exhaustion, rate limits, IDOR, CORS, OpenAPI leaks, response amplification, status-code drift.",
        "worker-runtime": "worker creation/update/delete, bundle extraction, sandbox/runtime isolation, stock worker integrity, run artifacts, malicious worker manifests.",
        "product-flow": "full product launch readiness across web + API + CLI/MCP from a hostile user perspective; identify flows still not actually tested.",
    }.get(profile, "general adversarial launch-readiness review")

    routes = transcript.get("route_inventory") or []
    high_risk_routes = [
        route for route in routes
        if route.get("risk_tags")
    ]
    probe_lines = "\n".join(
        f"- {item.get('id')}: {'PASS' if item.get('ok') else 'FAIL'}; {item.get('detail')}"
        for item in transcript.get("results", [])
    )
    probe_semantics_lines = "\n".join(
        f"- {probe_id}: {meaning}"
        for probe_id, meaning in KIMI_PROBE_SEMANTICS.items()
        if any(str(item.get("id")) == probe_id for item in transcript.get("results", []))
    )
    route_lines = "\n".join(
        f"- {route.get('method')} {route.get('path')} "
        f"tags={','.join(route.get('risk_tags') or [])} "
        f"covered_by={','.join(route_coverage_hints(str(route.get('method')), str(route.get('path')))) or 'none'}"
        for route in high_risk_routes
    )

    return textwrap.dedent(
        f"""
        You are Kimi running a Workeros adversarial launch-readiness audit profile: {profile}.

        Target product:
        - Web: {transcript['web_base']}
        - API: {transcript['api_base']}

        Your focus:
        {profile_focus}

        Audit rules:
        - Audit only the deterministic evidence below. Do not inspect the repo in this Kimi pass.
        - Live prod probes are primary. Probes prefixed `local-` are scoped local TestClient checks used only for multi-user/authz paths that the prod shared-secret surface cannot express directly.
        - A route has zero deterministic coverage only when `covered_by=none`. If one or more probe IDs are listed, do not call it zero coverage.
        - Do not downgrade a route to zero coverage just because one probe ID covers multiple sibling routes.
        - Treat the `covered_by=` lists as authoritative for the exact route shown. If a route lists one or more probe IDs, describe it as partially covered rather than uncovered.
        - Do not invent an object-specific attack on a route that has no object identifier in the path. Example: `POST /workers/reload` has no `worker_id`.
        - Do NOT just summarize passing probes.
        - Your main job is to find what the probes missed.
        - Compare every high-risk route below against the probe IDs.
        - For every untested mutating/object-ID route, ask: can it leak object existence, mutate a stock asset, cross user boundaries, expose logs/artifacts/secrets, burn quota, trigger external side effects, bypass rate limits, or create a race/resource exhaustion condition?
        - A finding can be CONFIRMED only with probe evidence in this prompt.
        - A finding can be UNCONFIRMED when evidence is insufficient, but it must include an exact curl/Python reproducer for the next run.
        - If all deterministic probes passed, you still must produce the strongest untested hypotheses. An empty New Findings section is a failure unless you prove all high-risk route classes have coverage.
        - Keep the report under 1200 words.

        Prior misses that this prompt must prevent:
        - Secret test endpoint leaked platform secret existence, key lengths, and OpenAI validity.
        - Run ZIP/detail endpoints exposed inputs, logs, trace IDs, artifacts, and transcripts.
        - Run cancel leaked completed-run existence via 409 vs 404.
        - Run bundle endpoints leaked run existence via missing-snapshot 410 vs missing-run 404.
        - Stock workers were delete-protected but update routes could still backdoor them.
        - A shipped stock worker was left out of the protected set and was mutable through PATCH/PUT/PUT files.
        - Foreign custom workers leaked through list/detail/timeseries and accepted non-owner update/file/reload flows.
        - Bundle symlink/traversal and create-race cases needed explicit probes.
        - File-input SHA references were audited but not blocked across user boundaries.
        - CLI auth polling leaked denied/expired device state.
        - The web API proxy forwarded arbitrary upstream paths.
        - OpenAPI docstrings leaked internal audit notes and implementation details.

        Output exactly this report shape:
        # Kimi {profile} Audit
        Score: <0-100> (<LAUNCH READY | NOT LAUNCH READY>)

        ## Coverage Gap Analysis
        | Route/Class | Covered By Probe | Missing Attack | Exact Next Probe |

        ## New Findings
        | ID | Severity | Finding | Evidence | Reproducer | Status |

        ## Verified Safe
        | Vector | Evidence |

        ## Unconfirmed But Suspicious
        | Hypothesis | Exact next probe |

        ## Top Next Probes
        1. ...

        ## One-Sentence Handoff

        High-risk routes:
        {route_lines}

        Probe semantics:
        {probe_semantics_lines or "- none"}

        Probe transcript:
        {probe_lines}
        """
    ).strip() + "\n"


def run_kimi(profile: str, prompt: str, out_dir: Path, repo: Path, timeout: int) -> dict[str, Any]:
    prompt_path = out_dir / f"kimi-{profile}-prompt.md"
    report_path = out_dir / f"kimi-{profile}-report.md"
    log_path = out_dir / f"kimi-{profile}.log"
    prompt_path.write_text(prompt)

    started = time.perf_counter()
    try:
        proc = subprocess.run(
            ["kimi-agent", prompt],
            text=True,
            capture_output=True,
            timeout=timeout,
            cwd=str(repo),
        )
        elapsed = int(time.perf_counter() - started)
        output = proc.stdout.strip() or proc.stderr.strip()
        report_path.write_text(output + "\n")
        log_path.write_text(
            json.dumps(
                {
                    "profile": profile,
                    "returncode": proc.returncode,
                    "elapsed_seconds": elapsed,
                    "stdout_bytes": len(proc.stdout),
                    "stderr_bytes": len(proc.stderr),
                    "stderr_tail": proc.stderr[-4000:],
                },
                indent=2,
            )
            + "\n"
        )
        return {"profile": profile, "ok": proc.returncode == 0, "report": str(report_path), "returncode": proc.returncode}
    except subprocess.TimeoutExpired as exc:
        elapsed = int(time.perf_counter() - started)
        report_path.write_text(f"Kimi profile timed out after {timeout}s.\n")
        log_path.write_text(json.dumps({"profile": profile, "timeout": timeout, "elapsed_seconds": elapsed}, indent=2) + "\n")
        return {"profile": profile, "ok": False, "report": str(report_path), "error": f"timeout after {timeout}s"}


def aggregate(out_dir: Path, transcript: dict[str, Any], kimi_runs: list[dict[str, Any]], secret: str) -> None:
    failed = [item for item in transcript["results"] if not item["ok"]]
    lines = [
        "# Workeros Kimi Adversarial Audit",
        "",
        f"- Generated: `{transcript['generated_at']}`",
        f"- API: `{transcript['api_base']}`",
        f"- Web: `{transcript['web_base']}`",
        f"- Probe results: `{out_dir / 'probe-results.md'}`",
        "",
        "## Deterministic Probe Summary",
        "",
        f"- Total probes: {len(transcript['results'])}",
        f"- Failed probes: {len(failed)}",
        "",
    ]
    if failed:
        lines.append("| Probe | Detail |")
        lines.append("|---|---|")
        for item in failed:
            lines.append(f"| `{item['id']}` | {item['detail']} |")
        lines.append("")
    else:
        lines.append("All deterministic probes passed.\n")

    lines.extend(["## Kimi Profiles", ""])
    if kimi_runs:
        lines.append("| Profile | Status | Report |")
        lines.append("|---|---:|---|")
        for run in kimi_runs:
            rel = Path(run["report"]).name
            lines.append(f"| `{run['profile']}` | {'OK' if run['ok'] else 'FAIL'} | `{rel}` |")
    else:
        lines.append("Kimi was skipped for this run.")
    lines.append("")
    lines.append("## Re-run")
    lines.append("")
    lines.append("```bash")
    lines.append("python3 scripts/workeros-kimi-audit.py --with-kimi")
    lines.append("```")
    lines.append("")
    lines.append("Secret values are redacted from generated artifacts.")
    (out_dir / "SUMMARY.md").write_text(sanitize("\n".join(lines) + "\n", secret))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Workeros bounded Kimi adversarial audit.")
    parser.add_argument("--api-base", default=os.environ.get("WORKEROS_AUDIT_API_BASE", DEFAULT_API))
    parser.add_argument("--local-api-base", default=os.environ.get("WORKEROS_AUDIT_LOCAL_API_BASE", "http://127.0.0.1:8011"))
    parser.add_argument("--web-base", default=os.environ.get("WORKEROS_AUDIT_WEB_BASE", DEFAULT_WEB))
    parser.add_argument("--secret-file", default=os.environ.get("WORKEROS_AUDIT_SECRET_FILE"))
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--profiles", default=",".join(DEFAULT_PROFILES))
    parser.add_argument("--with-kimi", action="store_true", help="Invoke kimi-agent after probes.")
    parser.add_argument("--kimi-timeout", type=int, default=420)
    parser.add_argument(
        "--audit-client-ip",
        default=os.environ.get("WORKEROS_AUDIT_CLIENT_IP", ""),
        help="Synthetic client IP used in X-Forwarded-For for local repeatable rate-limit probes.",
    )
    parser.add_argument("--include-deep-json", action="store_true", help="Run a bounded deeply nested JSON probe that may produce a 500 if broken.")
    parser.add_argument("--local-checks", action="store_true", help="Also check local API health.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.audit_client_ip:
        args.audit_client_ip = f"198.51.100.{1 + (uuid.uuid4().int % 254)}"
    os.environ["WORKEROS_AUDIT_CLIENT_IP"] = args.audit_client_ip
    repo = Path(__file__).resolve().parents[1]
    secret = read_secret(repo, args.secret_file)
    out_dir = Path(args.out_dir) if args.out_dir else repo / "docs" / "audits" / "kimi-runs" / now_slug()
    out_dir.mkdir(parents=True, exist_ok=True)

    transcript = run_probe_matrix(args, repo, secret, out_dir)
    profiles = [item.strip() for item in args.profiles.split(",") if item.strip()]
    kimi_runs: list[dict[str, Any]] = []
    if args.with_kimi:
        if not shutil.which("kimi-agent"):
            kimi_runs.append({"profile": "all", "ok": False, "report": str(out_dir / "kimi-missing.md"), "error": "kimi-agent not found"})
            (out_dir / "kimi-missing.md").write_text("kimi-agent not found on PATH.\n")
        else:
            for profile in profiles:
                kimi_runs.append(
                    run_kimi(
                        profile,
                        build_kimi_prompt(profile, transcript, repo),
                        out_dir,
                        repo,
                        args.kimi_timeout,
                    )
                )

    aggregate(out_dir, transcript, kimi_runs, secret)
    print(out_dir)
    failed = [item for item in transcript["results"] if not item["ok"]]
    return 2 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
