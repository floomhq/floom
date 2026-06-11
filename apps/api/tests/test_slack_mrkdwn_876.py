"""#876 — convert CommonMark to Slack mrkdwn so Emily doesn't emit raw
**bold** / # headers in Slack.

Run: cd apps/api && python -m pytest tests/test_slack_mrkdwn_876.py -q
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


@pytest.fixture(scope="module")
def conv():
    slack = importlib.import_module("channels.slack")
    return slack.markdown_to_slack_mrkdwn


def test_bold_double_asterisk(conv):
    assert conv("This is **bold** text") == "This is *bold* text"


def test_bold_underscore(conv):
    assert conv("This is __bold__ text") == "This is *bold* text"


def test_headers_become_bold(conv):
    assert conv("# Summary\nbody") == "*Summary*\nbody"
    assert conv("### Sub heading") == "*Sub heading*"


def test_links(conv):
    assert conv("see [the docs](https://example.com/x)") == "see <https://example.com/x|the docs>"


def test_code_block_untouched(conv):
    src = "before\n```\n# not a heading\n**not bold**\n```\nafter **bold**"
    out = conv(src)
    assert "# not a heading" in out  # inside fence, unchanged
    assert "**not bold**" in out
    assert "after *bold*" in out  # outside fence, converted


def test_plain_text_and_bullets_unchanged(conv):
    src = "- item one\n- item two\nplain line"
    assert conv(src) == src


def test_empty(conv):
    assert conv("") == ""
