"""Optional Composio connections must not be treated as REQUIRED by the
run-preflight/serialize path (worker_access._worker_connection_slugs) nor by
the scheduler gate (scheduler._missing_connections_for_scheduled_worker).

Regression guard for the Gmail-OR-Outlook worker: declaring both mailboxes
optional means connecting one is enough; neither may block a run.
"""
from services.worker_access import _worker_connection_slugs


def _worker(connections):
    return {"config": {"connections": connections}}


def test_optional_shorthand_excluded_from_required_slugs():
    w = _worker([
        {"app": "gmail", "optional": True, "allowed_tools": ["GMAIL_SEND_EMAIL"]},
        {"app": "outlook", "optional": True, "allowed_tools": ["OUTLOOK_OUTLOOK_SEND_EMAIL"]},
    ])
    assert _worker_connection_slugs(w) == []


def test_required_default_still_listed():
    w = _worker([
        {"app": "gmail", "allowed_tools": ["GMAIL_SEND_EMAIL"]},
        {"app": "slack", "optional": True},
    ])
    # gmail (default required) listed; slack (optional) excluded
    assert _worker_connection_slugs(w) == ["gmail"]


def test_optional_nested_composio_excluded():
    w = _worker([
        {"composio": {"app": "gmail", "optional": True}},
    ])
    assert _worker_connection_slugs(w) == []


def test_string_shorthand_never_optional():
    w = _worker(["github"])
    assert _worker_connection_slugs(w) == ["github"]
