"""Run orchestration service with structured logging, observability, and secret scrubbing."""

import os
import uuid
import json
import threading
import re
import logging
import shutil
import time
import queue
import sqlite3
from html import escape
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Any, Callable, Optional
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------------------
# Concurrency gate — E2B has a hard cap of 20 concurrent sandboxes.
# We cap at WORKEROS_MAX_CONCURRENT_RUNS (default 18) to leave headroom for
# the workspace-agent /chat lane and manual smokes.
# ---------------------------------------------------------------------------

def _max_concurrent_runs() -> int:
    try:
        return max(1, int(os.environ.get("WORKEROS_MAX_CONCURRENT_RUNS", "18")))
    except ValueError:
        return 18

# Semaphore is initialised lazily on first use so that tests can override the
# env-var before importing this module.
_execution_semaphore: Optional[threading.Semaphore] = None
_semaphore_lock = threading.Lock()


def _get_semaphore() -> threading.Semaphore:
    global _execution_semaphore
    if _execution_semaphore is None:
        with _semaphore_lock:
            if _execution_semaphore is None:
                _execution_semaphore = threading.Semaphore(_max_concurrent_runs())
    return _execution_semaphore


def _semaphore_available_count() -> int:
    """Return an approximate count of free execution slots (best-effort)."""
    sem = _get_semaphore()
    # Semaphore._value is CPython internal but stable across 3.8-3.12.
    try:
        return max(0, sem._value)  # type: ignore[attr-defined]
    except AttributeError:
        return -1

from dotenv import load_dotenv

from contexts import context_scope_for_user, use_context_scope
from db.factory import Repositories, get_repositories
from runner_utils import ARTIFACTS_DIR, DEFAULT_TIMEOUT_SECONDS, _validate_output_schema
from worker_registry import WORKERS_DIR, get_worker_config
from runner_sandbox import get_driver as get_sandbox_driver
from models import (
    WorkerConfig,
    RunStatus,
    assert_safe_outbound_url,
    UnsafeOutboundUrlError,
    _allow_private_mcp_urls,
    _ip_is_disallowed,
    _resolve_host_ips,
)

import hashlib
import hmac
import http.client
import ipaddress
import socket as _socket
import urllib.parse
import urllib.request
import urllib.error

logger = logging.getLogger("floom.run_service")


def _resend_timeout_seconds() -> float:
    try:
        return max(0.1, float(os.environ.get("WORKEROS_RESEND_TIMEOUT_SECONDS", "10")))
    except ValueError:
        return 10.0


def _resend_send_with_timeout(resend_module: Any, payload: dict[str, Any]) -> None:
    timeout = _resend_timeout_seconds()
    result: "queue.Queue[BaseException | None]" = queue.Queue(maxsize=1)

    def _send() -> None:
        try:
            resend_module.Emails.send(payload)
            result.put(None)
        except BaseException as exc:
            result.put(exc)

    thread = threading.Thread(target=_send, daemon=True, name="workeros-resend-send")
    thread.start()
    thread.join(timeout=timeout)
    if thread.is_alive():
        raise TimeoutError(f"Resend email send exceeded {timeout:g}s timeout")
    outcome = result.get_nowait()
    if outcome is not None:
        raise outcome


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse to auto-follow 30x redirects.

    The alert-webhook POST pre-validates its target against the SSRF deny-list,
    but the default urllib opener follows 30x redirects WITHOUT re-validating the
    new target. A hostile public endpoint could answer
    ``302 Location: http://169.254.169.254/...`` and the blind POST would chase
    it straight into the metadata/internal target — a redirect-driven SSRF
    bypass. For a fire-and-forget alert webhook, NOT following redirects is the
    correct, safe behaviour: a 30x is just a non-2xx response that the caller
    logs and drops.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


# Opener used for all outbound alert-webhook POSTs. It does not follow
# redirects, so a 30x can never escape the pre-flight SSRF validation.
_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler)


# ---------------------------------------------------------------------------
# SSRF: DNS-rebinding-resistant IP pinning for alert-webhook delivery.
# ---------------------------------------------------------------------------
#
# `assert_safe_outbound_url` resolves the host and validates every resolved IP,
# but urllib then re-resolves the host at connect time. A hostile DNS server can
# answer the validation lookup with a public IP and the connect lookup with an
# internal/metadata IP (DNS rebinding) — a TOCTOU that bypasses the pre-flight
# check. We close it by resolving ONCE, validating that single IP, and dialing
# THAT pinned IP at the socket layer while preserving the original Host header
# and TLS SNI. The pinned IP is re-validated at socket-connect time, so even a
# bug in the pre-flight path cannot dial an internal address.


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that connects to a pre-validated, pinned IP.

    ``host`` keeps the original hostname (for the Host header); the socket is
    opened to ``_pinned_ip``. The pinned IP is re-validated against the SSRF
    deny-list at connect time (defense in depth against a stale/poisoned pin).
    """

    _pinned_ip: str = ""

    def connect(self) -> None:  # noqa: D401
        self._assert_pin_safe()
        self.sock = _socket.create_connection(
            (self._pinned_ip, self.port), self.timeout
        )

    def _assert_pin_safe(self) -> None:
        if _allow_private_mcp_urls():
            return
        try:
            ip_obj = ipaddress.ip_address(self._pinned_ip)
        except ValueError as exc:
            raise UnsafeOutboundUrlError(
                f"Alert webhook URL is not allowed: invalid pinned address {self._pinned_ip!r}"
            ) from exc
        if _ip_is_disallowed(ip_obj):
            raise UnsafeOutboundUrlError(
                "Alert webhook URL is not allowed: pinned address resolves to an "
                "internal/loopback/link-local address"
            )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection variant of :class:`_PinnedHTTPConnection`.

    Dials the pinned IP but keeps ``server_hostname`` = the original host so TLS
    SNI + certificate validation still match the intended domain.
    """

    _pinned_ip: str = ""

    def connect(self) -> None:  # noqa: D401
        _PinnedHTTPConnection._assert_pin_safe(self)  # type: ignore[arg-type]
        sock = _socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

    _assert_pin_safe = _PinnedHTTPConnection._assert_pin_safe


def _make_pinned_handler(host: str, pinned_ip: str):
    """Build a urllib handler whose http/https connections dial ``pinned_ip``."""

    class _PinnedHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):  # noqa: D401
            return self.do_open(_pinned_http_factory, req)

    class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):  # noqa: D401
            return self.do_open(_pinned_https_factory, req)

    def _pinned_http_factory(h, **kwargs):
        conn = _PinnedHTTPConnection(h, **kwargs)
        conn._pinned_ip = pinned_ip
        return conn

    def _pinned_https_factory(h, **kwargs):
        conn = _PinnedHTTPSConnection(h, **kwargs)
        conn._pinned_ip = pinned_ip
        return conn

    return _PinnedHTTPHandler(), _PinnedHTTPSHandler()


def _open_pinned_webhook(req: urllib.request.Request, *, timeout: int):
    """Open an alert-webhook POST with the host pinned to a single validated IP.

    Resolves the request host ONCE, validates the resolved IP(s) against the
    SSRF deny-list, picks the first allowed IP, and dials THAT IP (preserving
    Host header + TLS SNI). Closes the DNS-rebinding TOCTOU. Still refuses to
    follow redirects. Raises UnsafeOutboundUrlError if the host resolves only to
    disallowed addresses (fail closed).
    """
    host = urllib.parse.urlsplit(req.full_url).hostname or ""
    allow_private = _allow_private_mcp_urls()

    # IP literals were already validated by the pre-flight check; pin directly.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None

    if literal is not None:
        pinned_ip = host
    else:
        try:
            resolved = _resolve_host_ips(host)
        except (_socket.gaierror, _socket.timeout, OSError) as exc:
            raise UnsafeOutboundUrlError(
                f"Alert webhook URL is not allowed: host could not be resolved ({host})"
            ) from exc
        if allow_private:
            # Self-hoster opt-in: pin the first resolved IP without filtering.
            safe_ips = list(resolved)
        else:
            safe_ips = [ip for ip in resolved if not _ip_is_disallowed(ip)]
        if not safe_ips:
            raise UnsafeOutboundUrlError(
                "Alert webhook URL is not allowed: host resolves only to "
                f"internal/loopback/link-local addresses ({host})"
            )
        pinned_ip = str(safe_ips[0])

    http_handler, https_handler = _make_pinned_handler(host, pinned_ip)
    opener = urllib.request.build_opener(
        _NoRedirectHandler, http_handler, https_handler
    )
    return opener.open(req, timeout=timeout)


# Floom email logo (dark rounded-square play-arrow mark + "Floom" wordmark),
# hosted as a stable absolute https asset on the Floom OS marketing surface.
# Gmail requires an absolute https <img> src in email (data URIs are stripped).
FLOOM_EMAIL_LOGO_URL = "https://workers.floom.dev/brand/floom-email-logo@2x.png"


def _floom_run_email_html(
    *,
    worker_name: str,
    worker_id: str,
    run_id: str,
    status_label: str,
    timestamp: str,
    error: str | None,
) -> str:
    """Floom-branded run-notification email (matches the Cloud transactional design)."""
    is_failed = status_label.lower() == "failed"
    status_color = "#b4231f" if is_failed else "#1f7a4d"
    rows = [
        ("Worker", f"{worker_name} <span style=\"color:#6f6960;\">({worker_id})</span>"),
        ("Run ID", f"<span style=\"font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;\">{run_id}</span>"),
        ("Status", f"<span style=\"color:{status_color};font-weight:650;\">{status_label}</span>"),
        ("Time", timestamp),
    ]
    if error:
        rows.append(("Error", f"<span style=\"font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#b4231f;\">{error}</span>"))
    row_html = "".join(
        f"<tr><td style=\"padding:6px 0;font-size:13px;color:#6f6960;width:96px;vertical-align:top;\">{label}</td>"
        f"<td style=\"padding:6px 0;font-size:14px;color:#181716;\">{value}</td></tr>"
        for label, value in rows
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>Floom</title></head>
<body style="margin:0;padding:0;background:#fbfaf7;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#181716;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fbfaf7;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="background:#f1eee8;border:1px solid #ded8cf;border-bottom:none;border-radius:14px 14px 0 0;padding:26px 36px;border-top:2px solid #181716;">
<a href="https://workers.floom.dev" style="text-decoration:none;display:inline-block;"><img src="{FLOOM_EMAIL_LOGO_URL}" width="120" height="42" alt="Floom" style="display:block;border:0;outline:none;height:42px;width:120px;max-width:120px;"></a>
</td></tr>
<tr><td style="background:#fffefb;border:1px solid #ded8cf;border-top:none;border-radius:0 0 14px 14px;padding:36px 40px 40px;">
<p style="margin:0 0 10px;font-size:11px;line-height:1.4;font-weight:650;letter-spacing:0.12em;text-transform:uppercase;color:#6f6960;">Worker run</p>
<h1 style="margin:0 0 22px;font-size:22px;line-height:1.25;font-weight:650;color:#181716;">{worker_name} {status_label}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{row_html}</table>
<p style="font-size:13px;line-height:1.55;margin:24px 0 0;color:#6f6960;">You're receiving this because a worker run finished in your Floom workspace.</p>
</td></tr>
<tr><td style="padding:28px 4px 4px;font-size:12px;line-height:1.6;color:#6f6960;">
<a href="https://workers.floom.dev" style="color:#181716;font-weight:650;text-decoration:none;">Floom</a> &middot; <a href="mailto:team@floom.dev" style="color:#6f6960;text-decoration:underline;">team@floom.dev</a>
</td></tr>
</table>
</td></tr></table>
</body></html>"""


def _send_email_notification(
    *,
    to_addrs: list[str],
    worker_name: str,
    run_id: str,
    worker_id: str,
    status: str,
    error: str | None,
    subject_template: str | None = None,
) -> None:
    """Send a run-notification email via Resend (RESEND_API_KEY env var required)."""
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        logger.debug("RESEND_API_KEY not set — skipping email notification for run %s", run_id)
        return
    if not to_addrs:
        return

    from_addr = os.environ.get("NOTIFY_FROM_EMAIL", "notifications@workeros.floom.dev").strip()
    status_label = "failed" if status == "failed" else "completed"
    subject = (subject_template or "Worker {worker_name} {status}").format(
        worker_name=worker_name, status=status_label, run_id=run_id
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    safe_worker_name = escape(worker_name)
    safe_worker_id = escape(worker_id)
    safe_run_id = escape(run_id)
    safe_status_label = escape(status_label)
    safe_error = escape(error) if error else None

    html = _floom_run_email_html(
        worker_name=safe_worker_name,
        worker_id=safe_worker_id,
        run_id=safe_run_id,
        status_label=safe_status_label,
        timestamp=timestamp,
        error=safe_error,
    )

    text_lines = [
        f"Worker: {worker_name} ({worker_id})",
        f"Run ID: {run_id}",
        f"Status: {status_label}",
        f"Time: {timestamp}",
    ]
    if error:
        text_lines += ["", f"Error: {error}"]

    try:
        import resend
        resend.api_key = api_key
        _resend_send_with_timeout(resend, {
            "from": from_addr,
            "to": to_addrs,
            "subject": subject,
            "html": html,
            "text": "\n".join(text_lines),
        })
        logger.debug("Email notification sent via Resend to %s for run %s (%s)", to_addrs, run_id, status)
    except Exception as exc:
        logger.warning("Resend email notification failed for run %s: %s", run_id, exc)


def _fire_alert_webhooks(
    *,
    run_id: str,
    worker_id: str,
    status: str,
    error: str | None,
    repos: "Repositories",
) -> None:
    """Fire registered webhook and email alerts matching the run's terminal status.

    Runs in a daemon thread so it never blocks run finalisation.
    Errors are logged but never re-raised.
    """
    try:
        alert_rows = repos.alerts.list(worker_id=worker_id)
    except Exception as exc:
        logger.warning("Could not load alerts for worker %s: %s", worker_id, exc)
        return

    # Resolve worker name for email subjects
    try:
        w_row = repos.workers.get_any(worker_id=worker_id)
        worker_name = (w_row or {}).get("name", worker_id)
    except Exception:
        worker_name = worker_id

    payload = json.dumps({
        "run_id": run_id,
        "worker_id": worker_id,
        "worker_name": worker_name,
        "status": status,
        "error": error,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }).encode()

    for row in alert_rows:
        events = [e.strip() for e in (row.get("events") or "").split(",") if e.strip()]
        if status not in events and "all" not in events:
            continue

        # --- Webhook delivery ---
        url = (row.get("url") or "").strip()
        # SSRF guard (defense in depth): the URL was already validated at
        # alert-create time, but DNS can rebind between store and use, so we
        # re-validate here before dialing. Fail closed — never POST to an
        # internal/loopback/link-local/metadata target. A skipped webhook does
        # NOT skip the email channel for the same alert row.
        url_safe = False
        if url:
            try:
                assert_safe_outbound_url(url, label="Alert webhook URL")
                url_safe = True
            except UnsafeOutboundUrlError as exc:
                logger.warning("Skipping unsafe alert webhook URL for run %s: %s", run_id, exc)
        if url and url_safe:
            secret = row.get("secret")
            headers = {"Content-Type": "application/json", "X-Workeros-Run-Id": run_id}
            if secret:
                sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()  # type: ignore[attr-defined]
                headers["X-Workeros-Signature"] = f"sha256={sig}"
            try:
                req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
                # Bounded timeout — a hostile/slow endpoint must not hang the
                # alert daemon thread. `_open_pinned_webhook` resolves the host
                # ONCE, validates the IP, and dials THAT pinned IP (closing the
                # DNS-rebinding TOCTOU between the pre-flight check above and the
                # connect) while still refusing to follow redirects so a 30x
                # can't bounce the POST to an internal/metadata target.
                with _open_pinned_webhook(req, timeout=5):
                    pass
                logger.debug("Alert webhook delivered to %s for run %s (%s)", url, run_id, status)
            except Exception as exc:
                # Best-effort: a failed POST is logged but never crashes the
                # alert path or other channels.
                logger.warning("Alert webhook delivery failed for %s: %s", url, exc)

        # --- Email delivery ---
        email_to_raw = (row.get("email_to") or "").strip()
        if email_to_raw:
            try:
                to_addrs = json.loads(email_to_raw)
            except Exception:
                to_addrs = [e.strip() for e in email_to_raw.split(",") if e.strip()]
            _send_email_notification(
                to_addrs=to_addrs,
                worker_name=worker_name,
                run_id=run_id,
                worker_id=worker_id,
                status=status,
                error=error,
            )


def _dispatch_terminal_run_alerts(
    *,
    run_id: str,
    worker_id: str,
    status: str,
    error: str | None,
    user_id: str | None,
    repos: "Repositories",
) -> None:
    """Run all terminal status notifications without blocking run finalization."""
    if status not in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
        return

    def _deliver() -> None:
        _fire_alert_webhooks(
            run_id=run_id,
            worker_id=worker_id,
            status=status,
            error=error,
            repos=repos,
        )
        if status != RunStatus.FAILED.value:
            return
        try:
            from alerting import alert_worker_failure_if_needed

            alert_worker_failure_if_needed(worker_id)
        except Exception as exc:
            logger.warning(
                "Worker failure incident check failed for %s after run %s: %s",
                worker_id,
                run_id,
                exc,
            )
        _maybe_pause_worker_after_consecutive_failures(
            worker_id=worker_id,
            user_id=user_id,
            repos=repos,
        )

    threading.Thread(
        target=_deliver,
        daemon=True,
        name=f"alert-{run_id}",
    ).start()


def _schedule_retry(
    *,
    original_run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    attempt: int,
    delay_seconds: int,
    user_id: str | None,
    repos: "Repositories",
) -> None:
    """Enqueue a retry run after *delay_seconds* in a daemon thread."""

    def _do_retry() -> None:
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        try:
            retry_run_id = f"run_{uuid.uuid4().hex[:12]}"
            if user_id:
                repos.runs.create(
                    user_id=user_id,
                    run_id=retry_run_id,
                    worker_id=worker_id,
                    trigger_source="retry",
                    retry_of_run_id=original_run_id,
                    retry_attempt=attempt,
                )
                start_run(retry_run_id, worker_id, inputs, user_id=user_id, repos=repos)
                logger.info(
                    "Retry #%d enqueued as run %s for worker %s (original: %s)",
                    attempt, retry_run_id, worker_id, original_run_id,
                )
        except Exception as exc:
            logger.warning(
                "Failed to schedule retry #%d for run %s: %s",
                attempt, original_run_id, exc,
            )

    t = threading.Thread(target=_do_retry, daemon=True, name=f"retry-{original_run_id}")
    t.start()


def _schedule_retry_for_failed_run(
    *,
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    owner_id: str | None,
    config: Any,
    result_retryable: bool,
    repos: "Repositories",
    log_fn,
) -> bool:
    """Schedule a retry for a failed run when policy and attempt budget allow it."""
    if not owner_id:
        return False

    retry_cfg = getattr(config, "retry", None) if config else None
    if not retry_cfg and not result_retryable:
        return False

    current_run_row = repos.runs.get_any(run_id=run_id)
    current_attempt = int((current_run_row or {}).get("retry_attempt") or 0)
    max_attempts = retry_cfg.max_attempts if retry_cfg else 2
    if current_attempt >= max_attempts - 1:
        return False

    base_delay_seconds = retry_cfg.delay_seconds if retry_cfg else 60
    delay_seconds = base_delay_seconds
    if result_retryable:
        delay_seconds = min(base_delay_seconds * (2**current_attempt), 3600)

    label = "retryable failure" if result_retryable and not retry_cfg else "retry"
    log_fn(
        f"Scheduling {label} {current_attempt + 1}/{max_attempts - 1} in {delay_seconds}s",
        level="info",
    )
    _schedule_retry(
        original_run_id=run_id,
        worker_id=worker_id,
        inputs=inputs,
        attempt=current_attempt + 1,
        delay_seconds=delay_seconds,
        user_id=owner_id,
        repos=repos,
    )
    return True


API_ENV_PATH = Path("/root/.config/workeros/api.env")
_PLACEHOLDER_MARKERS = (
    "i don't have access",
    "i cannot fetch",
    "i can't fetch",
    "please provide an api key",
    "placeholder",
)
_PATH_VALUE_RE = re.compile(r"^(?:\.?/)?(?:out|outputs|output|artifacts|inputs)/[A-Za-z0-9._/@ -]+$")


class InsufficientDiskSpaceError(RuntimeError):
    """Raised when the API refuses run creation because local disk is too full."""


def _minimum_free_disk_bytes() -> int:
    raw = os.environ.get("WORKEROS_MIN_FREE_DISK_BYTES", str(1024 * 1024 * 1024))
    try:
        return max(0, int(raw))
    except ValueError:
        return 1024 * 1024 * 1024


# The meta-worker whose completed runs auto-register the worker they drafted.
# Mirrors main._WORKER_AUTHOR_ID (asserted equal in tests).
_WORKER_AUTHOR_WORKER_ID = "worker-author"


def _find_bundle_artifact(run_id: str, artifacts: list[Dict[str, Any]]) -> Optional[Path]:
    """Locate the worker-author bundle.json on local disk.

    The E2B driver downloads ``out/bundle.json`` into
    ``ARTIFACTS_DIR/<run_id>/out/bundle.json`` and records the artifact with
    ``relative_path == "out/bundle.json"`` and an absolute ``path``. Fall back
    to the conventional location if the artifact list is unexpectedly empty.
    """
    for art in artifacts or []:
        rel = str(art.get("relative_path") or "")
        name = str(art.get("name") or "")
        if rel == "out/bundle.json" or name == "bundle.json" or rel.endswith("/bundle.json"):
            candidate = art.get("path")
            if candidate and Path(candidate).is_file():
                return Path(candidate)
    fallback = (ARTIFACTS_DIR / run_id / "out" / "bundle.json")
    return fallback if fallback.is_file() else None


def _read_authored_bundle(
    run_id: str, artifacts: list[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """Re-read the worker-author bundle.json (for the post-registration smoke)."""
    bundle_path = _find_bundle_artifact(run_id, artifacts)
    if bundle_path is None:
        return None
    try:
        data = json.loads(bundle_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _normalize_authored_worker_yml(worker_yml: str, log_fn: Callable[..., None]) -> str:
    """Strip optional metadata that violates the WorkerContract schema so an
    otherwise-valid drafted worker still registers.

    Only touches DISPLAY metadata (lossless to function):
      - ``use_cases``: must be 3-5 non-empty items, else dropped.
      - ``tags``: must be <= 8 flat non-empty strings, else dropped.

    Returns the (possibly rewritten) YAML; on any parse error returns the
    input unchanged so the normal validation path reports the real error.
    """
    try:
        import yaml as pyyaml
        raw = pyyaml.safe_load(worker_yml)
    except Exception:
        return worker_yml
    if not isinstance(raw, dict):
        return worker_yml

    changed = False

    use_cases = raw.get("use_cases")
    if use_cases is not None:
        ok = (
            isinstance(use_cases, list)
            and 3 <= len(use_cases) <= 5
            and all(isinstance(u, str) and u.strip() for u in use_cases)
        )
        if not ok:
            raw.pop("use_cases", None)
            changed = True
            log_fn("Dropped invalid use_cases from drafted worker (schema requires 3-5 items)", level="warning")

    tags = raw.get("tags")
    if tags is not None:
        ok = (
            isinstance(tags, list)
            and len(tags) <= 8
            and all(isinstance(t, str) and t.strip() and "/" not in t for t in tags)
        )
        if not ok:
            raw.pop("tags", None)
            changed = True
            log_fn("Dropped invalid tags from drafted worker (schema requires <=8 flat strings)", level="warning")

    # gen-quality (2026-05-29): the LLM makes a small set of recurring
    # input/output DECLARATION mistakes that hard-fail registration and dead-end
    # the operator. We fix the ENGINE (not just the generation prompt, which is
    # non-deterministic), losslessly, for every input and output field:
    #   1. type-in-kind-slot: kind is actually a scalar TYPE value (textarea,
    #      string, number, ...) -> set kind:scalar and move the value to `type`.
    #   2. scalar + file markers: kind:scalar but carries path/media_type and no
    #      type -> the run.py returns the literal value, so resolve to a clean
    #      scalar (strip the stray file markers, default type:string).
    #   3. scalar missing type: kind:scalar (or no kind + no file markers) and no
    #      type -> default type:string.
    _SCALAR_TYPES = {"string", "textarea", "number", "boolean", "select", "url"}

    def _fix_fields(fields: Any) -> bool:
        touched = False
        if not isinstance(fields, list):
            return False
        for field in fields:
            if not isinstance(field, dict):
                continue
            kind = str(field.get("kind") or "").strip().lower()
            ftype = str(field.get("type") or "").strip().lower()
            has_file_markers = bool(field.get("path") or field.get("media_type"))
            # (0) missing kind + file markers (or legacy type:file) -> file.
            # WorkerContractField defaults missing kind to scalar; a generated
            # output like `{media_type, path}` without `kind:file` then rejects
            # as "scalar cannot declare media_type/path". Preserve the functional
            # declaration by making the intended file kind explicit.
            if not kind and (has_file_markers or ftype == "file"):
                field["kind"] = "file"
                kind = "file"
                touched = True
            if kind == "file" and field.get("type") and ftype != "file":
                field.pop("type", None)
                touched = True
            if kind == "file":
                if field.get("media_type") and not field.get("path"):
                    safe_name = str(field.get("name") or "result").strip() or "result"
                    ext = ".json" if str(field.get("media_type")).lower() == "application/json" else ".txt"
                    field["path"] = f"out/{safe_name}{ext}"
                    touched = True
                continue
            # (1) type-in-kind-slot (e.g. kind: textarea) -> kind:scalar + type.
            if kind in _SCALAR_TYPES:
                if not field.get("type"):
                    field["type"] = kind
                field["kind"] = "scalar"
                kind = "scalar"
                touched = True
            # (2) contradictory scalar + file markers -> clean scalar.
            if kind == "scalar" and has_file_markers:
                field.pop("path", None)
                field.pop("media_type", None)
                if not field.get("type"):
                    field["type"] = "string"
                touched = True
                continue
            # (3) scalar missing the required type -> default string.
            is_scalar = kind == "scalar" or (not kind and not has_file_markers)
            if is_scalar and not field.get("type") and not has_file_markers:
                field["type"] = "string"
                touched = True
            if field.get("type") == "select" and not (field.get("options") or field.get("enum")):
                field["type"] = "string"
                touched = True
        return touched

    for block, key in ((raw, "inputs"), (raw, "outputs")):
        if _fix_fields(block.get(key)):
            changed = True
            log_fn(f"Normalized generated {key} kind/type so the worker registers", level="info")
    exec_block = raw.get("exec")
    if isinstance(exec_block, dict):
        for key in ("inputs", "outputs"):
            if _fix_fields(exec_block.get(key)):
                changed = True
                log_fn(f"Normalized generated {key} kind/type so the worker registers", level="info")

    if not changed:
        return worker_yml
    import yaml as pyyaml
    return pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False)


def _backfill_example_input(worker_yml: str, sample_input_json: Any, log_fn: Callable[..., None]) -> str:
    """Ensure the drafted worker.yml carries an ``example_input`` block so the
    "Fill with sample input" button is one-click runnable, even when the LLM
    omits it (G5 FIX 4).

    The generator already emits ``sample_input_json`` (realistic values used for
    the smoke run). If the worker.yml has no usable ``example_input``, backfill
    it from that sample so EVERY generated worker — including file-input ones —
    ships a runnable sample. Lossless: only adds, never overwrites an existing
    example_input. Returns the (possibly rewritten) YAML; input unchanged on any
    parse error."""
    try:
        import yaml as pyyaml
        raw = pyyaml.safe_load(worker_yml)
    except Exception:
        return worker_yml
    if not isinstance(raw, dict):
        return worker_yml

    existing = raw.get("example_input")
    if isinstance(existing, dict) and existing:
        return worker_yml  # LLM already supplied one — keep it.

    sample: Optional[Dict[str, Any]] = None
    if isinstance(sample_input_json, str) and sample_input_json.strip():
        try:
            parsed = json.loads(sample_input_json)
            if isinstance(parsed, dict) and parsed:
                sample = parsed
        except json.JSONDecodeError:
            sample = None
    elif isinstance(sample_input_json, dict) and sample_input_json:
        sample = dict(sample_input_json)

    if not sample:
        # Final fallback: synthesize a type-appropriate value for every declared
        # input straight from the worker's own schema, so EVERY worker is
        # one-click runnable even when the LLM returns no sample at all.
        sample = _synthesize_example_input_from_schema(raw)
        if not sample:
            return worker_yml
        log_fn("Synthesized example_input from the worker's input schema (no LLM sample)", level="info")
    else:
        log_fn("Backfilled example_input from sample_input_json so the worker is one-click runnable", level="info")

    raw["example_input"] = sample
    try:
        import yaml as pyyaml
        return pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False)
    except Exception:
        return worker_yml


def _synthesize_example_input_from_schema(manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Build a minimal, type-appropriate example_input from a worker manifest's
    declared inputs. Used as the last-resort sample so file-input workers (and
    any worker) are one-click runnable when no LLM sample is available.

    File inputs get small inline TEXT content (a CSV for text/csv, else a couple
    of plain-text lines); scalars get the same type-appropriate placeholders the
    smoke runner uses. Returns {} when there are no usable inputs."""
    inputs = None
    exec_block = manifest.get("exec")
    if isinstance(exec_block, dict) and isinstance(exec_block.get("inputs"), list):
        inputs = exec_block["inputs"]
    elif isinstance(manifest.get("inputs"), list):
        inputs = manifest["inputs"]
    if not inputs:
        return {}

    sample: Dict[str, Any] = {}
    for inp in inputs:
        if not isinstance(inp, dict):
            continue
        name = inp.get("name")
        if not name:
            continue
        itype = str(inp.get("type") or "").strip().lower()
        kind = str(inp.get("kind") or "").strip().lower()
        media = str(inp.get("media_type") or "").strip().lower()
        is_file = itype == "file" or kind == "file"
        if is_file:
            if "csv" in media:
                sample[name] = "name,value\nalice,1\nbob,2\n"
            elif "json" in media:
                sample[name] = '{"example": "value"}'
            else:
                sample[name] = "alice\nbob\ncharlie\n"
        elif itype in ("list", "array"):
            sample[name] = [3, 1, 2]
        elif itype in ("object", "dict", "json"):
            sample[name] = {"key": "value"}
        elif itype == "number":
            sample[name] = 1
        elif itype == "boolean":
            sample[name] = True
        else:
            sample[name] = "sample"
    return sample


def _register_authored_worker(
    run_id: str,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
) -> Optional[str]:
    """Register the worker drafted by a completed worker-author run.

    Reads the run's ``bundle.json`` artifact (produced by
    ``workers/worker-author/run.py``), assembles the worker bundle files
    (worker.yml + SKILL.md or run.py + requirements.txt), and registers them
    through the shared ``main._register_worker_from_files`` path. Returns the
    new ``worker_id`` (or None if the bundle is missing / invalid — in which
    case the run still completes and the bundle stays viewable).

    Idempotency: if the run output already carries a ``created_worker_id``
    (e.g. a resumed/re-executed run), no second worker is created.
    """
    started_at = time.perf_counter()
    if isinstance(outputs, dict) and outputs.get("created_worker_id"):
        return str(outputs["created_worker_id"])  # already registered

    stage_at = time.perf_counter()
    bundle_path = _find_bundle_artifact(run_id, artifacts)
    if bundle_path is None:
        log_fn("worker-author produced no bundle.json — nothing to register", level="warning")
        return None
    log_fn(f"worker-author registration: found bundle artifact in {time.perf_counter() - stage_at:.2f}s")

    try:
        stage_at = time.perf_counter()
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log_fn(f"worker-author bundle.json unreadable: {exc}", level="warning")
        return None
    if not isinstance(bundle, dict):
        log_fn("worker-author bundle.json is not an object", level="warning")
        return None
    log_fn(f"worker-author registration: parsed bundle in {time.perf_counter() - stage_at:.2f}s")

    # If the author could not produce valid YAML after its retries it embeds an
    # `error`. Don't register a broken worker; leave the run viewable so the
    # operator sees the drafted (broken) bundle. This is the rare degenerate
    # case (LLM retries 3x first).
    if bundle.get("error"):
        log_fn(
            f"worker-author bundle has a validation error, not auto-registering: {bundle['error']}",
            level="warning",
        )
        return None

    worker_yml = (bundle.get("worker_yml") or "").strip()
    if not worker_yml:
        log_fn("worker-author bundle missing worker_yml — nothing to register", level="warning")
        return None

    # Safety-net: the worker-author LLM validates the YAML with its own loose
    # check, which is weaker than the canonical WorkerContract schema enforced
    # at registration. The common drift is OPTIONAL metadata (use_cases must be
    # 3-5 items, tags <= 8 flat strings). Strip violating optional metadata so a
    # functionally-valid worker still registers instead of dead-ending. This is
    # lossless to behaviour (these fields are display metadata only).
    stage_at = time.perf_counter()
    worker_yml = _normalize_authored_worker_yml(worker_yml, log_fn)
    # G5 FIX 4: guarantee a runnable sample even when the LLM omits example_input.
    worker_yml = _backfill_example_input(worker_yml, bundle.get("sample_input_json"), log_fn)
    log_fn(f"worker-author registration: normalized manifest in {time.perf_counter() - stage_at:.2f}s")

    skill_md = bundle.get("skill_md")
    run_code = bundle.get("run_code")
    requirements_txt = bundle.get("requirements_txt")

    # A bundle with NEITHER agent-mode SKILL.md NOR script-mode run.py has nothing
    # executable. Registering it would backfill the placeholder run.py stub, which
    # returns success with empty outputs — i.e. a worker that "runs green" yet does
    # nothing (the worst failure for the operator: it looks ready). Surface as
    # un-registered (the run + drafted bundle stay viewable) instead of shipping a
    # silent no-op. The strengthened generation prompt makes this rare.
    _skill_src = skill_md if isinstance(skill_md, str) else ""
    _code_src = run_code if isinstance(run_code, str) else ""
    if not _skill_src.strip() and not _code_src.strip():
        log_fn(
            "worker-author bundle has neither SKILL.md nor run.py — not registering "
            "a no-op worker; the drafted bundle stays viewable",
            level="warning",
        )
        return None

    # Lazy import: main imports run_service at startup, so importing main here
    # (at run-completion time, long after startup) avoids the circular import.
    import main as _main

    files = [_main.DraftFile(path="worker.yml", content=worker_yml)]
    if isinstance(skill_md, str) and skill_md.strip():
        files.append(_main.DraftFile(path="SKILL.md", content=skill_md))
    if isinstance(run_code, str) and run_code.strip():
        files.append(_main.DraftFile(path="run.py", content=run_code))
    if isinstance(requirements_txt, str) and requirements_txt.strip():
        files.append(_main.DraftFile(path="requirements.txt", content=requirements_txt))

    stage_at = time.perf_counter()
    worker_id = _main._register_worker_from_files(
        files,
        user_id=user_id,
        repos=repos,
        dedupe_id=True,
    )
    log_fn(
        f"Registered worker {worker_id!r} from drafted bundle "
        f"in {time.perf_counter() - stage_at:.2f}s "
        f"(registration total {time.perf_counter() - started_at:.2f}s)"
    )
    return worker_id


# ---------------------------------------------------------------------------
# Post-generation smoke + bounded repair (the wedge safety net, 2026-05-29)
# ---------------------------------------------------------------------------
# A generated SCRIPT-mode worker must be PROVEN to run before the operator is
# told it is ready. After registration we run ONE real E2B smoke execution with
# the bundle's sample input. If it fails with a code-class error, we make a
# bounded repair pass (max 1): feed the run.py + the failure to a focused model
# call, rewrite run.py on disk, re-smoke. We never loop unbounded, never spawn
# more than one sandbox at a time (the smoke runs inline on the author run's
# already-acquired execution slot), and never silently ship a broken worker —
# the outcome is recorded on the author run output as ``smoke``.

_MAX_SMOKE_REPAIRS = 1

# Distinctive prefix of main._DEFAULT_RUN_PY_STUB's comment. A generated script
# worker whose run.py is the placeholder stub does nothing (it writes a success
# result.json with empty outputs and would otherwise PASS the smoke green).
_PLACEHOLDER_RUN_PY_MARKER = "# Placeholder worker"

# Failure error_codes that mean the worker's own code is broken (worth a repair
# attempt). Setup/auth/secret/connection failures are NOT code bugs.
#
# output_validation_failed (2026-05-29, gen-quality): a worker that ran GREEN but
# wrote a PATH into a SCALAR output (or an empty/missing declared output) is a
# CODE bug — the generated logic confused the scalar-vs-file output contract.
# Routing it into the bounded repair loop (with the corrected contract in the
# repair prompt) lets it self-heal instead of gating on the first try. The gate
# remains the fallback if repair still fails (0-silently-broken still HOLDs).
_SMOKE_CODE_FAILURE_CODES = frozenset(
    {"execution_error", "e2b_sandbox_error", "missing_result", "output_validation_failed"}
)

_SMOKE_REPAIR_SYSTEM_PROMPT = (
    "You fix Workeros script-mode worker run.py files. The script runs as "
    "`python run.py` in an E2B sandbox and MUST:\n"
    "- read inputs.json via json.load(open('inputs.json'));\n"
    "- treat SCALAR inputs as the literal value inline (never open() them); a "
    "FILE input's value IS already the relative path (e.g. 'inputs/csv_file') so "
    "open(inputs['x']) directly — NEVER os.path.join('inputs', inputs['x']);\n"
    "- use ONLY the Python standard library. NEVER `import dotenv` / "
    "`from dotenv import ...` (it is NOT installed -> ModuleNotFoundError). Read "
    "secrets from os.environ with a secrets.json fallback. If you import any "
    "third-party lib it would also need a requirements entry, so prefer stdlib;\n"
    "- import EVERY module it references (os, json, csv, io, re, statistics, ...);\n"
    "- OUTPUT CONTRACT (scalar vs file — the INVERSE of the input contract). For "
    "each declared output, match its kind:\n"
    "    * SCALAR output (kind 'scalar', no path) -> outputs[name] is the LITERAL "
    "VALUE (a string or number), NOT a path. No out/ file, no artifact. "
    "e.g. outputs={'reversed':'olleh'}. Writing a path string like "
    "'out/reversed.txt' into a scalar output FAILS with 'scalar output leaked a "
    "path string' — return the value itself instead.\n"
    "    * FILE output (kind 'file', has a path) -> write the file under out/ "
    "(mkdir it) and put its RELATIVE PATH in outputs[name] plus one matching "
    "artifacts[] entry, e.g. outputs={'report':'out/report.csv'};\n"
    "- write result.json to the WORKING DIRECTORY ('result.json'), NOT "
    "'out/result.json' (writing it under out/ makes the run produce no result);\n"
    "- result.json schema: {\"status\":\"success\"|\"error\",\"outputs\":"
    "{<name>:<literal-value-for-scalar OR out/path-for-file>},\"artifacts\":"
    "[{\"name\",\"relative_path\",\"type\"}],\"error\":<msg on error>} on BOTH "
    "success and error paths;\n"
    "- end with `if __name__ == \"__main__\": main()`.\n"
    "The failure message tells you exactly what broke — fix THAT. If it says "
    "'scalar output leaked a path string', return the literal value in that "
    "output instead of a path. If it says example_output mismatch, change the "
    "logic so the declared example_input produces the declared example_output. "
    "Return ONLY the corrected, complete run.py file. "
    "No markdown fences, no commentary."
)


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        stripped = "\n".join(lines).strip()
    return stripped


def _build_smoke_inputs(
    config: WorkerConfig,
    bundle: Dict[str, Any],
    tmp_dir: Path,
) -> Dict[str, Any]:
    """Build inputs for the smoke run from the bundle's sample input.

    Scalar inputs use the sample literal (or a deterministic default). File
    inputs are materialised as a temp file (the driver only needs an absolute
    local file path) seeded with the sample value or a small placeholder.
    """
    sample: Dict[str, Any] = {}
    raw_sample = bundle.get("sample_input_json")
    if isinstance(raw_sample, str) and raw_sample.strip():
        try:
            parsed = json.loads(raw_sample)
            if isinstance(parsed, dict):
                sample = parsed
        except json.JSONDecodeError:
            sample = {}
    if not sample and isinstance(bundle.get("example_input"), dict):
        sample = dict(bundle["example_input"])
    if not sample:
        worker_yml = bundle.get("worker_yml")
        if isinstance(worker_yml, str) and worker_yml.strip():
            try:
                import yaml as pyyaml

                raw_manifest = pyyaml.safe_load(worker_yml) or {}
                manifest_sample = (
                    raw_manifest.get("example_input") if isinstance(raw_manifest, dict) else None
                )
                if isinstance(manifest_sample, dict):
                    sample = dict(manifest_sample)
            except Exception:
                sample = {}

    inputs: Dict[str, Any] = {}
    for inp in config.inputs:
        is_file = (inp.type == "file") or (getattr(inp, "kind", None) == "file")
        if is_file:
            seed = sample.get(inp.name)
            content = seed if isinstance(seed, str) and seed.strip() else "sample,value\n1,2\n"
            staged = tmp_dir / f"{inp.name}.dat"
            staged.write_text(content, encoding="utf-8")
            inputs[inp.name] = str(staged.resolve())
            continue
        if inp.name in sample:
            inputs[inp.name] = sample[inp.name]
        elif inp.default is not None:
            inputs[inp.name] = inp.default
        elif inp.required:
            # Deterministic, TYPE-APPROPRIATE placeholder so a required input
            # never blocks the smoke on a missing-input gate AND a list-typed
            # worker is not false-disabled by feeding it a bare string (e.g. a
            # median-of-a-list worker received "sample" and crashed on
            # float("s"), getting wrongly gated). Number/string keep their prior
            # placeholders ("1"/"sample") to avoid regressing existing workers.
            itype = (inp.type or "").strip().lower()
            if itype in ("list", "array"):
                inputs[inp.name] = [3, 1, 2]
            elif itype in ("object", "dict", "json"):
                inputs[inp.name] = {"key": "value"}
            elif itype == "number":
                inputs[inp.name] = 1
            else:
                inputs[inp.name] = "sample"
    return inputs


def _repair_run_py(
    *,
    run_code: str,
    failure: str,
    secrets: Dict[str, str],
    log_fn: Callable[..., None],
    intent: str = "",
) -> Optional[str]:
    """Ask a focused model call to fix a broken script-mode run.py.

    ``intent`` is the worker's own description/long_description so the repair can
    fix UNDER-implementation (declared outputs the generator only partly filled),
    not just syntax/contract bugs.

    Returns the corrected file, or None if no key / call failed / no change.
    """
    api_key = secrets.get("OPENAI_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        log_fn("Smoke repair skipped: no OPENAI_API_KEY available", level="warning")
        return None
    try:
        from openai import OpenAI

        from codegen_model import chat_completion_codegen

        client = OpenAI(api_key=api_key)
        user_content = (
            "This run.py failed its first run with:\n"
            f"{failure[:1500]}\n\n"
        )
        if intent:
            # Feed the worker's INTENT so the repair can fix UNDER-implementation
            # (a worker that ran green but only produced part of what the prompt
            # asked for), not just syntax/contract bugs.
            user_content += f"The worker is supposed to do this:\n{intent[:1200]}\n\n"
        user_content += (
            "Here is the current run.py:\n\n"
            f"{run_code[:8000]}\n\n"
            "Return the corrected complete run.py. Implement EVERY declared "
            "output fully — if the task asks for multiple outputs, produce all "
            "of them, not just the first."
        )
        resp = chat_completion_codegen(
            client,
            messages=[
                {"role": "system", "content": _SMOKE_REPAIR_SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.0,
            max_output_tokens=6000,
        )
        fixed = _strip_code_fences(resp.choices[0].message.content or "")
    except Exception as exc:  # pragma: no cover - network/SDK variance
        log_fn(f"Smoke repair model call failed: {exc}", level="warning")
        return None

    if not fixed or fixed.strip() == run_code.strip():
        return None
    # Reject output that is not syntactically valid Python — never write a worse
    # file over a bad one.
    try:
        import ast

        ast.parse(fixed)
    except SyntaxError:
        log_fn("Smoke repair produced invalid Python; discarding", level="warning")
        return None
    return fixed


def _smoke_and_repair_generated_worker(
    worker_id: str,
    bundle: Dict[str, Any],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
    allow_code_repair: bool = True,
) -> Dict[str, Any]:
    """Prove a generated SCRIPT-mode worker runs; repair (bounded) if it doesn't.

    Returns a small dict suitable for the author run output ``smoke`` field:
      {"status": "passed"|"failed"|"skipped", "reason": <str>, "repairs": <int>}
    Never raises — a smoke failure must not crash the author run.

    ``allow_code_repair`` (least-surprise gate, 2026-05-29): when True (the
    LLM-generated worker-author / draft-from-prompt path) a code-class failure
    triggers the bounded auto-repair of run.py — that self-heal is the product
    wedge. When False (USER-SUPPLIED files via the upload flow) the worker is
    STILL smoked and gated, but the user's run.py is NEVER rewritten: a code
    failure is surfaced as a smoke failure (the caller disables + surfaces the
    calm reason) so the operator edits their own code. Silently mutating
    user-provided code would change its semantics without consent.
    """
    started_at = time.perf_counter()
    repos_obj = _repos(repos)
    loaded = _load_worker_recipe(worker_id, repos_obj)
    if not loaded:
        return {"status": "skipped", "reason": "worker recipe not found"}
    config = loaded[1]

    # Gate == runtime (Codex P1, 2026-06-04): a DISABLED worker (manifest
    # ``paused: true`` / ``enabled: false``) is REJECTED by create_run with
    # "Worker is disabled" — so we must NOT smoke it green and let the caller
    # report it "verified runnable". The recipe's instance row carries the
    # effective enabled flag (the manifest's ``paused`` is projected into it).
    # Surface as skipped (not failed): the worker is intentionally off, not broken.
    instance = loaded[2] if len(loaded) > 2 else None
    if isinstance(instance, dict) and instance.get("enabled") is False:
        return {
            "status": "skipped",
            "reason": "worker is disabled (paused) — enable it before it can run",
        }

    runtime = config.runtime
    mode = runtime.mode if runtime else "pure-script"
    entry = (runtime.entrypoint if runtime else "") or ""
    is_script = mode == "pure-script" and entry.lower().endswith(
        (".py", ".sh", ".js")
    )
    if not is_script:
        return {"status": "skipped", "reason": "not a script-mode worker"}

    # A run.py worker whose run.py is the placeholder stub does nothing: the stub
    # writes a success result.json with empty outputs, so a plain smoke run would
    # report PASSED. Catch it BEFORE running (and before the secret/connection
    # skip gates) and surface as failed — the operator must re-generate or edit,
    # never see a green-but-empty worker. Only when the EXECUTED entry is run.py:
    # a run.js / run.sh / multi-file Python worker executes its own entry, and a
    # stale placeholder run.py on disk must NOT fail it (Codex P1 — that would
    # disable a perfectly good Node/shell worker that never runs run.py).
    executes_run_py = entry.strip().lower() == "run.py"
    if executes_run_py:
        try:
            if _PLACEHOLDER_RUN_PY_MARKER in (WORKERS_DIR / worker_id / "run.py").read_text(
                encoding="utf-8"
            ):
                log_fn(
                    "Smoke failed — generated worker has only the placeholder stub, no real code",
                    level="warning",
                )
                return {
                    "status": "failed",
                    "reason": "generation produced no script code — re-generate or edit the worker",
                    "repairs": 0,
                }
        except OSError:
            pass

    secrets = get_secrets_for_worker(worker_id, user_id=user_id, repos=repos_obj)
    missing = [s for s in config.secrets if s not in secrets]
    if missing:
        # Can't prove a run without its credentials; surface, don't fail.
        reason = f"needs a credential before it can run ({', '.join(missing)})"
        log_fn(f"Smoke skipped — generated worker {reason}", level="warning")
        return {"status": "skipped", "reason": reason}

    connection_ids: Dict[str, str] = {}
    if config.connections:
        return {
            "status": "skipped",
            "reason": "needs a connected account before it can run",
        }

    worker_dir = WORKERS_DIR / worker_id
    run_py_path = worker_dir / "run.py"

    repairs = 0
    last_failure = ""
    tmp_root = Path(ARTIFACTS_DIR) / f".smoke-{uuid.uuid4().hex[:12]}"
    tmp_root.mkdir(parents=True, exist_ok=True)
    try:
        runner = runtime.runner if runtime else "e2b"
        timeout_seconds = (
            runtime.limits.timeout_seconds
            if runtime and runtime.limits
            else 120
        )
        # Cap the smoke below a normal run; a generated worker's first proof run
        # must not dominate worker creation latency.
        timeout_seconds = min(int(timeout_seconds), 90)
        log_fn(f"Smoke budget for generated worker is {timeout_seconds}s", level="info")

        while True:
            smoke_inputs = _build_smoke_inputs(config, bundle, tmp_root)
            smoke_run_id = f"smoke_{uuid.uuid4().hex[:16]}"

            def _smoke_log(msg: str, level: str = "debug") -> None:
                log_fn(f"[smoke] {msg}", level=level)

            try:
                driver = get_sandbox_driver(runner, config=config)
                attempt_started_at = time.perf_counter()
                with use_context_scope(context_scope_for_user(user_id)):
                    result = driver.run(
                        worker_id=worker_id,
                        run_id=smoke_run_id,
                        inputs=smoke_inputs,
                        secrets=secrets,
                        log_fn=_smoke_log,
                        trace_id=f"smoke_{uuid.uuid4().hex[:12]}",
                        timeout_seconds=timeout_seconds,
                        config=config,
                        connection_ids=connection_ids,
                        user_id=user_id,
                    )
                log_fn(
                    f"Smoke attempt {repairs + 1} completed in "
                    f"{time.perf_counter() - attempt_started_at:.2f}s",
                    level="info",
                )
            except Exception as exc:  # pragma: no cover - driver/infra variance
                last_failure = str(exc)
                log_fn(f"Smoke run raised: {exc}", level="warning")
                result = None

            substance_error: str | None = None
            if result is not None and result.status not in ("error", "failed"):
                # The worker reported success — but "success" with an empty or
                # missing declared output is a silent no-op (green-but-empty),
                # the worst failure mode for the operator. Validate with the
                # EXACT SAME two-stage gate a real run uses (execute_run): first
                # _validate_output_schema (scalar type/CSV-column/json_required_keys
                # contracts), then _validate_run_outputs (file existence/substance).
                # Running ONLY _validate_run_outputs here let a scalar `type: json`
                # output that is non-empty but not valid JSON pass smoke and then
                # fail every real run with schema_violation — the exact gate-vs-
                # runtime lie this fix exists to kill. Both stages, same order.
                result_outputs = dict(result.outputs or {})
                result_artifacts = list(result.artifacts or [])
                try:
                    _materialize_declared_file_outputs(
                        smoke_run_id, config, result_outputs, result_artifacts
                    )
                except Exception:
                    pass
                substance_error = _validate_output_schema(
                    worker_id, result_outputs, _smoke_log, config=config
                )
                if substance_error is None:
                    substance_error, _smoke_warnings = _validate_run_outputs(
                        smoke_run_id, config, result_outputs, result_artifacts
                    )
                if substance_error is None:
                    substance_error = _validate_example_output(
                        smoke_run_id, config, bundle, result_outputs, result_artifacts
                    )
                if substance_error is None:
                    # A required output that parses as JSON but is an EMPTY
                    # container (``[]`` / ``{}`` / ``""`` / null) is the
                    # green-but-empty no-op: valid JSON, zero substance. The
                    # normal-run validator accepts it (an empty list can be a
                    # legitimate "no results" answer), but at SMOKE time the
                    # sample input is non-trivial, so an empty result means the
                    # generated logic did nothing — route it into the repair loop.
                    substance_error = _smoke_empty_output_error(
                        smoke_run_id, config, result_outputs, result_artifacts
                    )

            if (
                result is not None
                and result.status not in ("error", "failed")
                and substance_error is None
            ):
                msg = (
                    "Smoke passed — generated worker ran successfully"
                    + (f" after {repairs} repair(s)" if repairs else "")
                )
                log_fn(f"{msg} (smoke total {time.perf_counter() - started_at:.2f}s)")
                return {"status": "passed", "reason": "", "repairs": repairs}

            # Failure: decide whether it's a code bug worth repairing.
            if substance_error is not None:
                # Ran green but produced no real output — treat as a code bug so
                # the generator gets a bounded chance to fix the logic.
                last_failure = (
                    f"{substance_error} "
                    "(worker reported success but produced no real output)"
                )
                code_failure = True
            elif result is not None:
                last_failure = (
                    f"{result.error or 'run failed'} "
                    f"(error_code={result.error_code or 'unknown'})"
                )
                code_failure = (result.error_code or "").lower() in _SMOKE_CODE_FAILURE_CODES
            else:
                code_failure = True  # driver raised; treat as code-class

            if not allow_code_repair or not code_failure or repairs >= _MAX_SMOKE_REPAIRS:
                # User-supplied code (allow_code_repair=False) is gated on its
                # first-run result but NEVER rewritten — the operator owns and
                # edits their own run.py. LLM-generated code exhausts its bounded
                # repair budget here too.
                if not allow_code_repair and code_failure:
                    log_fn(
                        "Smoke failed — uploaded worker did not run on first try: "
                        f"{last_failure}. Edit it, then re-run. (Your code was not modified.)",
                        level="warning",
                    )
                else:
                    log_fn(
                        f"Smoke failed — generated worker did not run on first try: {last_failure}",
                        level="warning",
                    )
                return {
                    "status": "failed",
                    "reason": last_failure or "first run failed",
                    "repairs": repairs,
                }

            # Bounded repair pass.
            current_code = ""
            try:
                current_code = run_py_path.read_text(encoding="utf-8")
            except OSError:
                pass
            if not current_code:
                return {
                    "status": "failed",
                    "reason": last_failure or "first run failed",
                    "repairs": repairs,
                }

            repair_started_at = time.perf_counter()
            fixed = _repair_run_py(
                run_code=current_code,
                failure=last_failure,
                secrets=secrets,
                log_fn=log_fn,
                intent=(getattr(config, "description", None) or "").strip(),
            )
            log_fn(
                f"Smoke repair model step took {time.perf_counter() - repair_started_at:.2f}s",
                level="info",
            )
            if not fixed:
                return {
                    "status": "failed",
                    "reason": last_failure or "first run failed",
                    "repairs": repairs,
                }

            # Persist the repaired run.py through the SAME canonical path the
            # editor uses (write disk + invalidate cache + re-discover + persist
            # recipe). The executor reads run.py from disk on every run, so this
            # write is what the next REAL run executes. If persistence FAILS we
            # must NOT keep going: a worker repaired-but-not-persisted is the
            # silently-ships-stale class. Treat it as a smoke failure so the
            # gate disables it instead of presenting unverified disk state.
            try:
                import main as _main

                _main.persist_worker_run_py(worker_id, fixed, user_id=user_id)
            except Exception as persist_exc:
                logger.exception(
                    "Failed to persist smoke repair for worker %s", worker_id
                )
                log_fn(
                    "Smoke failed — could not persist the repaired code: "
                    f"{persist_exc}",
                    level="warning",
                )
                return {
                    "status": "failed",
                    "reason": f"could not persist repaired code: {persist_exc}",
                    "repairs": repairs,
                }
            # Re-load the recipe so the re-smoke runs against the refreshed
            # manifest/config (run.py itself is re-read from disk by the driver).
            loaded = _load_worker_recipe(worker_id, repos_obj) or loaded
            config = loaded[1]
            repairs += 1
            log_fn(f"Smoke repair {repairs}/{_MAX_SMOKE_REPAIRS} applied; re-running", level="info")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _mark_worker_paused_on_disk(worker_id: str, *, paused: bool = True) -> None:
    """Write ``paused: <bool>`` into the worker's manifest (worker.yml) on disk.

    The runtime smoke-disable sets ``workers.enabled = 0`` in the DB, but
    ``_persist_discovered_workers`` recomputes ``enabled`` from the MANIFEST on
    every re-discover (cache invalidation, file save, repair persist) and would
    clobber a DB-only disable back to enabled=1, because the generated manifest
    carries no paused/enabled flag. Persisting ``paused`` into the manifest makes
    the disable durable (`manifest.get("paused") is True` -> enabled_value = 0).
    Best-effort; never raises (the DB enabled=0 stays the primary gate)."""
    import yaml as _pyyaml

    worker_dir = (WORKERS_DIR / worker_id).resolve()
    yml_path = (worker_dir / "worker.yml").resolve()
    try:
        yml_path.relative_to(worker_dir)
    except ValueError:
        return
    try:
        raw = _pyyaml.safe_load(yml_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            return
        if paused:
            raw["paused"] = True
        else:
            raw.pop("paused", None)
        yml_path.write_text(
            _pyyaml.safe_dump(raw, sort_keys=False, default_flow_style=False, encoding='utf-8'),
            encoding="utf-8",
        )
    except Exception:
        logger.warning("Could not write paused flag to manifest for %s", worker_id, exc_info=True)


def smoke_and_gate_generated_worker(
    worker_id: str,
    bundle: Dict[str, Any],
    *,
    user_id: str | None,
    repos: Repositories | None,
    log_fn: Callable[..., None],
    allow_code_repair: bool = True,
) -> Dict[str, Any]:
    """Run the smoke+repair safety net AND gate the worker on its result.

    The single safety net for BOTH creation paths (the UI worker-author run and
    the raw /workers/draft-and-create endpoint). After the bounded smoke+repair:

      - smoke ``passed`` / ``skipped``  -> leave the worker enabled (as today).
      - smoke ``failed`` (repairs exhausted) -> DISABLE the worker so the
        dashboard does not count it as healthy and a run on it is gated
        (``worker_disabled``). The worker STAYS editable — never deleted — so
        the operator can review/fix it. The create flow surfaces the smoke
        verdict from the returned dict.

    Returns the same dict ``_smoke_and_repair_generated_worker`` produces
    (``{"status","reason","repairs"}``). Never raises.
    """
    repos_obj = _repos(repos)
    smoke = _smoke_and_repair_generated_worker(
        worker_id,
        bundle,
        user_id=user_id,
        repos=repos_obj,
        log_fn=log_fn,
        allow_code_repair=allow_code_repair,
    )
    if smoke.get("status") == "failed":
        try:
            # Persist the disable into the MANIFEST first so it survives any
            # re-discover (`_persist_discovered_workers` recomputes enabled from
            # the manifest and would otherwise clobber a DB-only disable back to
            # enabled=1, because the generated manifest carries no enabled flag).
            # Then set the DB flag. Both together make the gate durable — the
            # worker stays disabled until the operator edits/re-enables it.
            # Done inline (not via main.*) so it cannot fail on a cross-module
            # import inside the async to_thread create path.
            _mark_worker_paused_on_disk(worker_id, paused=True)
            repos_obj.workers.update(
                user_id=user_id,
                worker_id=worker_id,
                enabled=False,
            )
            try:
                from worker_registry import invalidate_worker_cache as _invalidate

                _invalidate()
            except Exception:
                pass
            log_fn(
                "Generated worker disabled — its first test run failed: "
                f"{smoke.get('reason') or 'unknown'}. Review and edit it before turning it on.",
                level="warning",
            )
        except Exception:
            logger.exception("Failed to disable smoke-failed worker %s", worker_id)
    return smoke


# ---------------------------------------------------------------------------
# SSE event publisher hook
# ---------------------------------------------------------------------------
# Populated by main.py at startup to avoid circular imports.
# Signature: (run_id: str, event: dict) -> None
_sse_publish_fn: Optional[Callable[[str, dict], None]] = None
_part_publish_fn: Optional[Callable[[str, dict], None]] = None


def register_sse_publisher(fn: Callable[[str, dict], None]) -> None:
    """Called from main.py to wire up the SSE event publisher."""
    global _sse_publish_fn
    _sse_publish_fn = fn


def register_part_publisher(fn: Callable[[str, dict], None]) -> None:
    """Called from main.py to wire up the AI SDK part publisher."""
    global _part_publish_fn
    _part_publish_fn = fn


def _publish_sse(run_id: str, event: dict) -> None:
    if _sse_publish_fn is not None:
        try:
            _sse_publish_fn(run_id, event)
        except Exception as exc:
            logger.warning("SSE publish failed for run %s: %s", run_id, exc)


def publish_run_part(run_id: str, part: dict) -> None:
    if _part_publish_fn is not None:
        try:
            _part_publish_fn(run_id, part)
        except Exception as exc:
            logger.warning("Part publish failed for run %s: %s", run_id, exc)


# ---------------------------------------------------------------------------
# Secret scrubbing
# ---------------------------------------------------------------------------

SECRET_PATTERNS = [
    re.compile(r"(?i)(api[_-]?key|secret|token|password)\s*[=:]\s*[^\s'\"]+"),
    re.compile(r"\b(?:sk|pk)_(?:live|test|proj|sec)_[a-zA-Z0-9_-]+\b"),
]


def scrub_secrets(text: str, secrets: Dict[str, str]) -> str:
    """Replace secret values with redacted markers in log messages."""
    if not text:
        return text
    for name, value in secrets.items():
        if value and len(value) > 3:
            text = text.replace(value, f"<REDACTED:{name}>")
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("<REDACTED>", text)
    return text


# ---------------------------------------------------------------------------
# Run lifecycle
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _configured_db_path() -> Path:
    configured = os.environ.get("WORKEROS_DB") or os.environ.get("FLOOM_DB")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / "data" / "floom.db"


def _existing_disk_usage_path(path: Path) -> Path:
    candidate = path if path.suffix == "" else path.parent
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


def _ensure_prerun_disk_space() -> None:
    minimum = _minimum_free_disk_bytes()
    if minimum <= 0:
        return
    checks = {
        "database": _existing_disk_usage_path(_configured_db_path()),
        "artifacts": _existing_disk_usage_path(ARTIFACTS_DIR),
    }
    failures: list[str] = []
    for label, path in checks.items():
        free = shutil.disk_usage(path).free
        if free < minimum:
            failures.append(f"{label} path {path} has {free} bytes free, minimum {minimum}")
    if failures:
        raise InsufficientDiskSpaceError("; ".join(failures))


def _repos(repos: Repositories | None = None) -> Repositories:
    return repos or get_repositories()


def _worker_owner_id(worker_id: str, repos: Repositories | None = None) -> str | None:
    return _repos(repos).workers.get_owner(worker_id=worker_id)


def _run_scope(run_id: str, repos: Repositories | None = None) -> tuple[str, str] | None:
    repos_obj = _repos(repos)
    run_row = repos_obj.runs.get_any(run_id=run_id)
    if run_row is None:
        return None
    owner_id = repos_obj.workers.get_owner(worker_id=run_row["worker_id"])
    if not owner_id:
        return None
    return owner_id, run_row["worker_id"]


def _load_worker_recipe(
    worker_id: str,
    repos: Repositories | None = None,
) -> Optional[tuple[str | None, WorkerConfig, Optional[Dict[str, Any]]]]:
    """Load the executable recipe from the repository layer plus instance row."""
    repos_obj = _repos(repos)
    try:
        recipe = repos_obj.workers.get_recipe(worker_id=worker_id)
        if recipe:
            config = recipe.get("config")
            if isinstance(config, WorkerConfig):
                # WorkerContract (schema 0.3) has no `calls` field, so the manifest
                # round-trip through DB drops it. Re-hydrate from the filesystem
                # registry when the DB config has an empty calls list so that
                # worker-to-worker call capability survives DB persistence.
                if not config.calls:
                    fs_config = get_worker_config(worker_id)
                    if fs_config and fs_config.calls:
                        config = config.model_copy(update={"calls": fs_config.calls})
                return (
                    recipe.get("owner_id"),
                    config,
                    {
                        "grants": recipe.get("grants") or {},
                        "input_values": recipe.get("input_values") or {},
                        "enabled": bool(recipe.get("enabled", True)),
                    },
                )
    except Exception:
        logger.exception("Failed to load worker recipe from database for %s", worker_id)

    config = get_worker_config(worker_id)
    if not config:
        return None
    return (_worker_owner_id(worker_id, repos_obj), config, None)


def _get_worker_config_for_run(
    worker_id: str,
    repos: Repositories | None = None,
) -> Optional[WorkerConfig]:
    loaded = _load_worker_recipe(worker_id, repos=repos)
    return loaded[1] if loaded else None


def get_worker_config_for_run(worker_id: str) -> Optional[WorkerConfig]:
    """Return the DB-resolved worker recipe used for run execution."""
    return _get_worker_config_for_run(worker_id)


def _merge_instance_inputs(instance: Optional[Dict[str, Any]], inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Apply saved instance input defaults, with per-run inputs taking precedence."""
    if not instance:
        return dict(inputs)
    defaults = instance.get("input_values") or {}
    if not isinstance(defaults, dict):
        return dict(inputs)
    return {**defaults, **inputs}


def _apply_config_input_defaults(
    config: Optional[WorkerConfig],
    inputs: Dict[str, Any],
) -> Dict[str, Any]:
    """Apply worker.yml input defaults after instance defaults and run inputs."""
    if not config:
        return dict(inputs)
    effective = dict(inputs)
    for inp in config.inputs:
        if inp.default is None:
            continue
        if inp.name not in effective:
            effective[inp.name] = inp.default
    return effective


def _runner_key(config: Optional[WorkerConfig]) -> str:
    if config and config.runtime:
        return config.runtime.runner or "e2b"
    return "e2b"


def _worker_dir_for_run(worker_id: str, config: Optional[WorkerConfig]) -> Path:
    bundle_path = config.runtime.bundle_path if config and config.runtime else None
    if bundle_path:
        raw_path = Path(bundle_path)
        target = raw_path if raw_path.is_absolute() else WORKERS_DIR.parent.joinpath(raw_path)
    else:
        target = WORKERS_DIR.joinpath(worker_id)
    resolved = target.resolve()
    allowed_root = WORKERS_DIR.parent.resolve()
    try:
        resolved.relative_to(allowed_root)
    except ValueError as exc:
        raise ValueError(f"Path traversal attempt: {resolved}") from exc
    return resolved


def _snapshot_worker_bundle(run_id: str, worker_id: str, config: Optional[WorkerConfig]) -> Optional[str]:
    """Best-effort copy of the worker bundle for run reproducibility."""
    data_dir = _configured_db_path().resolve().parent
    snapshot_dir = data_dir / "run-bundles" / run_id
    try:
        worker_dir = _worker_dir_for_run(worker_id, config)
        if not worker_dir.is_dir():
            raise FileNotFoundError(f"worker directory not found: {worker_dir}")
        snapshot_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            worker_dir,
            snapshot_dir,
            ignore=shutil.ignore_patterns("__pycache__", ".git", "node_modules"),
        )
        return snapshot_dir.relative_to(data_dir).as_posix()
    except Exception as exc:
        logger.warning("Run %s bundle snapshot failed for worker %s: %s", run_id, worker_id, exc)
        return None

def create_run(
    worker_id: str,
    inputs: Dict[str, Any],
    trigger_source: str = "manual",
    *,
    status: str | None = None,
    user_id: str | None = None,
    trigger_ref: str | None = None,
    repos: Repositories | None = None,
) -> str:
    repos_obj = _repos(repos)
    _ensure_prerun_disk_space()
    run_id = f"run_{uuid.uuid4().hex[:12]}"
    loaded = _load_worker_recipe(worker_id, repos=repos_obj)
    owner_id = user_id or (loaded[0] if loaded else None) or _worker_owner_id(worker_id, repos_obj)
    if not owner_id:
        raise ValueError(f"Worker {worker_id} owner not found")
    config = loaded[1] if loaded else None
    instance = loaded[2] if loaded else None
    if instance and not instance.get("enabled", True):
        raise ValueError(f"Worker {worker_id} is disabled")
    effective_inputs = _apply_config_input_defaults(
        config,
        _merge_instance_inputs(instance, inputs),
    )
    # Determine runner from config; script workers default to E2B.
    runner = _runner_key(config)
    last_exc: Exception | None = None
    for attempt in range(6):
        try:
            repos_obj.runs.create(
                user_id=owner_id,
                run_id=run_id,
                worker_id=worker_id,
                status=status or RunStatus.QUEUED.value,
                trigger_source=trigger_source,
                runner=runner,
                input_json=effective_inputs,
                created_at=_now_iso(),
                trigger_ref=trigger_ref,
            )
            last_exc = None
            break
        except sqlite3.OperationalError as exc:
            if "database is locked" not in str(exc).lower() or attempt == 5:
                raise
            last_exc = exc
            time.sleep(0.05 * (attempt + 1))
    if last_exc is not None:
        raise last_exc
    logger.info("Created run %s for worker %s (runner=%s)", run_id, worker_id, runner)
    return run_id


def add_log(
    run_id: str,
    message: str,
    level: str = "info",
    trace_id: Optional[str] = None,
    attributes: Optional[Dict[str, Any]] = None,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id
    if owner_id is None:
        scope = _run_scope(run_id, repos_obj)
        if scope is None:
            return
        owner_id, _worker_id = scope
    ts = _now_iso()
    repos_obj.runs.add_log(
        user_id=owner_id,
        run_id=run_id,
        level=level,
        message=message,
        timestamp=ts,
        trace_id=trace_id,
    )
    _publish_sse(run_id, {
        "type": "log",
        "run_id": run_id,
        "level": level,
        "message": message,
        "timestamp": ts,
        "trace_id": trace_id,
    })


def update_run_status(
    run_id: str,
    status: str,
    output: Optional[Dict[str, Any]] = None,
    error: Optional[str] = None,
    error_code: Optional[str] = None,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id
    if owner_id is None:
        scope = _run_scope(run_id, repos_obj)
        if scope is None:
            return
        owner_id, _worker_id = scope
    run_row = repos_obj.runs.get(user_id=owner_id, run_id=run_id)
    worker_id = str((run_row or {}).get("worker_id") or "")
    previous_error = (run_row or {}).get("error")
    repos_obj.runs.update_status(
        user_id=owner_id,
        run_id=run_id,
        status=status,
        output_json=output,
        error=error,
        error_code=error_code,
    )

    if worker_id and status in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
        _dispatch_terminal_run_alerts(
            run_id=run_id,
            worker_id=worker_id,
            status=status,
            error=error if error is not None else previous_error,
            user_id=owner_id,
            repos=repos_obj,
        )

    # Publish SSE event for the status change
    _publish_sse(run_id, {
        "type": "status",
        "run_id": run_id,
        "status": status,
        "error": error,
        "error_code": error_code,
    })


def _store_run_artifacts(
    run_id: str,
    artifacts: list[Dict[str, Any]],
    log_fn: Callable[[str, str], None],
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id
    if owner_id is None:
        scope = _run_scope(run_id, repos_obj)
        if scope is None:
            return
        owner_id, _worker_id = scope
    for art in artifacts:
        try:
            art_id = f"art_{uuid.uuid4().hex[:12]}"
            art_name = art.get("name", "artifact")
            art_type = art.get("type", "file")
            art_path = art.get("path", "")
            art_size = art.get("size_bytes", 0)
            art_created = _now_iso()
            repos_obj.runs.add_artifact(
                user_id=owner_id,
                run_id=run_id,
                artifact_id=art_id,
                name=art_name,
                artifact_type=art_type,
                path=art_path,
                size_bytes=art_size,
                created_at=art_created,
            )
            _publish_sse(run_id, {
                "type": "artifact",
                "run_id": run_id,
                "artifact": {
                    "id": art_id,
                    "name": art_name,
                    "artifact_type": art_type,
                    "size_bytes": art_size,
                    "created_at": art_created,
                },
            })
        except Exception as exc:
            logger.exception("Failed to store artifact")
            log_fn(f"Failed to store artifact: {exc}", level="warning")


def _looks_like_relative_path(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text or "\n" in text or "://" in text or text.startswith("/"):
        return False
    if _PATH_VALUE_RE.fullmatch(text):
        return True
    suffixes = (".md", ".txt", ".json", ".csv", ".html", ".pdf", ".docx")
    return "/" in text and text.lower().endswith(suffixes)


def _placeholder_warning(value: Any, output_name: str) -> str | None:
    if not isinstance(value, str):
        return None
    first = value.strip().lower()[:200]
    if not first:
        return None
    if any(marker in first for marker in _PLACEHOLDER_MARKERS):
        return f"{output_name}: output looks like placeholder/apology content"
    if first.startswith("note:"):
        return f"{output_name}: output starts with Note:"
    return None


def _output_artifact(output: Any, artifacts: list[Dict[str, Any]]) -> Dict[str, Any] | None:
    expected = (getattr(output, "path", None) or "").strip()
    output_name = getattr(output, "name", "")
    for artifact in artifacts:
        names = {
            str(artifact.get("relative_path") or ""),
            str(artifact.get("name") or ""),
        }
        if expected and expected in names:
            return artifact
        if output_name and output_name in names:
            return artifact
        if expected and any(name.endswith(f"/{expected}") for name in names):
            return artifact
    return None


def _candidate_output_path(run_id: str, output: Any, outputs: Dict[str, Any], artifacts: list[Dict[str, Any]]) -> Path | None:
    artifact = _output_artifact(output, artifacts)
    if artifact and artifact.get("path"):
        return Path(str(artifact["path"]))
    root = ARTIFACTS_DIR / run_id
    declared_path = getattr(output, "path", None)
    if declared_path:
        return (root / declared_path).resolve()
    value = outputs.get(getattr(output, "name", ""))
    if isinstance(value, str) and _looks_like_relative_path(value):
        return (root / value.strip()).resolve()
    return None


def _safe_artifact_path(run_id: str, relative_path: str) -> Path:
    root = (ARTIFACTS_DIR / run_id).resolve()
    target = (root / relative_path).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError(f"output path escapes artifact directory: {relative_path}")
    return target


def _materialize_declared_file_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> None:
    for output in config.outputs:
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        if kind != "file" or output.name not in outputs or _output_artifact(output, artifacts):
            continue
        relative_path = output.path or f"outputs/{output.name}.txt"
        path = _safe_artifact_path(run_id, relative_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        value = outputs[output.name]
        content = value if isinstance(value, str) else json.dumps(value, indent=2)
        path.write_text(content, encoding="utf-8")
        artifacts.append(
            {
                "name": relative_path,
                "relative_path": relative_path,
                "type": output.media_type or "text/plain",
                "path": str(path),
                "size_bytes": path.stat().st_size,
            }
        )


def _validate_run_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> tuple[str | None, list[str]]:
    warnings: list[str] = []
    for output in config.outputs:
        name = output.name
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        value = outputs.get(name)

        if output.required and name not in outputs:
            return f"output_validation_failed: {name} missing required output", warnings

        if kind == "file":
            if not output.required and name not in outputs and not _output_artifact(output, artifacts):
                continue
            path = _candidate_output_path(run_id, output, outputs, artifacts)
            if path is None:
                return f"output_validation_failed: {name} missing output file", warnings
            if not path.is_file():
                return f"output_validation_failed: {name} file not found at {path.name}", warnings
            size = path.stat().st_size
            if size == 0:
                return f"output_validation_failed: {name} file is empty", warnings
            media_type = (output.media_type or "").lower()
            if media_type == "application/json":
                # A valid, parseable JSON document is a legitimate result at any
                # non-zero size — gate on parseability, never the byte floor.
                try:
                    json.loads(path.read_text(encoding='utf-8'))
                except Exception as exc:
                    return f"output_validation_failed: {name} JSON file is invalid: {exc}", warnings
                continue
            if not media_type:
                # Unknown type: if it parses as JSON, accept as structured data.
                try:
                    json.loads(path.read_text(encoding='utf-8'))
                    continue
                except Exception:
                    pass
            # Non-JSON file (text/csv/etc): a valid, non-empty result of ANY size
            # is legitimate. There is no byte floor — a 36-byte sorted CSV or a
            # short uppercased name list is a correct output. Only truly empty /
            # whitespace-only content fails; near-empty apology/placeholder prose
            # is surfaced as a WARNING, never a hard failure.
            text = path.read_text(errors="ignore")
            if not text.strip():
                return f"output_validation_failed: {name} file is empty", warnings
            warning = _placeholder_warning(text[:1000], name)
            if warning:
                warnings.append(warning)
            continue

        if output.required and (value is None or value == ""):
            return f"output_validation_failed: {name} scalar output is empty", warnings
        if _looks_like_relative_path(value):
            return f"output_validation_failed: {name} scalar output leaked a path string", warnings
        warning = _placeholder_warning(value, name)
        if warning:
            warnings.append(warning)

    return None, warnings


def _smoke_empty_output_error(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> str | None:
    """Smoke-only: a REQUIRED output that parses as an empty JSON container
    (``[]`` / ``{}`` / ``""`` / null) is a green-but-empty no-op at smoke time.

    Returns an error string for the FIRST such output, else None. Only required
    file/scalar outputs are checked; the normal run validator stays unchanged.
    """
    for output in config.outputs:
        if not output.required:
            continue
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        parsed: Any = None
        if kind == "file":
            path = _candidate_output_path(run_id, output, outputs, artifacts)
            if path is None or not path.is_file():
                continue
            text = path.read_text(errors="ignore")
            try:
                parsed = json.loads(text)
            except Exception:
                # Non-JSON text already passed the non-empty check upstream.
                continue
        else:
            parsed = outputs.get(output.name)
        if parsed is None or parsed == [] or parsed == {} or parsed == "":
            return (
                f"output_validation_failed: {output.name} produced an empty result "
                "(the worker ran but did nothing)"
            )
    return None


def _parse_expected_example_output(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list, int, float, bool)):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    for parser in (json.loads,):
        try:
            return parser(text)
        except Exception:
            pass
    try:
        import yaml as pyyaml

        parsed = pyyaml.safe_load(text)
        if parsed is not None:
            return parsed
    except Exception:
        pass
    return text


def _expected_example_output_from_bundle(bundle: Dict[str, Any]) -> Any:
    if "example_output" in bundle:
        return _parse_expected_example_output(bundle.get("example_output"))
    worker_yml = bundle.get("worker_yml")
    if isinstance(worker_yml, str) and worker_yml.strip():
        try:
            import yaml as pyyaml

            raw = pyyaml.safe_load(worker_yml) or {}
            if isinstance(raw, dict):
                return _parse_expected_example_output(raw.get("example_output"))
        except Exception:
            return None
    return None


def _normalize_example_value(value: Any) -> Any:
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return ""
        try:
            return json.loads(text)
        except Exception:
            return text
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _example_values_equal(actual: Any, expected: Any) -> bool:
    actual_norm = _normalize_example_value(actual)
    expected_norm = _normalize_example_value(expected)
    if actual_norm == expected_norm:
        return True
    try:
        return float(actual_norm) == float(expected_norm)
    except (TypeError, ValueError):
        return False


def _actual_example_outputs(
    run_id: str,
    config: WorkerConfig,
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> Dict[str, Any]:
    actual = dict(outputs or {})
    for output in config.outputs:
        kind = output.kind or ("file" if output.type == "file" else "scalar")
        if kind != "file":
            continue
        path = _candidate_output_path(run_id, output, outputs, artifacts)
        if path is not None and path.is_file():
            actual[output.name] = path.read_text(errors="replace").strip()
    return actual


def _validate_example_output(
    run_id: str,
    config: WorkerConfig,
    bundle: Dict[str, Any],
    outputs: Dict[str, Any],
    artifacts: list[Dict[str, Any]],
) -> str | None:
    expected = _expected_example_output_from_bundle(bundle)
    if expected is None:
        return None
    actual = _actual_example_outputs(run_id, config, outputs, artifacts)
    if isinstance(expected, dict):
        for name, expected_value in expected.items():
            if name not in actual:
                return f"output_validation_failed: example_output mismatch for {name}: missing actual output"
            if not _example_values_equal(actual.get(name), expected_value):
                return (
                    f"output_validation_failed: example_output mismatch for {name}: "
                    f"expected {expected_value!r}, got {actual.get(name)!r}"
                )
        return None
    if len(config.outputs) == 1:
        name = config.outputs[0].name
        if not _example_values_equal(actual.get(name), expected):
            return (
                f"output_validation_failed: example_output mismatch for {name}: "
                f"expected {expected!r}, got {actual.get(name)!r}"
            )
    return None


def _load_runtime_env_files() -> None:
    # Load the SAME secret-store files the write path (`SqliteSecretRepository
    # .set`) persists values into, so run-time secret resolution is consistent
    # across ALL run paths (manual, scheduled, webhook, composio): a secret set
    # under the worker's owner is found at run time regardless of how the run
    # was triggered.
    #
    # N4-1 root cause: the secret-store path was source-tree-relative
    # (`apps/api/.env` next to the db source file). Two processes serving the
    # same shared DB but running from different deploy directories
    # (/root/workeros vs /opt/workeros-live vs a /tmp worktree) resolved it to
    # DIFFERENT files. The DB row (absolute WORKEROS_DB path) is shared, so a
    # secret read back as "set" while its value was orphaned in another tree's
    # .env — every scheduled run failed "missing_secret". The store path is now
    # DB-anchored (stable across deploys) and we read across legacy locations
    # so pre-fix values still resolve.
    from db import secret_store_read_paths

    for secret_store in secret_store_read_paths():
        if secret_store.is_file():
            load_dotenv(secret_store, override=False)
    try:
        if API_ENV_PATH.is_file():
            load_dotenv(API_ENV_PATH, override=False)
    except (PermissionError, OSError):
        pass


def _env_keys_from_file(path: Path) -> set[str]:
    keys: set[str] = set()
    if not path.is_file():
        return keys
    for line in path.read_text(encoding='utf-8').splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key = stripped.split("=", 1)[0].strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            keys.add(key)
    return keys


def _secret_names_from_db(
    user_id: str,
    repos: Repositories | None = None,
) -> set[str]:
    try:
        return _repos(repos).secrets.list_names(user_id=user_id)
    except Exception:
        return set()


_PLATFORM_SECRET_NAMES: frozenset[str] = frozenset({
    # Platform infrastructure credentials — never legitimate worker inputs.
    "FLOOM_SECRET",
    "COMPOSIO_API_KEY",
    "COMPOSIO_WEBHOOK_SIGNING_KEY",
    "E2B_API_KEY",
    "FLOOM_DEPLOY_SECRET",
    # Platform infra paths / tuning vars — same.
    "WORKERS_FRONTEND_URL",
    "FLOOM_DB",
    "FLOOM_WORKERS_DIR",
    "FLOOM_ARTIFACTS_DIR",
    "FLOOM_CONTEXTS_DIR",
    "FLOOM_RUN_TIMEOUT",
    # NOTE: OPENAI_API_KEY is INTENTIONALLY NOT in this list. Workers
    # legitimately need it to call OpenAI from inside the sandbox (research_brief,
    # csv_enricher, cv_writeup etc. all declare secrets: [OPENAI_API_KEY]).
    # Workeros v0 is single-user, so the platform owner == the worker author,
    # and sharing the OpenAI key is acceptable. When the platform goes
    # multi-tenant (skills-neo v0.y), this needs to change: each tenant must
    # bring their own OPENAI_API_KEY via the secrets DB, and the platform's
    # own key must move to a separate name like PLATFORM_OPENAI_API_KEY.
    # See ARCHITECTURE.md.
})


def get_secrets_for_worker(
    worker_id: str,
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> Dict[str, str]:
    """Resolve the secrets dict that ships to the worker sandbox.

    SECURITY: The sandbox secrets.json must contain ONLY:
      (a) secrets declared in the worker's worker.yml `exec.secrets` field
      (b) user-managed secrets stored in the platform's `secrets` DB table
    It must NEVER contain platform infrastructure credentials (FLOOM_SECRET,
    E2B_API_KEY, COMPOSIO_API_KEY, COMPOSIO_WEBHOOK_SIGNING_KEY, OPENAI_API_KEY,
    etc.) because the sandbox runs untrusted worker code and any leak there
    is equivalent to publishing the secret.

    Pre-fix this function unioned every key in `/root/.config/workeros/api.env`
    into the result, including all platform secrets above. Audit 2026-05-26
    flagged it as P0. The `_PLATFORM_SECRET_NAMES` denylist now blocks them
    regardless of whether they appear in the worker manifest or the DB.

    SECRET-SCOPING GUARD (Members STEP 1, Codex top risk): secrets ALWAYS resolve
    to the WORKER'S OWNER, never to whoever happens to be running it. When a member
    runs a ``workspace``-visibility worker shared by another owner, the caller
    passes the RUNNER's id as ``user_id``; using that to resolve secrets would (a)
    leak the runner's OWN private secrets into someone else's worker, and (b) fail
    the run because the owner's declared secrets live under the owner's id, not the
    runner's. So we resolve the owner from the worker row and ignore a passed
    ``user_id`` that does NOT match it. The passed ``user_id`` is only used as a
    fallback when the worker has no DB owner (filesystem-only stock workers, where
    owner == caller by construction). On the OSS single-owner engine owner == the
    local user, so behaviour is unchanged.
    """
    repos_obj = _repos(repos)
    true_owner_id = _worker_owner_id(worker_id, repos_obj)
    # Resolve strictly against the worker's real owner. Only fall back to the
    # passed user_id when the worker has no owner row at all (stock/FS workers).
    owner_id = true_owner_id or user_id
    if not owner_id:
        return {}
    if true_owner_id and user_id and user_id != true_owner_id:
        logger.info(
            "Secret scoping: worker %s run by %s resolves secrets to owner %s "
            "(runner's own secrets are NOT used).",
            worker_id,
            user_id,
            true_owner_id,
        )
    _load_runtime_env_files()
    config = _get_worker_config_for_run(worker_id, repos_obj)
    names = set(config.secrets if config else [])
    names.update(_secret_names_from_db(owner_id, repos_obj))
    # DO NOT union env-file keys here. They include platform infra secrets.
    allowed_names = [name for name in names if name not in _PLATFORM_SECRET_NAMES]
    return repos_obj.secrets.resolve(user_id=owner_id, names=allowed_names)


# ---------------------------------------------------------------------------
# Execution orchestration
# ---------------------------------------------------------------------------

INTERRUPTED_RUN_ERROR = "Run was interrupted by an API restart before completion."
INTERRUPTED_RUN_ERROR_CODE = "interrupted_by_restart"
ABANDONED_RUN_ERROR = "run abandoned (server restarted): no active executor after timeout window"
ABANDONED_RUN_ERROR_CODE = "run_abandoned_server_restart"
WORKER_DELETED_RUN_ERROR = "Worker deleted before run completed."
_SCHEDULE_MISSING_SECRET_PAUSE_AFTER = 3
_RUN_REAPER_DEFAULT_GRACE_SECONDS = 60
_RUN_REAPER_DEFAULT_INTERVAL_SECONDS = 180


@dataclass
class _ActiveRun:
    run_id: str
    worker_id: str
    user_id: str | None
    thread: threading.Thread


_active_runs: dict[str, _ActiveRun] = {}
_active_runs_lock = threading.Lock()
_shutdown_cancelled_runs: set[str] = set()


def _register_active_run(active_run: _ActiveRun) -> None:
    with _active_runs_lock:
        _active_runs[active_run.run_id] = active_run


def _unregister_active_run(run_id: str) -> None:
    with _active_runs_lock:
        _active_runs.pop(run_id, None)
        _shutdown_cancelled_runs.discard(run_id)


def _schedule_missing_secret_pause_threshold() -> int:
    raw = os.environ.get("WORKEROS_SCHEDULE_MISSING_SECRET_PAUSE_AFTER", "")
    if not raw:
        return _SCHEDULE_MISSING_SECRET_PAUSE_AFTER
    try:
        return max(0, int(raw))
    except ValueError:
        return _SCHEDULE_MISSING_SECRET_PAUSE_AFTER


def _persist_worker_paused_flag(
    worker_id: str,
    *,
    repos: Repositories,
    user_id: str | None,
    archive_reason: str | None = None,
) -> None:
    if not user_id:
        return
    worker = repos.workers.get(user_id=user_id, worker_id=worker_id)
    manifest = dict((worker or {}).get("manifest") or {})
    if manifest:
        manifest["paused"] = True
        manifest["enabled"] = False
        manifest["archive_reason"] = (
            manifest.get("archive_reason")
            or archive_reason
            or "Paused automatically after repeated scheduled setup failures."
        )
        repos.workers.update(
            user_id=user_id,
            worker_id=worker_id,
            enabled=False,
            manifest_json=manifest,
        )
    else:
        repos.workers.update(user_id=user_id, worker_id=worker_id, enabled=False)

    worker_yml = WORKERS_DIR / worker_id / "worker.yml"
    if not worker_yml.exists():
        return
    try:
        raw = worker_yml.read_text(encoding="utf-8")
        updated = raw
        if re.search(r"(?m)^paused:\s*(true|false)\s*$", updated):
            updated = re.sub(r"(?m)^(paused:\s*)(true|false)\s*$", r"\1true", updated)
        else:
            if not updated.endswith("\n"):
                updated += "\n"
            updated += "paused: true\n"
        if re.search(r"(?m)^enabled:\s*(true|false)\s*$", updated):
            updated = re.sub(r"(?m)^(enabled:\s*)(true|false)\s*$", r"\1false", updated)
        if updated != raw:
            worker_yml.write_text(updated, encoding="utf-8")
    except Exception as exc:
        logger.warning("Failed to persist auto-pause flag for %s: %s", worker_id, exc)


def _maybe_pause_scheduled_worker_after_setup_failure(
    *,
    worker_id: str,
    run_id: str,
    user_id: str | None,
    error_code: str,
    repos: Repositories,
) -> bool:
    """Pause a scheduled worker after repeated deterministic setup failures."""
    if error_code != "missing_secret" or not user_id:
        return False

    threshold = _schedule_missing_secret_pause_threshold()
    if threshold <= 0:
        return False

    current = repos.runs.get(user_id=user_id, run_id=run_id)
    if not current or current.get("trigger_source") != "schedule":
        return False

    rows, _ = repos.runs.list(user_id=user_id, worker_id=worker_id, limit=threshold, offset=0)
    if len(rows) < threshold:
        return False
    for row in rows:
        if row.get("trigger_source") != "schedule":
            return False
        if row.get("status") != RunStatus.FAILED.value:
            return False
        if row.get("error_code") != "missing_secret":
            return False

    _persist_worker_paused_flag(worker_id, repos=repos, user_id=user_id)
    logger.warning(
        "Auto-paused scheduled worker %s after %d consecutive missing-secret failures",
        worker_id,
        threshold,
    )
    return True


def _auto_pause_on_consecutive_failures_enabled() -> bool:
    # Default ON (opt-out). Broken scheduled workers inflated failure rate to
    # 1,683/1,866 runs over 7 days (#526). Opt out via
    # WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES=0.
    raw = os.environ.get("WORKEROS_AUTO_PAUSE_ON_CONSECUTIVE_FAILURES", "1")
    return raw.strip().lower() not in {"0", "false", "no", "off"}


def _alert_consecutive_failure_threshold() -> int:
    # Raised from 3 → 5 to avoid pausing workers on transient E2B/network blips.
    raw = os.environ.get("WORKEROS_ALERT_CONSECUTIVE_FAILURES", "5")
    try:
        return max(1, int(raw))
    except ValueError:
        return 5


def _maybe_pause_worker_after_consecutive_failures(
    *,
    worker_id: str,
    user_id: str | None,
    repos: Repositories,
) -> bool:
    """Optionally pause automatic workers that keep failing consecutively."""
    if not user_id or not _auto_pause_on_consecutive_failures_enabled():
        return False
    threshold = _alert_consecutive_failure_threshold()
    try:
        rows, _ = repos.runs.list(user_id=user_id, worker_id=worker_id, limit=threshold, offset=0)
    except sqlite3.OperationalError as exc:
        if "no such table:" in str(exc).lower():
            logger.debug("Skipping auto-pause check for %s: run tables unavailable: %s", worker_id, exc)
            return False
        raise
    if len(rows) < threshold:
        return False
    automatic_sources = {"schedule", "scheduled", "webhook", "composio", "trigger"}
    for row in rows:
        if row.get("status") != RunStatus.FAILED.value:
            return False
        if str(row.get("trigger_source") or "").lower() not in automatic_sources:
            return False

    _persist_worker_paused_flag(
        worker_id,
        repos=repos,
        user_id=user_id,
        archive_reason=(
            f"Paused automatically after {threshold} consecutive automatic run failures."
        ),
    )
    logger.warning(
        "Auto-paused worker %s after %d consecutive automatic failures",
        worker_id,
        threshold,
    )
    return True


def active_run_count() -> int:
    with _active_runs_lock:
        return len(_active_runs)


def _active_run_ids() -> set[str]:
    with _active_runs_lock:
        return set(_active_runs)


def was_shutdown_cancelled(run_id: str) -> bool:
    with _active_runs_lock:
        return run_id in _shutdown_cancelled_runs


def _run_reaper_grace_seconds() -> int:
    raw = os.environ.get("WORKEROS_RUN_REAPER_GRACE_SECONDS", "")
    if not raw:
        return _RUN_REAPER_DEFAULT_GRACE_SECONDS
    try:
        return max(0, int(raw))
    except ValueError:
        return _RUN_REAPER_DEFAULT_GRACE_SECONDS


def _run_reaper_interval_seconds() -> int:
    raw = os.environ.get("WORKEROS_RUN_REAPER_INTERVAL_SECONDS", "")
    if not raw:
        return _RUN_REAPER_DEFAULT_INTERVAL_SECONDS
    try:
        return max(30, int(raw))
    except ValueError:
        return _RUN_REAPER_DEFAULT_INTERVAL_SECONDS


def reap_abandoned_runs(
    *,
    repos: Repositories | None = None,
    now: datetime | None = None,
    timeout_seconds: int | None = None,
    grace_seconds: int | None = None,
) -> int:
    """Fail stale `running` rows that no longer have a live executor.

    This is intentionally conservative: a row must be older than the normal run
    timeout plus a grace margin, and its run id must not be present in the
    current process' active execution registry. The repository update is also
    status-gated, so repeated sweeps are harmless.
    """
    repos_obj = _repos(repos)
    timeout = DEFAULT_TIMEOUT_SECONDS if timeout_seconds is None else max(0, int(timeout_seconds))
    grace = _run_reaper_grace_seconds() if grace_seconds is None else max(0, int(grace_seconds))
    now_dt = now or datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    cutoff_iso = (now_dt - timedelta(seconds=timeout + grace)).isoformat()
    active_ids = _active_run_ids()

    failed = repos_obj.runs.fail_stale_running(
        cutoff_iso=cutoff_iso,
        exclude_run_ids=active_ids,
        error=ABANDONED_RUN_ERROR,
        error_code=ABANDONED_RUN_ERROR_CODE,
    )
    for row in failed:
        run_id = str(row.get("run_id") or row.get("id") or "")
        user_id = row.get("user_id")
        if not run_id or not user_id:
            continue
        try:
            repos_obj.runs.add_log(
                user_id=str(user_id),
                run_id=run_id,
                level="error",
                message=ABANDONED_RUN_ERROR,
                timestamp=datetime.now(timezone.utc).isoformat(),
                trace_id=None,
            )
        except Exception as exc:
            logger.warning("Failed to add abandoned-run log for %s: %s", run_id, exc)
    if failed:
        logger.warning(
            "Reaped %d abandoned running run(s) older than %ss + %ss grace",
            len(failed),
            timeout,
            grace,
        )
    return len(failed)

# ---------------------------------------------------------------------------
# Queue drain loop
# ---------------------------------------------------------------------------
# The drain loop is a background daemon thread that wakes on a threading.Event,
# polls the DB for queued runs (FIFO), and dispatches each one by acquiring the
# execution semaphore.  This means run-create is always instant (returns
# "queued") and the concurrency gate sits at the sandbox spawn boundary.

_drain_event = threading.Event()
_drain_stop = threading.Event()
_drain_thread: Optional[threading.Thread] = None
_drain_lock = threading.Lock()

_DRAIN_POLL_INTERVAL = 0.5  # seconds between polls when runs are queued

_run_reaper_stop = threading.Event()
_run_reaper_thread: Optional[threading.Thread] = None
_run_reaper_lock = threading.Lock()


def _wake_drain() -> None:
    """Signal the drain loop that new queued work may be available."""
    _drain_event.set()


def _drain_loop() -> None:
    """Background thread: drain the queued-runs table as execution slots free up."""
    logger.info("Queue drain loop started (max_concurrent=%d)", _max_concurrent_runs())
    while not _drain_stop.is_set():
        # Wait for a wake signal or the poll interval, then clear the event.
        _drain_event.wait(timeout=_DRAIN_POLL_INTERVAL)
        _drain_event.clear()
        if _drain_stop.is_set():
            break
        _drain_one_batch()


def _drain_one_batch() -> None:
    """Pick up all drainable queued runs (up to semaphore count) and dispatch them."""
    try:
        repos_obj = get_repositories()
        queued = repos_obj.runs.get_queued(limit=50)
    except Exception as exc:
        logger.warning("Queue drain: DB poll failed: %s", exc)
        return

    for row in queued:
        if _drain_stop.is_set():
            break
        run_id = row["run_id"]
        worker_id = row["worker_id"]
        user_id = row["user_id"]
        try:
            input_json = row.get("input_json") or "{}"
            inputs = json.loads(input_json) if isinstance(input_json, str) else input_json
        except Exception:
            inputs = {}

        # Try to grab a slot non-blockingly; if none is free, stop for now.
        # The drain loop will retry on the next wake (semaphore release calls
        # _wake_drain via the run-thread finally block).
        acquired = _get_semaphore().acquire(blocking=False)
        if not acquired:
            # No free slots right now — stop this batch; wake will come when
            # a run completes (_run_thread_entry calls _wake_drain on exit).
            logger.debug("Queue drain: no free execution slots, pausing")
            break

        try:
            # Claim the run before spawning a worker thread so subsequent drain
            # passes cannot dispatch the same queued row twice.
            repos_obj.runs.update(
                user_id=user_id,
                run_id=run_id,
                status=RunStatus.RUNNING.value,
                started_at=_now_iso(),
            )

            # Slot acquired — dispatch the run in a thread.
            # The semaphore is released inside _run_thread_entry_with_semaphore.
            thread = threading.Thread(
                target=_run_thread_entry_with_semaphore,
                args=(run_id, worker_id, inputs, user_id, None),
                daemon=True,
                name=f"workeros-run-{run_id}",
            )
            active_run = _ActiveRun(run_id=run_id, worker_id=worker_id, user_id=user_id, thread=thread)
            _register_active_run(active_run)
            try:
                thread.start()
            except Exception:
                _unregister_active_run(run_id)
                raise
            logger.info("Queue drain: dispatched run %s for worker %s", run_id, worker_id)
        except Exception as exc:
            logger.warning("Queue drain: failed to dispatch run %s: %s", run_id, exc)
            _unregister_active_run(run_id)
            try:
                repos_obj.runs.update(
                    user_id=user_id,
                    run_id=run_id,
                    status=RunStatus.QUEUED.value,
                    started_at=None,
                )
            except Exception as rollback_exc:
                logger.warning(
                    "Queue drain: failed to restore queued status for %s: %s",
                    run_id,
                    rollback_exc,
                )
            _get_semaphore().release()


def start_drain_loop() -> None:
    """Start the background queue drain thread (idempotent)."""
    global _drain_thread
    with _drain_lock:
        if _drain_thread is not None and _drain_thread.is_alive():
            return
        _drain_stop.clear()
        _drain_thread = threading.Thread(
            target=_drain_loop,
            daemon=True,
            name="workeros-queue-drain",
        )
        _drain_thread.start()


def stop_drain_loop(timeout: float = 5.0) -> None:
    """Signal the drain loop to stop and wait for it to exit."""
    global _drain_thread
    _drain_stop.set()
    _wake_drain()
    with _drain_lock:
        t = _drain_thread
    if t is not None:
        t.join(timeout=timeout)


def _run_reaper_loop() -> None:
    """Background thread: periodically reconcile abandoned running rows."""
    interval = _run_reaper_interval_seconds()
    logger.info("Run reaper loop started (interval=%ss)", interval)
    while not _run_reaper_stop.wait(timeout=interval):
        try:
            reap_abandoned_runs()
        except Exception as exc:
            logger.warning("Run reaper sweep failed: %s", exc)


def start_run_reaper_loop() -> None:
    """Start the abandoned-run reaper thread (idempotent)."""
    global _run_reaper_thread
    with _run_reaper_lock:
        if _run_reaper_thread is not None and _run_reaper_thread.is_alive():
            return
        _run_reaper_stop.clear()
        _run_reaper_thread = threading.Thread(
            target=_run_reaper_loop,
            daemon=True,
            name="workeros-run-reaper",
        )
        _run_reaper_thread.start()


def stop_run_reaper_loop(timeout: float = 5.0) -> None:
    """Stop the abandoned-run reaper thread."""
    global _run_reaper_thread
    _run_reaper_stop.set()
    with _run_reaper_lock:
        t = _run_reaper_thread
    if t is not None:
        t.join(timeout=timeout)


def queued_run_position(run_id: str) -> int:
    """Return 1-based queue position of a queued run, or 0 if not found."""
    try:
        repos_obj = get_repositories()
        queued = repos_obj.runs.get_queued(limit=200)
        for i, row in enumerate(queued, start=1):
            if row["run_id"] == run_id:
                return i
    except Exception:
        pass
    return 0

def _cancel_active_runs(
    active: list[_ActiveRun],
    *,
    repos: Repositories,
    timeout_seconds: float,
    reason: str,
    mark_shutdown_cancelled: bool,
) -> list[str]:
    if mark_shutdown_cancelled:
        with _active_runs_lock:
            _shutdown_cancelled_runs.update(run.run_id for run in active)

    try:
        from runner_sandbox.e2b_driver import cancel_sandbox
    except Exception:
        cancel_sandbox = None

    cancelled_at = _now_iso()
    for run in active:
        if run.user_id:
            try:
                repos.runs.cancel(
                    user_id=run.user_id,
                    run_id=run.run_id,
                    cancelled_at=cancelled_at,
                )
                repos.runs.add_log(
                    user_id=run.user_id,
                    run_id=run.run_id,
                    level="error",
                    message=reason,
                    timestamp=cancelled_at,
                    trace_id=None,
                )
            except Exception as exc:
                logger.warning("Failed to mark run %s cancelled: %s", run.run_id, exc)
        if cancel_sandbox is not None:
            try:
                cancel_sandbox(run.run_id, reason=reason)
            except Exception:
                logger.debug("E2B cancel failed for run %s", run.run_id, exc_info=True)

    deadline = time.monotonic() + max(0.0, timeout_seconds)
    for run in active:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        run.thread.join(timeout=remaining)

    with _active_runs_lock:
        active_ids = {run.run_id for run in active}
        return [run_id for run_id in _active_runs if run_id in active_ids]


def request_active_run_shutdown(
    *,
    repos: Repositories | None = None,
    timeout_seconds: float = 30.0,
) -> int:
    """Ask active worker threads to stop before the API process exits."""
    repos_obj = _repos(repos)
    with _active_runs_lock:
        active = list(_active_runs.values())
    if not active:
        return 0

    logger.warning("Shutdown requested; cancelling %d active run(s)", len(active))
    remaining_ids = _cancel_active_runs(
        active,
        repos=repos_obj,
        timeout_seconds=timeout_seconds,
        reason=INTERRUPTED_RUN_ERROR,
        mark_shutdown_cancelled=True,
    )
    if remaining_ids:
        logger.warning("Shutdown timed out waiting for active runs: %s", ", ".join(sorted(remaining_ids)))
    return len(active)


def request_worker_run_shutdown(
    *,
    worker_id: str,
    user_id: str,
    repos: Repositories | None = None,
    timeout_seconds: float = 30.0,
) -> list[str]:
    repos_obj = _repos(repos)
    with _active_runs_lock:
        active = [
            run for run in _active_runs.values()
            if run.worker_id == worker_id and run.user_id == user_id
        ]
    if not active:
        return []

    logger.warning(
        "Worker deletion requested; cancelling %d active run(s) for %s",
        len(active),
        worker_id,
    )
    remaining_ids = _cancel_active_runs(
        active,
        repos=repos_obj,
        timeout_seconds=timeout_seconds,
        reason=WORKER_DELETED_RUN_ERROR,
        mark_shutdown_cancelled=False,
    )
    if remaining_ids:
        logger.warning(
            "Worker %s deletion timed out waiting for active runs: %s",
            worker_id,
            ", ".join(sorted(remaining_ids)),
        )
    return remaining_ids


def fail_interrupted_runs_on_startup(
    *,
    user_id: str,
    repos: Repositories | None = None,
) -> int:
    """Fail old runs left in-flight by a prior API process.

    Worker execution currently runs in process-local threads. A service restart
    terminates those threads, so a sufficiently old `running` row with no live
    active-run handle is abandoned.

    Runs in status=`queued` are NOT failed here — they are re-enqueued by
    re_enqueue_queued_runs_on_startup so they resume draining after boot.

    The user_id parameter is kept for compatibility with older callers; the
    reaper operates across owners because server restarts are process-wide.
    """
    return reap_abandoned_runs(repos=repos)


_PENDING_APPROVAL_RESTART_ERROR = (
    "Run interrupted: server restarted while awaiting operator approval. "
    "Re-run the worker to restart."
)


def reap_abandoned_pending_approval_runs(
    *,
    repos: Repositories | None = None,
) -> int:
    """Fail all runs stuck in pending_approval on process startup.

    pending_approval runs have an in-process polling loop in agent_driver that
    dies when the server restarts. Unlike running runs (which use a
    timeout+grace window to avoid false positives), ALL pending_approval rows
    at boot are definitively abandoned — there is no live loop to resume them.

    Also rejects their pending approval records so they disappear from the
    Approvals UI immediately.
    """
    repos_obj = _repos(repos)
    now = datetime.now(timezone.utc).isoformat()
    failed = repos_obj.runs.fail_all_pending_approval(
        error=_PENDING_APPROVAL_RESTART_ERROR,
        error_code="approval_loop_killed",
    )
    for item in failed:
        run_id = str(item.get("run_id") or item.get("id") or "")
        user_id = str(item.get("user_id") or "")
        if not run_id or not user_id:
            continue
        try:
            repos_obj.approvals.reject(
                owner_id=user_id,
                run_id=run_id,
                decided_at=now,
                reason="Server restarted — approval polling loop killed",
            )
        except Exception as exc:
            logger.warning("Failed to reject approval for interrupted run %s: %s", run_id, exc)
        try:
            repos_obj.runs.add_log(
                user_id=user_id,
                run_id=run_id,
                level="error",
                message=_PENDING_APPROVAL_RESTART_ERROR,
                timestamp=now,
                trace_id=None,
            )
        except Exception as exc:
            logger.warning("Failed to add log for interrupted pending-approval run %s: %s", run_id, exc)
    if failed:
        logger.warning(
            "Reaped %d abandoned pending_approval run(s) on startup",
            len(failed),
        )
    return len(failed)


def re_enqueue_queued_runs_on_startup(
    *,
    repos: Repositories | None = None,
) -> int:
    """Wake the queue drain loop for runs left in status=queued by a prior process.

    Queued runs already have the right DB state; we just need to ensure the
    drain loop wakes and picks them up.  Returns the count of queued runs found.
    """
    repos_obj = _repos(repos)
    count = repos_obj.runs.count_queued()
    if count:
        logger.info("Found %d queued run(s) on startup — drain loop will pick them up", count)
        _wake_drain()
    return count


def execute_run(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    repos_obj = _repos(repos)
    owner_id = user_id or _worker_owner_id(worker_id, repos_obj)
    trace_id = f"trace_{uuid.uuid4().hex[:16]}"
    loaded = _load_worker_recipe(worker_id, repos_obj)
    config = loaded[1] if loaded else None
    instance = loaded[2] if loaded else None
    effective_inputs = _apply_config_input_defaults(
        config,
        _merge_instance_inputs(instance, inputs),
    )
    run_secrets = get_secrets_for_worker(worker_id, user_id=owner_id, repos=repos_obj)

    def log_fn(msg: str, level: str = "info") -> None:
        safe_msg = scrub_secrets(msg, run_secrets)
        add_log(
            run_id,
            safe_msg,
            level=level,
            trace_id=trace_id,
            user_id=owner_id,
            repos=repos_obj,
        )

    try:
        current_run = repos_obj.runs.get_any(run_id=run_id)
        if (current_run or {}).get("status") != RunStatus.RUNNING.value:
            update_run_status(run_id, RunStatus.RUNNING.value, user_id=owner_id, repos=repos_obj)
        log_fn("Run started")
        log_fn("Validating inputs", level="debug")

        if not config:
            err = "Worker config not found"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="invalid_worker", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            return

        if instance and not instance.get("enabled", True):
            err = "Worker is disabled"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="worker_disabled", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            return

        # Validate required inputs
        for inp in config.inputs:
            if inp.required and (inp.name not in effective_inputs or effective_inputs[inp.name] in (None, "")):
                err = f"Missing required input: {inp.name}"
                update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="missing_required_input", user_id=owner_id, repos=repos_obj)
                publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
                log_fn(err, level="error")
                return

        log_fn("Loading secrets", level="debug")
        secrets = run_secrets
        missing = [s for s in config.secrets if s not in secrets]
        if missing:
            err = f"Missing secrets: {', '.join(missing)}"
            update_run_status(run_id, RunStatus.FAILED.value, error=err, error_code="missing_secret", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": err})
            log_fn(err, level="error")
            if _maybe_pause_scheduled_worker_after_setup_failure(
                worker_id=worker_id,
                run_id=run_id,
                user_id=owner_id,
                error_code="missing_secret",
                repos=repos_obj,
            ):
                log_fn(
                    "Paused scheduled worker after repeated missing-secret setup failures",
                    level="warning",
                )
            return

        # Resolve Composio connections declared in worker.yml.
        connection_ids: Dict[str, str] = {}
        if config.connections:
            log_fn("Resolving connections", level="debug")
            from runner_utils import _resolve_connections
            connection_ids, conn_err = _resolve_connections(worker_id, log_fn, config, user_id=owner_id)
            if conn_err:
                update_run_status(run_id, RunStatus.FAILED.value, error=conn_err, error_code="missing_connection", user_id=owner_id, repos=repos_obj)
                publish_run_part(run_id, {"type": "finish", "status": "failed", "error": conn_err})
                log_fn(conn_err, level="error")
                return

        # Re-materialize worker files from DB if the dir is missing or empty
        # (empty dir can occur if a previous re-materialization was interrupted).
        try:
            _wdir = WORKERS_DIR / worker_id
            if not _wdir.is_dir() or not any(_wdir.iterdir()):
                import main as _main
                if _main.rematerialize_worker_from_db(worker_id):
                    log_fn("Re-materialized worker files from DB", level="info")
        except Exception as _rmat_exc:
            logger.warning("Worker re-materialization failed for %s: %s", worker_id, _rmat_exc)

        bundle_snapshot_path = _snapshot_worker_bundle(run_id, worker_id, config)
        if owner_id:
            repos_obj.runs.set_bundle_snapshot_path(
                user_id=owner_id,
                run_id=run_id,
                bundle_snapshot_path=bundle_snapshot_path,
            )

        # Dispatch to the appropriate sandbox driver based on worker config.
        # #603: default to "e2b" — "local" (in-process) runner was removed in
        # the security audit; all workers run inside E2B sandboxes.
        runner = "e2b"
        if config and config.runtime:
            runner = config.runtime.runner or "e2b"
        mode = config.runtime.mode if config and config.runtime else "pure-script"
        timeout_seconds = (
            config.runtime.limits.timeout_seconds
            if config and config.runtime and config.runtime.limits
            else 300
        )
        log_fn(f"Executing worker (mode={mode}, runner={runner})", level="debug")
        driver = get_sandbox_driver(runner, config=config)
        with use_context_scope(context_scope_for_user(owner_id)):
            result = driver.run(
                worker_id=worker_id,
                run_id=run_id,
                inputs=effective_inputs,
                secrets=secrets,
                log_fn=log_fn,
                trace_id=trace_id,
                timeout_seconds=timeout_seconds,
                config=config,
                connection_ids=connection_ids,
                user_id=owner_id,
            )

        if was_shutdown_cancelled(run_id):
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=INTERRUPTED_RUN_ERROR,
                error_code=INTERRUPTED_RUN_ERROR_CODE,
                user_id=owner_id,
                repos=repos_obj,
            )
            publish_run_part(
                run_id,
                {"type": "finish", "status": "failed", "error": INTERRUPTED_RUN_ERROR},
            )
            log_fn(INTERRUPTED_RUN_ERROR, level="error")
            return

        # #607: E2B driver returns status="cancelled" when the sandbox was killed
        # by a user cancel (cancel_requested flag set). Mark the run cancelled and
        # emit a finish event — do NOT fall through to schema validation or
        # completion logic.
        if result.status == "cancelled":
            update_run_status(
                run_id,
                "cancelled",
                error=result.error or "Cancelled by user",
                error_code=result.error_code or "user_cancel",
                user_id=owner_id,
                repos=repos_obj,
            )
            publish_run_part(
                run_id,
                {"type": "finish", "status": "cancelled"},
            )
            log_fn("Run cancelled by user", level="info")
            return

        outputs = result.outputs
        artifacts = result.artifacts
        _materialize_declared_file_outputs(run_id, config, outputs, artifacts)
        _store_run_artifacts(run_id, artifacts, log_fn, user_id=owner_id, repos=repos_obj)

        # #595: approvals.required auto-gate.
        # Previously, `approvals.required: true` in the manifest only worked if
        # run.py also explicitly emitted a `decision_required` event. Workers
        # that declared the flag but omitted the event would silently complete,
        # making the manifest flag a no-op.
        #
        # Fix: synthesise a decision_required payload from the run outputs when
        # the manifest declares approvals.required but run.py didn't emit one.
        # This makes the manifest flag sufficient for simple "always pause before
        # completing" use cases without requiring boilerplate in every run.py.
        worker_needs_approval = bool(
            config and getattr(config, "approvals", None) and config.approvals.required
        )
        _non_approval_terminal = {"error", "failed", "cancelled", "timeout", "rejected"}
        if (
            worker_needs_approval
            and not result.decision_required
            and result.status not in _non_approval_terminal
        ):
            approval_label = (
                config.approvals.label
                if config and config.approvals and config.approvals.label
                else "Approve to complete"
            )
            result.decision_required = {
                "label": approval_label,
                "preview": json.dumps(result.outputs, indent=2)[:2000] if result.outputs else "",
            }
            log_fn(
                "approvals.required: synthesising approval gate from manifest "
                "(run.py did not emit decision_required). Add an explicit "
                "decision_required event to customise the label and preview.",
                level="info",
            )

        # Both "error" and "failed" terminal statuses map to a failed run
        if result.status in ("error", "failed"):
            result_error = result.error
            result_error_code = result.error_code
            if was_shutdown_cancelled(run_id):
                result_error = INTERRUPTED_RUN_ERROR
                result_error_code = INTERRUPTED_RUN_ERROR_CODE
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=result_error,
                error_code=result_error_code,
                user_id=owner_id,
                repos=repos_obj,
            )
            finish_status = "timeout" if (result.error_code or "").lower().find("timeout") >= 0 else "failed"
            publish_run_part(
                run_id,
                {"type": "finish", "status": finish_status, "error": result_error or "Run failed"},
            )
            # G5 P1-A: the "Recent logs" panel renders this line verbatim, so it
            # must match the calm Error card — never the raw exception/path. Run
            # the error through the SAME operator-headline path used for the
            # Error card before logging.
            _log_failure_line = f"Run failed: {result_error}"
            try:
                import main as _main

                _calm = _main._operator_error_message(result_error, result_error_code)
                if _calm:
                    _log_failure_line = f"Run failed: {_calm}"
            except Exception:
                _log_failure_line = "Run failed."
            log_fn(_log_failure_line, level="error")

            _schedule_retry_for_failed_run(
                run_id=run_id,
                worker_id=worker_id,
                inputs=effective_inputs,
                owner_id=owner_id,
                config=config,
                result_retryable=bool(getattr(result, "retryable", False)),
                repos=repos_obj,
                log_fn=log_fn,
            )
            return

        # S47 HITL: if the worker emitted decision_required AND the worker declares
        # approvals.required, land this run as PENDING_APPROVAL and create an
        # approvals row.  Do NOT mark COMPLETED — execution halts here.
        decision_required = result.decision_required
        worker_needs_approval = bool(config and getattr(config, "approvals", None) and config.approvals.required)
        if decision_required and worker_needs_approval and result.status not in _non_approval_terminal:
            approval_id = f"apr_{uuid.uuid4().hex[:12]}"
            label = decision_required.get("label") or (config.approvals.label if config and config.approvals else "Approve action")
            preview = decision_required.get("preview") or ""
            decision_input_json = json.dumps(effective_inputs)
            now_ts = _now_iso()
            try:
                repos_obj.approvals.create(
                    owner_id=owner_id,
                    id=approval_id,
                    run_id=run_id,
                    worker_id=worker_id,
                    status="pending",
                    label=label,
                    preview=preview,
                    created_at=now_ts,
                    decision_input_json=decision_input_json,
                )
            except Exception as exc:
                logger.error("Failed to create approval row for run %s: %s", run_id, exc)
            # Store the proposed outputs on the run so the approval page can show
            # them. Persist via the repo directly (not update_run_status) so we
            # emit exactly ONE pending_approval status SSE event below — the
            # richer one carrying approval_id + label. Calling update_run_status
            # here would publish a second, leaner status event (duplicate).
            repos_obj.runs.update_status(
                user_id=owner_id,
                run_id=run_id,
                status=RunStatus.PENDING_APPROVAL.value,
                output_json=outputs,
            )
            _publish_sse(run_id, {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.PENDING_APPROVAL.value,
                "approval_id": approval_id,
                "label": label,
            })
            publish_run_part(run_id, {"type": "finish", "status": "pending_approval"})
            log_fn(f"Run awaiting approval: {label}")
            return

        # Output-schema enforcement — the SINGLE convergence point for ALL
        # three drivers (Agent / Skill / E2B script). Previously only the Agent
        # and Skill drivers called _validate_output_schema internally; the E2B
        # script driver (.py/.sh/.js — the common case) skipped it entirely, so
        # declared output `type` (json/csv/markdown/text), CSV `columns`, and
        # `json_required_keys` were silently unenforced (Vivek's P0). Validating
        # here, on the path every driver flows through, makes the contract
        # enforcement DRY and uniform. A hard type/column/key mismatch FAILS the
        # run (the whole point) rather than surfacing garbage as COMPLETED.
        schema_error = _validate_output_schema(worker_id, outputs, log_fn, config=config)
        if schema_error:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=f"Output schema violation: {schema_error}",
                error_code="schema_violation",
                user_id=owner_id,
                repos=repos_obj,
            )
            publish_run_part(
                run_id,
                {"type": "finish", "status": "failed", "error": f"Output schema violation: {schema_error}"},
            )
            log_fn(f"Output schema violation: {schema_error}", level="error")
            return

        quality_error, quality_warnings = _validate_run_outputs(run_id, config, outputs, artifacts)
        if quality_error:
            update_run_status(run_id, RunStatus.FAILED.value, error=quality_error, error_code="quality_gate_failed", user_id=owner_id, repos=repos_obj)
            publish_run_part(run_id, {"type": "finish", "status": "failed", "error": quality_error})
            log_fn(quality_error, level="error")
            return

        # Wedge fix (2026-05-29): the prompt-to-worker flow runs the
        # worker-author meta-worker, which drafts a bundle.json but cannot
        # register a worker from inside its sandbox. Register it here, on the
        # backend, the moment the author run completes — using the SAME
        # registration path /workers/draft-and-create uses — so the operator
        # gets a REAL, editable, runnable worker instead of a dead-end bundle.
        # The new worker id is stored on the run output AND broadcast via SSE
        # so /workers/new can navigate to /workers/<id>?edit=1.
        if worker_id == _WORKER_AUTHOR_WORKER_ID:
            try:
                created_worker_id = _register_authored_worker(
                    run_id,
                    outputs,
                    artifacts,
                    user_id=owner_id,
                    repos=repos_obj,
                    log_fn=log_fn,
                )
                if created_worker_id:
                    # Persist on the run output so a client that reconnects to an
                    # already-terminal run can still read the new worker id from
                    # GET /runs/{id}.output.created_worker_id (the minimal
                    # already-terminal SSE event does not carry custom fields).
                    outputs = dict(outputs or {})
                    outputs["created_worker_id"] = created_worker_id
                else:
                    # Registration failed (see run logs for gate that fired).
                    # Store flag so the create-flow frontend can show an error
                    # instead of the misleading "Worker drafted" fallback.
                    outputs = dict(outputs or {})
                    outputs["worker_creation_failed"] = True

                    # Wedge safety net: prove the generated SCRIPT-mode worker
                    # actually RUNS (and bounded-repair it if not) before telling
                    # the operator it is ready. Inline on this run's execution
                    # slot — no extra concurrency. Never fails the author run.
                    try:
                        smoke_bundle = _read_authored_bundle(run_id, artifacts)
                        smoke = smoke_and_gate_generated_worker(
                            created_worker_id,
                            smoke_bundle or {},
                            user_id=owner_id,
                            repos=repos_obj,
                            log_fn=log_fn,
                        )
                        outputs["smoke"] = smoke
                    except Exception as smoke_exc:
                        logger.exception(
                            "Smoke check failed for generated worker %s", created_worker_id
                        )
                        log_fn(
                            f"Could not smoke-test the generated worker: {smoke_exc}",
                            level="warning",
                        )
            except Exception as exc:
                # Never fail the run on registration trouble — the bundle is
                # still viewable. Log so the operator/engineer can see why.
                logger.exception("worker-author registration failed for run %s", run_id)
                log_fn(f"Could not auto-register the drafted worker: {exc}", level="warning")
                outputs = dict(outputs or {})
                outputs["worker_creation_failed"] = True

        update_run_status(run_id, RunStatus.COMPLETED.value, output=outputs, user_id=owner_id, repos=repos_obj)
        # Broadcast the new worker id on the live stream so the create flow can
        # navigate straight to the editor without a follow-up fetch.
        if worker_id == _WORKER_AUTHOR_WORKER_ID and isinstance(outputs, dict) and outputs.get("created_worker_id"):
            _smoke_event = outputs.get("smoke") if isinstance(outputs.get("smoke"), dict) else None
            _sse_event = {
                "type": "status",
                "run_id": run_id,
                "status": RunStatus.COMPLETED.value,
                "created_worker_id": outputs["created_worker_id"],
            }
            if _smoke_event:
                # Surface the smoke verdict so the create flow can tell the
                # operator "generated, but its first test run failed: <reason>"
                # instead of presenting a gated worker as ready.
                _sse_event["smoke_status"] = _smoke_event.get("status")
                # G5 P1-A: the smoke reason can carry a sandbox path
                # (/home/user/worker/run.py) or a bare Python exception. Route
                # it through the operator-headline/redaction path before it
                # leaves the backend on the SSE stream.
                try:
                    import main as _main

                    _sse_event["smoke_reason"] = _main.humanize_smoke_reason(
                        _smoke_event.get("reason")
                    )
                except Exception:
                    _sse_event["smoke_reason"] = None
            _publish_sse(run_id, _sse_event)
        if quality_warnings and owner_id:
            repos_obj.runs.update(
                user_id=owner_id,
                run_id=run_id,
                quality_warning="; ".join(quality_warnings),
            )
            log_fn(f"Quality warning: {'; '.join(quality_warnings)}", level="warning")
        publish_run_part(run_id, {"type": "finish", "status": "completed"})
        log_fn("Output generated")
        log_fn("Run completed")

    except Exception as exc:
        logger.exception("Run %s crashed for worker %s", run_id, worker_id)
        error_message = str(exc) or exc.__class__.__name__
        try:
            update_run_status(
                run_id,
                RunStatus.FAILED.value,
                error=error_message,
                error_code="run_execution_exception",
                user_id=owner_id,
                repos=repos_obj,
            )
        except Exception:
            logger.exception("Failed to mark run %s as failed after crash", run_id)
        try:
            publish_run_part(
                run_id,
                {"type": "finish", "status": "failed", "error": error_message},
            )
        except Exception:
            logger.exception("Failed to publish crash event for run %s", run_id)
        try:
            log_fn(f"Run crashed: {error_message}", level="error")
        except Exception:
            logger.exception("Failed to persist crash log for run %s", run_id)
        return


def start_run(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    *,
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    """Enqueue a run for execution.

    The run row already has status=queued (set by create_run).  We wake the
    drain loop which will acquire an execution semaphore slot and dispatch the
    run as soon as capacity is available.  This call is always instant.
    """
    _wake_drain()


def _run_thread_entry(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    try:
        execute_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
    finally:
        _unregister_active_run(run_id)


def _run_thread_entry_with_semaphore(
    run_id: str,
    worker_id: str,
    inputs: Dict[str, Any],
    user_id: str | None = None,
    repos: Repositories | None = None,
) -> None:
    """Thread entry point used by the drain loop.

    The semaphore is already acquired before this thread is created.  We
    release it in the finally block so the next queued run can be dispatched.
    """
    try:
        # Check for pre-dispatch cancellation (cancelled while queued).
        repos_obj = _repos(repos)
        run_row = repos_obj.runs.get_any(run_id=run_id)
        if run_row and run_row.get("cancel_requested"):
            owner_id = user_id or run_row.get("user_id")
            cancelled_at = _now_iso()
            cancel_error = "Run was cancelled before execution started."
            logger.info("Run %s cancelled before dispatch — skipping execution", run_id)
            try:
                update_run_status(
                    run_id,
                    RunStatus.FAILED.value,
                    error=cancel_error,
                    error_code="cancelled_before_start",
                    user_id=owner_id,
                    repos=repos_obj,
                )
                _publish_sse(run_id, {
                    "type": "status",
                    "run_id": run_id,
                    "status": RunStatus.FAILED.value,
                    "error": cancel_error,
                })
            except Exception as exc:
                logger.warning("Failed to mark pre-dispatch cancellation for run %s: %s", run_id, exc)
            return
        execute_run(run_id, worker_id, inputs, user_id=user_id, repos=repos)
    finally:
        _unregister_active_run(run_id)
        _get_semaphore().release()
        # Wake the drain loop so the next queued run can fill the freed slot.
        _wake_drain()
