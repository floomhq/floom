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
from typing import Any, Dict, Optional

from models import (
    RunStatus,
    assert_safe_outbound_url,
    UnsafeOutboundUrlError,
    _allow_private_mcp_urls,
    _ip_is_disallowed,
    _resolve_host_ips,
)

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


def _run_email_html(
    *,
    worker_name: str,
    worker_id: str,
    run_id: str,
    status_label: str,
    timestamp: str,
    error: str | None,
) -> str:
    """Branded run-notification email. Branding is env-configurable for self-hosters:
    WORKEROS_BRAND_NAME (default "Floom"), WORKERS_FRONTEND_URL (header/footer link),
    WORKEROS_EMAIL_LOGO_URL (optional absolute https logo; falls back to the brand name
    as text), and WORKEROS_SUPPORT_EMAIL (optional footer contact)."""
    brand = (os.environ.get("WORKEROS_BRAND_NAME") or "Floom").strip() or "Floom"
    frontend_url = (os.environ.get("WORKERS_FRONTEND_URL") or "http://localhost:3000").rstrip("/")
    # Gmail requires an absolute https <img> src in email (data URIs are stripped),
    # so the logo must be a public URL; when unset we render the brand name as text.
    logo_url = (os.environ.get("WORKEROS_EMAIL_LOGO_URL") or "").strip()
    support_email = (os.environ.get("WORKEROS_SUPPORT_EMAIL") or "").strip()
    brand_mark = (
        f'<img src="{logo_url}" width="120" height="42" alt="{brand}" style="display:block;border:0;outline:none;height:42px;width:120px;max-width:120px;">'
        if logo_url
        else f'<span style="font-size:20px;font-weight:700;color:#16171A;">{brand}</span>'
    )
    footer_contact = (
        f' &middot; <a href="mailto:{support_email}" style="color:#3E6FE0;text-decoration:underline;">{support_email}</a>'
        if support_email
        else ""
    )
    is_failed = status_label.lower() == "failed"
    status_color = "#E5533D" if is_failed else "#2F8F5B"
    rows = [
        ("Worker", f"{worker_name} <span style=\"color:#6B7280;\">({worker_id})</span>"),
        ("Run ID", f"<span style=\"font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;\">{run_id}</span>"),
        ("Status", f"<span style=\"color:{status_color};font-weight:650;\">{status_label}</span>"),
        ("Time", timestamp),
    ]
    if error:
        rows.append(("Error", f"<span style=\"font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:#E5533D;\">{error}</span>"))
    row_html = "".join(
        f"<tr><td style=\"padding:6px 0;font-size:13px;color:#6B7280;width:96px;vertical-align:top;\">{label}</td>"
        f"<td style=\"padding:6px 0;font-size:14px;color:#16171A;\">{value}</td></tr>"
        for label, value in rows
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>{brand}</title></head>
<body style="margin:0;padding:0;background:#FBFBFC;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16171A;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FBFBFC;"><tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">
<tr><td style="background:#F2F3F5;border:1px solid rgba(20,23,26,0.08);border-bottom:none;border-radius:16px 16px 0 0;padding:26px 36px;">
<a href="{frontend_url}" style="text-decoration:none;display:inline-block;">{brand_mark}</a>
</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid rgba(20,23,26,0.08);border-top:none;border-radius:0 0 16px 16px;padding:36px 40px 40px;">
<p style="margin:0 0 10px;font-size:11px;line-height:1.4;font-weight:650;letter-spacing:0.12em;text-transform:uppercase;color:#6B7280;">Worker run</p>
<h1 style="margin:0 0 22px;font-size:22px;line-height:1.25;font-weight:650;color:#16171A;">{worker_name} {status_label}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">{row_html}</table>
<p style="font-size:13px;line-height:1.55;margin:24px 0 0;color:#6B7280;">You're receiving this because a worker run finished in your {brand} workspace.</p>
</td></tr>
<tr><td style="padding:28px 4px 4px;font-size:12px;line-height:1.6;color:#6B7280;">
<a href="{frontend_url}" style="color:#16171A;font-weight:650;text-decoration:none;">{brand}</a>{footer_contact}
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

    from_addr = os.environ.get("NOTIFY_FROM_EMAIL", "notifications@example.com").strip()
    # The user-facing brand is "Floom". Force the From display name to "Floom"
    # regardless of how NOTIFY_FROM_EMAIL is configured (it must never read
    # "Floom" to recipients). Preserve the address, override the name.
    _email_only = from_addr.split("<")[-1].strip(" <>") if "<" in from_addr else from_addr
    if _email_only:
        from_addr = f"Floom <{_email_only}>"
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

    html = _run_email_html(
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
    from run_service import (
        _workspace_toggle,
        _workspace_failure_email_recipients,
        _maybe_pause_worker_after_consecutive_failures,
    )
    if status not in {RunStatus.COMPLETED.value, RunStatus.FAILED.value}:
        return

    # Resolve worker name once for channel DMs.
    try:
        _w_row_alert = repos.workers.get_any(worker_id=worker_id)
        _worker_name_for_alert = (_w_row_alert or {}).get("name") or worker_id
    except Exception:
        _worker_name_for_alert = worker_id

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
            return
        # #794: workspace 'failure_email_enabled' toggle — email the workspace's
        # configured address on ANY run failure (distinct from the per-worker
        # email_to alert above). Best-effort; skipped when no recipient/RESEND.
        try:
            if _workspace_toggle("failure_email_enabled", env_var="WORKEROS_FAILURE_EMAIL", default=False):
                recipients = _workspace_failure_email_recipients()
                if recipients:
                    _send_email_notification(
                        to_addrs=recipients,
                        worker_name=worker_id,
                        run_id=run_id,
                        worker_id=worker_id,
                        status=status,
                        error=error,
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


