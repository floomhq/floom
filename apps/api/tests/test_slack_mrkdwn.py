"""Tests for the Markdown -> Slack ``mrkdwn`` egress converter (issue #876).

Emily authors replies in standard Markdown; Slack renders ``mrkdwn`` only, so
users were seeing literal ``**`` and ``#`` characters.  ``markdown_to_mrkdwn``
is applied ONLY on the Slack egress path — never on WhatsApp or web replies.

Covers:
  * ``**bold**`` / ``__bold__`` -> ``*bold*``
  * ``# Header`` -> ``*Header*`` (bold line, leading ``#`` stripped)
  * ``[text](url)`` -> ``<url|text>``
  * inline ``code`` and ```` ``` ```` fences preserved (no conversion inside)
  * idempotency (running twice == running once)
  * plain text unchanged
  * bullets / blockquotes pass through
  * the Slack reply path calls the converter
  * the WhatsApp path does NOT call the converter
"""

from __future__ import annotations

from pathlib import Path

from channels.mrkdwn import markdown_to_mrkdwn


# ---------------------------------------------------------------------------
# Pure converter — bold
# ---------------------------------------------------------------------------

def test_double_asterisk_bold_becomes_single():
    assert markdown_to_mrkdwn("**bold**") == "*bold*"


def test_double_underscore_bold_becomes_single_asterisk():
    assert markdown_to_mrkdwn("__bold__") == "*bold*"


def test_bold_inline_within_sentence():
    assert (
        markdown_to_mrkdwn("This is **very** important")
        == "This is *very* important"
    )


def test_multiple_bold_runs_on_one_line():
    assert (
        markdown_to_mrkdwn("**one** and **two**")
        == "*one* and *two*"
    )


def test_existing_single_asterisk_bold_untouched():
    # Already valid Slack bold — must not be doubled or mangled.
    assert markdown_to_mrkdwn("*already bold*") == "*already bold*"


def test_numeric_multiplication_not_treated_as_bold():
    # ``2 * 3`` has spaces around single asterisks: not paired ** runs.
    assert markdown_to_mrkdwn("2 * 3 = 6") == "2 * 3 = 6"


def test_empty_double_asterisks_not_converted():
    assert markdown_to_mrkdwn("****") == "****"


# ---------------------------------------------------------------------------
# Pure converter — headers
# ---------------------------------------------------------------------------

def test_h1_header_becomes_bold_line():
    assert markdown_to_mrkdwn("# Title") == "*Title*"


def test_h2_header_becomes_bold_line():
    assert markdown_to_mrkdwn("## Subtitle") == "*Subtitle*"


def test_h3_header_becomes_bold_line():
    assert markdown_to_mrkdwn("### Section") == "*Section*"


def test_header_strips_trailing_hashes():
    assert markdown_to_mrkdwn("## Heading ##") == "*Heading*"


def test_header_in_multiline_block():
    src = "# Report\nSome body text\n## Details\nmore text"
    assert (
        markdown_to_mrkdwn(src)
        == "*Report*\nSome body text\n*Details*\nmore text"
    )


def test_hash_not_at_line_start_is_not_a_header():
    assert markdown_to_mrkdwn("issue #876 is fixed") == "issue #876 is fixed"


# ---------------------------------------------------------------------------
# Pure converter — links
# ---------------------------------------------------------------------------

def test_markdown_link_becomes_slack_link():
    assert (
        markdown_to_mrkdwn("[Workeros](https://workeros.com)")
        == "<https://workeros.com|Workeros>"
    )


def test_link_inside_sentence():
    assert (
        markdown_to_mrkdwn("See [the docs](https://x.io/docs) now")
        == "See <https://x.io/docs|the docs> now"
    )


def test_existing_slack_link_untouched():
    assert (
        markdown_to_mrkdwn("<https://x.io|x>")
        == "<https://x.io|x>"
    )


# ---------------------------------------------------------------------------
# Code fences and inline code are protected
# ---------------------------------------------------------------------------

def test_inline_code_contents_preserved():
    # The ** inside backticks must NOT be converted.
    assert (
        markdown_to_mrkdwn("use `**not bold**` here")
        == "use `**not bold**` here"
    )


def test_code_fence_contents_preserved():
    src = "Here:\n```\n**still markdown** and # not a header\n```\ndone"
    out = markdown_to_mrkdwn(src)
    assert "**still markdown**" in out
    assert "# not a header" in out
    assert out.endswith("done")


def test_code_fence_with_language_hint_preserved():
    src = "```python\nx = 2 ** 3  # **comment**\n```"
    assert markdown_to_mrkdwn(src) == src


def test_bold_outside_fence_still_converts():
    src = "**before**\n```\n**inside**\n```\n**after**"
    out = markdown_to_mrkdwn(src)
    assert out.startswith("*before*")
    assert out.endswith("*after*")
    assert "**inside**" in out


# ---------------------------------------------------------------------------
# Passthrough: bullets, blockquotes, plain text
# ---------------------------------------------------------------------------

def test_bullets_pass_through():
    src = "- one\n- two\n- three"
    assert markdown_to_mrkdwn(src) == src


def test_blockquote_passes_through():
    src = "> quoted line"
    assert markdown_to_mrkdwn(src) == src


def test_plain_text_unchanged():
    src = "Just a normal sentence with no markdown."
    assert markdown_to_mrkdwn(src) == src


def test_empty_string_unchanged():
    assert markdown_to_mrkdwn("") == ""


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

def test_idempotent_on_mixed_content():
    src = (
        "# Heading\n"
        "Here is **bold** and a [link](https://x.io).\n"
        "- a bullet with `**code**`\n"
        "```\n**fenced**\n```\n"
    )
    once = markdown_to_mrkdwn(src)
    twice = markdown_to_mrkdwn(once)
    assert once == twice


def test_idempotent_bold():
    once = markdown_to_mrkdwn("**x**")
    assert markdown_to_mrkdwn(once) == once == "*x*"


def test_idempotent_link():
    once = markdown_to_mrkdwn("[a](https://b.io)")
    assert markdown_to_mrkdwn(once) == once == "<https://b.io|a>"


# ---------------------------------------------------------------------------
# Combined realistic Emily reply
# ---------------------------------------------------------------------------

def test_realistic_emily_reply():
    src = (
        "## Your workers\n"
        "Here are the **3 workers** running:\n"
        "- Recruiter (last run: success)\n"
        "- Outbound (needs **attention**)\n"
        "See [the dashboard](https://workeros.com/dash) for details."
    )
    out = markdown_to_mrkdwn(src)
    assert "*Your workers*" in out
    assert "*3 workers*" in out
    assert "*attention*" in out
    assert "<https://workeros.com/dash|the dashboard>" in out
    assert "##" not in out
    assert "**" not in out


# ---------------------------------------------------------------------------
# Egress wiring: Slack reply path calls the converter; WhatsApp does NOT
# ---------------------------------------------------------------------------

def _read(rel: str) -> str:
    api_dir = Path(__file__).resolve().parents[1]
    return (api_dir / rel).read_text(encoding="utf-8")


def test_slack_module_imports_and_uses_converter():
    src = _read("channels/slack.py")
    assert "from channels.mrkdwn import markdown_to_mrkdwn" in src
    # The agent reply (DM thread reply) is converted before posting.
    assert "markdown_to_mrkdwn(reply)" in src


def test_whatsapp_module_does_not_use_converter():
    src = _read("channels/whatsapp.py")
    assert "markdown_to_mrkdwn" not in src
    assert "channels.mrkdwn" not in src
