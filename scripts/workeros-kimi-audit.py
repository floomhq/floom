#!/usr/bin/env python3
"""Run bounded Workeros adversarial probes, then ask Kimi to audit the evidence.

The important ordering is: live evidence first, Kimi interpretation second.
This avoids the failure mode where an LLM does code review and misses runtime
response-shape, auth, and deployment drift bugs.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import io
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import textwrap
import time
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
            "content": b"",
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
    if any(token in path for token in ("/runs", "/artifacts", "/download", "/bundle")):
        tags.append("run-data")
    if any(token in path for token in ("/secrets", "/system", "/settings")):
        tags.append("secret-or-config")
    if any(token in path for token in ("/workers", "/from-bundle", "/files")):
        tags.append("worker-surface")
    if any(token in path for token in ("/connections", "/composio", "/webhooks")):
        tags.append("oauth-or-webhook")
    if any(token in path for token in ("/cancel", "/clear", "/delete", "/rotate")):
        tags.append("destructive-or-state-transition")
    return tags


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


def absolute_path_zip(name: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("worker.yml", make_worker_yml(name))
        zf.writestr("/tmp/workeros-escape.txt", "x")
    return buf.getvalue()


def run_probe_matrix(args: argparse.Namespace, repo: Path, secret: str, out_dir: Path) -> dict[str, Any]:
    api = args.api_base.rstrip("/")
    local_api = args.local_api_base.rstrip("/")
    workers_dir = repo / "workers"
    results: list[dict[str, Any]] = []

    health = request(api, "GET", "/health")
    record(results, "health-public", health["status"] in (200, 403), f"status={health['status']}", health)

    no_auth = request(api, "GET", "/workers")
    record(results, "workers-require-auth", no_auth["status"] in (401, 403), f"status={no_auth['status']}", no_auth)

    system_noauth = {
        "info": request(api, "GET", "/system/info"),
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

    sweep_statuses = []
    for _ in range(5):
        r = request(api, "POST", "/system/sweep-connections", secret=secret)
        sweep_statuses.append(r["status"])
    sweep_ok = (
        sweep_statuses
        and sweep_statuses[0] in (200, 429)
        and all(status == 429 for status in sweep_statuses[1:])
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
    run_ids: list[str] = []
    if runs["status"] == 200:
        try:
            payload = json.loads(runs["body"])
            if isinstance(payload, list):
                run_ids = [str(item.get("id")) for item in payload if item.get("id")]
        except Exception:
            run_ids = []
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

    cancel_ok = runs["status"] == 200 and bool(run_ids)
    cancel_details: list[dict[str, Any]] = []
    if run_ids:
        existing_cancel = request(api, "POST", f"/runs/{run_ids[0]}/cancel", secret=secret)
        missing_cancel = request(api, "POST", "/runs/run_missing_cancel_probe/cancel", secret=secret)
        existing_body = existing_cancel["body"]
        missing_body = missing_cancel["body"]
        cancel_ok = (
            existing_cancel["status"] == 404
            and missing_cancel["status"] == 404
            and existing_body == missing_body
            and "completed" not in existing_body.lower()
            and run_ids[0] not in existing_body
        )
        cancel_details = [
            {"run_id": run_ids[0], "status": existing_cancel["status"], "body": snippet(existing_body, secret, 400)},
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

    runs_clear = request(api, "POST", "/runs/clear", secret=secret)
    record(
        results,
        "runs-clear-requires-confirm",
        runs_clear["status"] == 400 and "yes-wipe-all-runs" in runs_clear["body"],
        f"status={runs_clear['status']}",
        runs_clear,
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
        bundle_traversal.get("status") == 400,
        f"status={bundle_traversal.get('status')}",
        bundle_traversal,
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
        record(results, "local-health", local_health["status"] == 200, f"status={local_health['status']}", local_health)

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
        "mode": "bounded-live-prod-probes",
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
        f"# Workeros Kimi Audit Probe Results",
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
        lines.append("| Method | Path | Risk tags |")
        lines.append("|---|---|---|")
        for route in routes:
            tags = ", ".join(route.get("risk_tags") or [])
            lines.append(f"| `{route.get('method')}` | `{route.get('path')}` | {tags} |")
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
    route_lines = "\n".join(
        f"- {route.get('method')} {route.get('path')} tags={','.join(route.get('risk_tags') or [])}"
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
        - Audit only the live evidence below. Do not inspect the repo in this Kimi pass.
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
    parser.add_argument("--kimi-timeout", type=int, default=240)
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
