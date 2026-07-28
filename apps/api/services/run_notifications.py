"""Run notifications: failure emails + SSRF-pinned alert webhooks.

Builds the run-failure/success email, fires alert webhooks over DNS-pinned,
redirect-blocked HTTP connections (SSRF-safe), and dispatches terminal-run alerts.
Extracted verbatim from run_service.py. SSRF guards + RunStatus come from models;
the three workspace/pause helpers are imported lazily from run_service inside the
one function that uses them, so there is no module-load circular import.
run_service re-imports these names.
"""
from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import logging
import os
import queue
import socket as _socket
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html import escape
from email.utils import parseaddr
from typing import Any, Callable, Dict, Optional

from models import (
    RunStatus,
    assert_safe_outbound_url,
    UnsafeOutboundUrlError,
    _allow_private_mcp_urls,
    _ip_is_disallowed,
    _resolve_host_ips,
)

logger = logging.getLogger("floom.run_service")

FLOOM_EMAIL_LOGO_URL = "https://workers.floom.dev/brand/floom-email-logo@2x.png"
FLOOM_NOTIFICATIONS_FROM = "Floom <notifications@floom.dev>"

RESEND_API_BASE_URL = "https://api.resend.com"
RESEND_SEND_URL = f"{RESEND_API_BASE_URL}/emails"


def _resend_timeout_seconds() -> float:
    try:
        return max(0.1, float(os.environ.get("WORKEROS_RESEND_TIMEOUT_SECONDS", "10")))
    except ValueError:
        return 10.0


def _resend_send_url() -> str:
    """The Resend send endpoint, honouring the SDK's own RESEND_API_URL override.

    The resend SDK read this env var to retarget the API (proxy, test endpoint,
    self-hosted gateway). Dropping the SDK must not silently drop that knob.
    """
    base = (os.environ.get("RESEND_API_URL") or RESEND_API_BASE_URL).strip().rstrip("/")
    return f"{base or RESEND_API_BASE_URL}/emails"


def _resend_send(*, api_key: str, params: dict[str, Any]) -> dict[str, Any]:
    """POST one email to Resend with the credential carried on that request.

    Deliberately not the resend SDK. The SDK reads its credential from the
    process-global ``resend.api_key`` when it BUILDS the request, not when you
    assign it, so anything else in the process that assigns that global can
    interleave with a send here and ship the email under the wrong account's
    credential. That is not hypothetical: the hosted wrapper vendors this
    engine and sends its own auth mail from a second Resend account in the same
    process, and this notification path runs on its own daemon sender thread.
    A per-request Authorization header has no shared state to lose.

    Mirrors the same fix on the cloud side (workeros-cloud #1277, 2a0b474).
    """
    import httpx

    response = httpx.post(
        _resend_send_url(),
        json=params,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        timeout=_resend_timeout_seconds(),
    )
    # Only a 2xx means Resend accepted the email. httpx does not follow
    # redirects, so a 3xx is an undelivered email and has to read as a failure
    # rather than as a body with no message id. (The old SDK went through
    # requests, which does follow; chasing a redirect here would only have
    # arrived unauthenticated anyway, since httpx strips Authorization across
    # origins.)
    if not 200 <= response.status_code < 300:
        detail = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                detail = str(body.get("message") or body.get("name") or "")
        except Exception:
            detail = ""
        raise RuntimeError(
            f"Resend returned {response.status_code}{': ' + detail if detail else ''}"
        )
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


def _resend_post_with_timeout(api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Run one Resend send under a hard wall-clock bound.

    ``httpx`` applies its timeout per operation (connect, write, read), so a
    pathological endpoint can still outlive it overall. This alert path runs on
    a daemon thread that must never park, so the send keeps its own strict
    join-based ceiling on top.

    Renamed from ``_resend_send_with_timeout``, whose first argument was the
    resend SDK module. That contract cannot survive dropping the SDK, so the
    name goes with it: an out-of-tree importer gets a loud ImportError instead
    of a silently reinterpreted first argument.
    """
    timeout = _resend_timeout_seconds()
    result: "queue.Queue[BaseException | dict[str, Any]]" = queue.Queue(maxsize=1)

    def _send() -> None:
        try:
            result.put(_resend_send(api_key=api_key, params=payload))
        except BaseException as exc:
            result.put(exc)

    thread = threading.Thread(target=_send, daemon=True, name="workeros-resend-send")
    thread.start()
    thread.join(timeout=timeout)
    if thread.is_alive():
        raise TimeoutError(f"Resend email send exceeded {timeout:g}s timeout")
    outcome = result.get_nowait()
    if isinstance(outcome, BaseException):
        raise outcome
    return outcome


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


def _strip_to_plain_text(raw: str) -> str:
    """Strip HTML tags and normalise whitespace for plain-text summary lines."""
    import re
    text = re.sub(r"<[^>]+>", " ", raw)
    return " ".join(text.split())


def _format_duration_ms(ms: int | None) -> str | None:
    """Convert milliseconds to a human-readable string (e.g. '2m 13s' or '45s')."""
    if ms is None or ms < 0:
        return None
    total_s = ms // 1000
    if total_s < 60:
        return f"{total_s}s"
    return f"{total_s // 60}m {total_s % 60}s"


def _run_email_html(
    *,
    worker_name: str,
    worker_id: str,
    run_id: str,
    status_label: str,
    timestamp: str,
    error: str | None,
    # L3: run summary fields — all optional so existing callers need no changes.
    output_summary: str | None = None,
    duration_label: str | None = None,
    trigger_source: str | None = None,
    cta_url: str | None = None,
    cta_label: str = "View full run",
    intro_text: str | None = None,
) -> str:
    """Branded run-notification email. Branding is env-configurable for self-hosters:
    WORKEROS_BRAND_NAME (default "Floom"), WORKERS_FRONTEND_URL (header/footer link),
    WORKEROS_EMAIL_LOGO_URL (optional absolute https logo; falls back to the brand name
    as text), WORKEROS_SUPPORT_EMAIL (optional footer contact), and
    WORKEROS_EMAIL_UNSUBSCRIBE_URL (optional alert-management or unsubscribe URL)."""
    brand = (os.environ.get("WORKEROS_BRAND_NAME") or "Floom").strip() or "Floom"
    frontend_url = (os.environ.get("WORKERS_FRONTEND_URL") or "https://floom.dev/app").rstrip("/")
    # Gmail requires an absolute https <img> src in email (data URIs are stripped),
    # so the logo must be a public URL; when unset we render the brand name as text.
    logo_url = (os.environ.get("WORKEROS_EMAIL_LOGO_URL") or FLOOM_EMAIL_LOGO_URL).strip()
    support_email = (os.environ.get("WORKEROS_SUPPORT_EMAIL") or "").strip()
    unsubscribe_header_url = (os.environ.get("WORKEROS_EMAIL_UNSUBSCRIBE_URL") or "").strip()
    safe_brand = escape(brand)
    safe_frontend_url = escape(frontend_url, quote=True)
    safe_logo_url = escape(logo_url, quote=True)
    run_url = f"{frontend_url}/runs/{run_id}"
    manage_alerts_url = unsubscribe_header_url or f"{frontend_url}/workers/{worker_id}"
    safe_run_url = escape(run_url, quote=True)
    safe_cta_url = escape((cta_url or run_url), quote=True)
    safe_cta_label = escape(cta_label)
    brand_mark = (
        f'<img src="{safe_logo_url}" width="120" height="42" alt="{safe_brand}" style="display:block;border:0;outline:none;height:42px;width:120px;max-width:120px;">'
        if logo_url
        else f'<span style="font-size:20px;font-weight:700;color:#16171A;">{safe_brand}</span>'
    )
    footer_contact = (
        f' &middot; <a href="mailto:{escape(support_email, quote=True)}" style="color:#3563CC;text-decoration:underline;">{escape(support_email)}</a>'
        if support_email
        else ""
    )
    footer_unsubscribe = f' &middot; <a href="{escape(manage_alerts_url, quote=True)}" style="color:#3563CC;text-decoration:underline;">Manage alerts</a>'
    status_key = status_label.lower()
    is_failed = status_key == "failed"
    is_approval = status_key in {"pending approval", "needs approval"}
    status_color = "#E5533D" if is_failed else "#9A6700" if is_approval else "#2F8F5B"
    headline = "needs attention" if is_failed else "needs your approval" if is_approval else "finished successfully"
    body_intro = intro_text or "Floom finished a worker run in your workspace. The details are below, and the full run log is ready in the dashboard."
    rows = [
        ("Worker", f"{worker_name} <span style=\"color:#62697A;\">({worker_id})</span>"),
        ("Run ID", f"<span style=\"font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;\">{run_id}</span>"),
        ("Status", f"<span style=\"color:{status_color};font-weight:650;\">{status_label}</span>"),
        ("Time", timestamp),
    ]
    if error:
        rows.append(("Error", f"<span style=\"font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#E5533D;\">{error}</span>"))
    if duration_label:
        rows.append(("Duration", escape(duration_label)))
    if trigger_source:
        rows.append(("Trigger", escape(trigger_source)))
    row_html = "".join(
        f"<tr><td style=\"padding:6px 0;font-size:13px;color:#62697A;width:96px;vertical-align:top;\">{label}</td>"
        f"<td style=\"padding:6px 0;font-size:14px;color:#16171A;\">{value}</td></tr>"
        for label, value in rows
    )
    # L3: output summary block — plain-text excerpt, hard-truncated to 1000 chars.
    # Never inline raw multi-KB/MB output; strip HTML tags first.
    if output_summary:
        stripped = _strip_to_plain_text(output_summary)
        truncated = stripped[:1000]
        truncation_note = (
            f' <a href="{safe_run_url}" style="color:#3563CC;text-decoration:underline;">… view full run</a>'
            if len(stripped) > 1000
            else ""
        )
        summary_block = (
            f'<div style="margin:22px 0 0;padding:14px 16px;background:#F3F4F6;border-radius:6px;">'
            f'<p style="margin:0 0 6px;font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:#62697A;">Output summary</p>'
            f'<p style="margin:0;font-size:13px;line-height:1.6;color:#16171A;white-space:pre-wrap;">'
            f'{escape(truncated)}{truncation_note}'
            f'</p></div>\n'
        )
    else:
        summary_block = ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>{brand}</title></head>
<body style="margin:0;padding:0;background:#FBFBFC;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16171A;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBFBFC;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="background:#FFFFFF;border:1px solid #E5E7EB;border-radius:8px;padding:38px 40px 40px;">
<a href="{safe_frontend_url}" style="text-decoration:none;display:inline-block;margin:0 0 26px;">{brand_mark}</a>
<p style="margin:0 0 10px;font-size:11px;line-height:1.4;font-weight:650;letter-spacing:0.12em;text-transform:uppercase;color:#62697A;">Worker run</p>
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;font-weight:650;color:#16171A;">{worker_name} {headline}</h1>
<p style="font-size:15px;line-height:1.6;margin:0 0 22px;color:#16171A;">{escape(body_intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{row_html}</table>
{summary_block}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;"><tr><td style="border-radius:8px;background:#111317;"><a href="{safe_cta_url}" style="display:inline-block;background:#111317;color:#FFFFFF;text-decoration:none;padding:13px 18px;border-radius:8px;font-size:14px;font-weight:700;line-height:1;">{safe_cta_label}</a></td></tr></table>
<p style="font-size:13px;line-height:1.55;margin:16px 0 0;color:#62697A;">You are receiving this because email alerts are enabled for this {safe_brand} workspace.</p>
</td></tr>
<tr><td style="padding:28px 4px 4px;font-size:12px;line-height:1.6;color:#62697A;">
<a href="https://floom.dev" style="color:#16171A;font-weight:650;text-decoration:none;">floom.dev</a>{footer_contact}{footer_unsubscribe}
</td></tr>
</table>
</td></tr></table>
</body></html>"""


def _normalize_floom_sender(raw: str, *, fallback: str = FLOOM_NOTIFICATIONS_FROM) -> str:
    _, parsed = parseaddr(raw.strip())
    if not parsed:
        parsed = parseaddr(fallback)[1]
    local, _, domain = parsed.partition("@")
    fallback_addr = parseaddr(fallback)[1]
    if domain.lower() == "floom.dev" and local.lower() in {"noreply", "no-reply"}:
        parsed = fallback_addr
    return f"Floom <{parsed}>"


def _send_email_notification(
    *,
    to_addrs: list[str],
    worker_name: str,
    run_id: str,
    worker_id: str,
    status: str,
    error: str | None,
    subject_template: str | None = None,
    # L3: optional run summary fields for completed-run emails.
    output_summary: str | None = None,
    duration_ms: int | None = None,
    trigger_source: str | None = None,
    approval_url: str | None = None,
    approval_label: str | None = None,
) -> None:
    """Send a run-notification email via Resend (RESEND_API_KEY env var required)."""
    api_key = os.environ.get("RESEND_API_KEY", "").strip()
    if not api_key:
        logger.debug("RESEND_API_KEY not set — skipping email notification for run %s", run_id)
        return
    if not to_addrs:
        return

    from_addr = _normalize_floom_sender(
        os.environ.get("WORKEROS_EMAIL_FROM")
        or os.environ.get("NOTIFY_FROM_EMAIL", FLOOM_NOTIFICATIONS_FROM)
    )
    if status == RunStatus.FAILED.value:
        status_label = "failed"
    elif status == RunStatus.PENDING_APPROVAL.value:
        status_label = "needs approval"
    else:
        status_label = "completed"
    default_subject = "Approval needed: {worker_name}" if status == RunStatus.PENDING_APPROVAL.value else "Worker {worker_name} {status}"
    subject = (subject_template or default_subject).format(
        worker_name=worker_name, status=status_label, run_id=run_id
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    safe_worker_name = escape(worker_name)
    safe_worker_id = escape(worker_id)
    safe_run_id = escape(run_id)
    safe_status_label = escape(status_label)
    safe_error = escape(error) if error else None

    duration_label = _format_duration_ms(duration_ms)
    html = _run_email_html(
        worker_name=safe_worker_name,
        worker_id=safe_worker_id,
        run_id=safe_run_id,
        status_label=safe_status_label,
        timestamp=timestamp,
        error=safe_error,
        output_summary=output_summary,
        duration_label=duration_label,
        trigger_source=trigger_source,
        cta_url=approval_url,
        cta_label="Review approval" if approval_url else "View full run",
        intro_text=(
            f"{approval_label or 'This worker run'} needs your approval before Floom continues."
            if approval_url
            else None
        ),
    )

    text_lines = [
        f"Worker: {worker_name} ({worker_id})",
        f"Run ID: {run_id}",
        f"Status: {status_label}",
        f"Time: {timestamp}",
    ]
    if duration_label:
        text_lines.append(f"Duration: {duration_label}")
    if trigger_source:
        text_lines.append(f"Trigger: {trigger_source}")
    if error:
        text_lines += ["", f"Error: {error}"]
    if output_summary:
        stripped = _strip_to_plain_text(output_summary)
        truncated = stripped[:1000]
        suffix = " … (view full run)" if len(stripped) > 1000 else ""
        text_lines += ["", "Output summary:", truncated + suffix]
    if approval_url:
        text_lines += ["", f"Approval: {approval_label or 'Review approval'}", approval_url]

    try:
        payload = {
            "from": from_addr,
            "to": to_addrs,
            "subject": subject,
            "html": html,
            "text": "\n".join(text_lines),
        }
        unsubscribe_url = (os.environ.get("WORKEROS_EMAIL_UNSUBSCRIBE_URL") or "").strip()
        if unsubscribe_url:
            payload["headers"] = {
                "List-Unsubscribe": f"<{unsubscribe_url}>",
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
        response = _resend_post_with_timeout(api_key, payload)
        logger.debug(
            "Email notification sent via Resend to %s for run %s (%s) id=%s",
            to_addrs,
            run_id,
            status,
            response.get("id"),
        )
    except Exception as exc:
        logger.warning("Resend email notification failed for run %s: %s", run_id, exc)


def _fire_alert_webhooks(
    *,
    run_id: str,
    worker_id: str,
    status: str,
    error: str | None,
    repos: "Repositories",
    user_id: str | None = None,
    failure_email_allowed: "Callable[[], bool] | None" = None,
) -> None:
    """Fire registered webhook and email alerts matching the run's terminal status.

    Runs in a daemon thread so it never blocks run finalisation.
    Errors are logged but never re-raised.

    ``failure_email_allowed`` (optional) is a throttle gate: when the run FAILED
    it is called before sending a failure email and, if it returns False, the
    email is suppressed (webhooks still fire). This is how the dedup +
    per-workspace daily cap in services/alert_throttle.py stops a crash-looping
    worker from exhausting the shared email quota. Webhooks and success emails
    are never throttled. Default None preserves the pre-throttle behaviour.
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

    # L3: resolve run summary fields for completed-run email bodies.
    _run_output_summary: str | None = None
    _run_duration_ms: int | None = None
    _run_trigger_source: str | None = None
    try:
        _run_row = repos.runs.get(user_id=user_id, run_id=run_id) if user_id else None
        if _run_row:
            _output = (_run_row.get("output") or {}) if isinstance(_run_row.get("output"), dict) else {}
            _raw_summary = str(_output.get("summary") or _output.get("result") or "").strip()
            if _raw_summary:
                _run_output_summary = _raw_summary
            _run_duration_ms = _run_row.get("duration_ms")
            _run_trigger_source = _run_row.get("trigger_source")
    except Exception:
        pass

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
            # Emit both names for a deprecation window. Existing customer
            # receivers may verify the legacy Workeros HMAC/run headers and
            # cannot all be upgraded in lockstep with the product rename.
            headers = {
                "Content-Type": "application/json",
                "X-Floom-Run-Id": run_id,
                "X-Workeros-Run-Id": run_id,
            }
            if secret:
                sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()  # type: ignore[attr-defined]
                headers["X-Floom-Signature"] = f"sha256={sig}"
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
            # Throttle failure emails only (storm source). A suppressed email
            # does NOT skip the webhook above; success emails are never gated.
            if (
                status == RunStatus.FAILED.value
                and failure_email_allowed is not None
                and not failure_email_allowed()
            ):
                logger.info(
                    "Suppressing throttled per-worker failure email for worker %s run %s",
                    worker_id,
                    run_id,
                )
                continue
            _send_email_notification(
                to_addrs=to_addrs,
                worker_name=worker_name,
                run_id=run_id,
                worker_id=worker_id,
                status=status,
                error=error,
                output_summary=_run_output_summary,
                duration_ms=_run_duration_ms,
                trigger_source=_run_trigger_source,
            )


def _email_recipients_from_alert_row(row: dict[str, Any]) -> list[str]:
    email_to_raw = (row.get("email_to") or "").strip()
    if not email_to_raw:
        return []
    try:
        parsed = json.loads(email_to_raw)
    except Exception:
        parsed = [e.strip() for e in email_to_raw.split(",") if e.strip()]
    if not isinstance(parsed, list):
        return []
    return [str(e).strip() for e in parsed if str(e).strip()]


def notify_pending_approval_via_email(
    *,
    owner_id: str,
    run_id: str,
    worker_id: str,
    worker_name: str,
    label: str,
    approval_id: str,
    repos: "Repositories",
) -> None:
    """Email configured worker alert recipients when a run needs approval."""
    try:
        from core.approval_signing import try_approval_review_url

        approval_url = try_approval_review_url({
            "id": approval_id,
            "run_id": run_id,
            "owner_id": owner_id,
        })
    except Exception:
        logger.debug("approval email link mint failed for run %s", run_id, exc_info=True)
        approval_url = None
    if not approval_url:
        logger.debug("approval email skipped for run %s because no signed review URL is available", run_id)
        return

    try:
        alert_rows = repos.alerts.list(worker_id=worker_id)
    except Exception:
        logger.debug("approval email alert lookup failed for run %s", run_id, exc_info=True)
        return

    try:
        worker_row = repos.workers.get_any(worker_id=worker_id)
        workspace_id = (worker_row or {}).get("workspace_id")
    except Exception:
        workspace_id = None

    allowed = None

    def _approval_email_allowed() -> bool:
        nonlocal allowed
        if allowed is None:
            try:
                from services.alert_throttle import should_send_failure_alert

                allowed = should_send_failure_alert(
                    repos=repos,
                    workspace_id=workspace_id,
                    worker_id=worker_id,
                    signature=f"approval_required:{approval_id}",
                )
            except Exception:
                logger.debug("approval email throttle gate errored; allowing send", exc_info=True)
                allowed = True
        return bool(allowed)

    for row in alert_rows:
        recipients = _email_recipients_from_alert_row(row)
        if not recipients:
            continue
        events = {e.strip() for e in (row.get("events") or "").split(",") if e.strip()}
        if not events.intersection({"all", "completed", "approval_required", "pending_approval"}):
            continue
        if not _approval_email_allowed():
            logger.info("Suppressing throttled approval email for worker %s run %s", worker_id, run_id)
            continue
        _send_email_notification(
            to_addrs=recipients,
            worker_name=worker_name,
            run_id=run_id,
            worker_id=worker_id,
            status=RunStatus.PENDING_APPROVAL.value,
            error=None,
            approval_url=approval_url,
            approval_label=label,
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
    from run_service import (
        _workspace_toggle,
        _workspace_failure_email_recipients,
        _maybe_pause_worker_after_consecutive_failures,
    )
    if status not in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
        return

    # Resolve worker name + workspace once for channel DMs and alert throttling.
    _workspace_id_for_alert: str | None = None
    try:
        _w_row_alert = repos.workers.get_any(worker_id=worker_id)
        _worker_name_for_alert = (_w_row_alert or {}).get("name") or worker_id
        _workspace_id_for_alert = (_w_row_alert or {}).get("workspace_id")
    except Exception:
        _worker_name_for_alert = worker_id

    # Failure-alert throttle gate. Reserves at most ONE alert slot per failed
    # run (lazily, on first real send attempt) shared across the per-worker
    # email and the workspace failure email, so a single failed run counts once
    # against the dedup window + per-workspace daily cap. Success runs are never
    # gated. Any error fails OPEN (send) so throttling can't silence real alerts.
    _alert_gate_state = {"resolved": False, "allowed": True}

    def _failure_email_allowed() -> bool:
        if status != RunStatus.FAILED.value:
            return True
        if not _alert_gate_state["resolved"]:
            try:
                from services.alert_throttle import (
                    should_send_failure_alert,
                    failure_signature,
                )

                _sig = failure_signature(error=error, status=status)
                _alert_gate_state["allowed"] = should_send_failure_alert(
                    repos=repos,
                    workspace_id=_workspace_id_for_alert,
                    worker_id=worker_id,
                    signature=_sig,
                )
            except Exception:
                logger.debug(
                    "failure-alert throttle gate errored; allowing send",
                    exc_info=True,
                )
                _alert_gate_state["allowed"] = True
            _alert_gate_state["resolved"] = True
        return bool(_alert_gate_state["allowed"])

    # Resolve a one-line result summary for the completion DM.
    _result_summary: str | None = None
    try:
        _run_row_alert = repos.runs.get(user_id=user_id, run_id=run_id) if user_id else None
        if _run_row_alert:
            _output = (_run_row_alert.get("output") or {}) if isinstance(
                _run_row_alert.get("output"), dict
            ) else {}
            # Try common summary keys; fall back to error text for failures.
            _result_summary = (
                str(_output.get("summary") or _output.get("result") or "").strip()[:200]
                or (str(error or "").strip()[:200] if status == RunStatus.FAILED.value else None)
            ) or None
    except Exception:
        pass

    def _deliver() -> None:
        _fire_alert_webhooks(
            run_id=run_id,
            worker_id=worker_id,
            status=status,
            error=error,
            repos=repos,
            user_id=user_id,
            failure_email_allowed=_failure_email_allowed,
        )

        # Feature #1382: DM the run owner on Slack and WhatsApp when a run
        # reaches a terminal status.  Best-effort — never blocks finalization.
        try:
            from channels.common import notify_run_complete_via_slack
            notify_run_complete_via_slack(
                owner_id=user_id or "",
                run_id=run_id,
                worker_name=_worker_name_for_alert,
                status=status,
                result_summary=_result_summary,
            )
        except Exception:
            logger.debug(
                "Slack run-complete DM failed for run %s", run_id, exc_info=True
            )
        try:
            from channels.common import notify_run_complete_via_whatsapp
            notify_run_complete_via_whatsapp(
                owner_id=user_id or "",
                run_id=run_id,
                worker_name=_worker_name_for_alert,
                status=status,
                result_summary=_result_summary,
            )
        except Exception:
            logger.debug(
                "WhatsApp run-complete DM failed for run %s", run_id, exc_info=True
            )

        if status != RunStatus.FAILED.value:
            # Worker recovered — clear its throttle history so the NEXT failure
            # re-alerts immediately rather than waiting out the cooldown window.
            try:
                from services.alert_throttle import note_worker_recovered

                note_worker_recovered(
                    repos=repos,
                    workspace_id=_workspace_id_for_alert,
                    worker_id=worker_id,
                )
            except Exception:
                logger.debug("failure-alert recovery note failed for run %s", run_id, exc_info=True)
            return
        # #794: workspace 'failure_email_enabled' toggle — email the workspace's
        # configured address on ANY run failure (distinct from the per-worker
        # email_to alert above). Best-effort; skipped when no recipient/RESEND.
        # Throttled by the shared failure-alert gate so a crash-looping worker
        # can't exhaust the shared email quota.
        try:
            if _workspace_toggle("failure_email_enabled", env_var="WORKEROS_FAILURE_EMAIL", default=False):
                recipients = _workspace_failure_email_recipients()
                if recipients and _failure_email_allowed():
                    _send_email_notification(
                        to_addrs=recipients,
                        worker_name=worker_id,
                        run_id=run_id,
                        worker_id=worker_id,
                        status=status,
                        error=error,
                    )
                elif recipients:
                    logger.info(
                        "Suppressing throttled workspace failure email for worker %s run %s",
                        worker_id,
                        run_id,
                    )
        except Exception:
            logger.debug("workspace failure-email dispatch failed for run %s", run_id, exc_info=True)
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
        # Deprecated no-op for broad auto-pause; keep the compatibility call so
        # older imports/tests still resolve while incidents remain the live path.
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
