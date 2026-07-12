"""L3: run-email-summary — truncation boundary and new fields in _run_email_html.

Tests:
  - output_summary None → no summary block in HTML or text
  - output_summary ≤1000 chars → full text, no "view full run" deep-link in body
  - output_summary >1000 chars → hard-truncated at 1000, appends deep-link
  - HTML tags stripped before truncation
  - duration_ms → human-readable label in email rows
  - trigger_source → rendered in email rows
  - _format_duration_ms edge cases
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _mod():
    return importlib.import_module("services.run_notifications")


# ---------------------------------------------------------------------------
# _format_duration_ms
# ---------------------------------------------------------------------------

def test_format_duration_ms_none():
    m = _mod()
    assert m._format_duration_ms(None) is None


def test_format_duration_ms_zero():
    m = _mod()
    assert m._format_duration_ms(0) == "0s"


def test_format_duration_ms_under_minute():
    m = _mod()
    assert m._format_duration_ms(45_000) == "45s"


def test_format_duration_ms_over_minute():
    m = _mod()
    assert m._format_duration_ms(133_000) == "2m 13s"


def test_format_duration_ms_exact_minute():
    m = _mod()
    assert m._format_duration_ms(60_000) == "1m 0s"


# ---------------------------------------------------------------------------
# _strip_to_plain_text
# ---------------------------------------------------------------------------

def test_strip_plain_removes_tags():
    m = _mod()
    assert m._strip_to_plain_text("<b>hello</b> <em>world</em>") == "hello world"


def test_strip_plain_collapses_whitespace():
    m = _mod()
    result = m._strip_to_plain_text("  foo  \n  bar  ")
    assert result == "foo bar"


# ---------------------------------------------------------------------------
# _run_email_html — no summary
# ---------------------------------------------------------------------------

def _build_email(summary=None, duration_ms=None, trigger_source=None):
    m = _mod()
    return m._run_email_html(
        worker_name="Test Worker",
        worker_id="wk_test",
        run_id="run_abc",
        status_label="completed",
        timestamp="2026-07-05 12:00 UTC",
        error=None,
        output_summary=summary,
        duration_label=m._format_duration_ms(duration_ms),
        trigger_source=trigger_source,
    )


def test_no_summary_no_block():
    html = _build_email()
    assert "Output summary" not in html
    assert "view full run" not in html


def test_summary_short_no_truncation_link():
    html = _build_email(summary="Job done.")
    assert "Output summary" in html
    assert "Job done." in html
    # Under 1000 chars — no ellipsis deep-link
    assert "… view full run" not in html


def test_summary_exact_1000_no_truncation_link():
    payload = "x" * 1000
    html = _build_email(summary=payload)
    assert "Output summary" in html
    assert "… view full run" not in html


def test_summary_over_1000_truncated_with_link():
    payload = "a" * 1001
    html = _build_email(summary=payload)
    assert "Output summary" in html
    # Truncated at 1000; the 1001st char must not appear as content.
    # The link appears instead.
    assert "… view full run" in html
    # Exact 1000 'a' chars should be present, not 1001.
    assert "a" * 1001 not in html
    assert "a" * 1000 in html


def test_summary_html_stripped_before_truncation():
    # 990 real chars + 11-char tag (stripped) so total stripped = 990 ≤ 1000 → no link.
    payload = "b" * 990 + "<br/>" + "c" * 5
    html = _build_email(summary=payload)
    assert "Output summary" in html
    assert "… view full run" not in html


def test_duration_in_email():
    html = _build_email(duration_ms=133_000)
    assert "Duration" in html
    assert "2m 13s" in html


def test_trigger_source_in_email():
    html = _build_email(trigger_source="schedule")
    assert "Trigger" in html
    assert "schedule" in html


def test_view_full_run_button_label():
    """The CTA button must say 'View full run', not 'View run'."""
    html = _build_email()
    assert "View full run" in html


# ---------------------------------------------------------------------------
# _send_email_notification — text body includes summary
# ---------------------------------------------------------------------------

def test_text_body_includes_summary(monkeypatch):
    """When output_summary is provided, the plain-text body includes it."""
    m = _mod()
    captured = {}

    class _FakeResend:
        api_key = None

        class Emails:
            @staticmethod
            def send(payload):
                captured["payload"] = payload

    monkeypatch.setenv("RESEND_API_KEY", "test_key")
    monkeypatch.setenv("WORKERS_FRONTEND_URL", "https://example.com")

    import unittest.mock as mock
    with mock.patch.dict("sys.modules", {"resend": _FakeResend}):
        m._send_email_notification(
            to_addrs=["user@example.com"],
            worker_name="Demo",
            run_id="run_1",
            worker_id="wk_1",
            status="completed",
            error=None,
            output_summary="Summary of results.",
            duration_ms=45_000,
            trigger_source="schedule",
        )

    text = captured["payload"]["text"]
    assert "Summary of results." in text
    assert "Duration: 45s" in text
    assert "Trigger: schedule" in text


def test_send_email_prefers_workeros_email_from(monkeypatch):
    """WORKEROS_EMAIL_FROM is the cloud sender source of truth."""
    m = _mod()
    captured = {}

    class _FakeResend:
        api_key = None

        class Emails:
            @staticmethod
            def send(payload):
                captured["payload"] = payload

    monkeypatch.setenv("RESEND_API_KEY", "test_key")
    monkeypatch.setenv("WORKEROS_EMAIL_FROM", "Floom <noreply@auth.floom.dev>")
    monkeypatch.setenv("NOTIFY_FROM_EMAIL", "Floom <old@example.com>")

    import unittest.mock as mock
    with mock.patch.dict("sys.modules", {"resend": _FakeResend}):
        m._send_email_notification(
            to_addrs=["user@example.com"],
            worker_name="Demo",
            run_id="run_1",
            worker_id="wk_1",
            status="completed",
            error=None,
        )

    assert captured["payload"]["from"] == "Floom <noreply@auth.floom.dev>"


def test_send_email_pending_approval_uses_review_cta(monkeypatch):
    """Pending approval emails carry the approval review URL, not only the run URL."""
    m = _mod()
    captured = {}

    class _FakeResend:
        api_key = None

        class Emails:
            @staticmethod
            def send(payload):
                captured["payload"] = payload

    monkeypatch.setenv("RESEND_API_KEY", "test_key")

    import unittest.mock as mock
    with mock.patch.dict("sys.modules", {"resend": _FakeResend}):
        m._send_email_notification(
            to_addrs=["reviewer@example.com"],
            worker_name="Proposal Worker",
            run_id="run_approval",
            worker_id="wk_approval",
            status="pending_approval",
            error=None,
            approval_url="https://floom.dev/app/approvals/review?id=apr_1&token=t",
            approval_label="Review proposal",
        )

    payload = captured["payload"]
    assert payload["subject"] == "Approval needed: Proposal Worker"
    assert "Review approval" in payload["html"]
    assert "https://floom.dev/app/approvals/review?id=apr_1&amp;token=t" in payload["html"]
    assert "Approval: Review proposal" in payload["text"]
    assert "https://floom.dev/app/approvals/review?id=apr_1&token=t" in payload["text"]


def test_text_body_truncates_long_summary(monkeypatch):
    """Plain-text body truncates summary at 1000 chars and appends suffix."""
    m = _mod()
    captured = {}

    class _FakeResend:
        api_key = None

        class Emails:
            @staticmethod
            def send(payload):
                captured["payload"] = payload

    monkeypatch.setenv("RESEND_API_KEY", "test_key")

    import unittest.mock as mock
    with mock.patch.dict("sys.modules", {"resend": _FakeResend}):
        m._send_email_notification(
            to_addrs=["user@example.com"],
            worker_name="Demo",
            run_id="run_1",
            worker_id="wk_1",
            status="completed",
            error=None,
            output_summary="z" * 1500,
        )

    text = captured["payload"]["text"]
    assert "z" * 1000 in text
    assert "z" * 1001 not in text
    assert "… (view full run)" in text
