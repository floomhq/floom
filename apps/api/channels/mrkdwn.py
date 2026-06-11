"""Markdown -> Slack ``mrkdwn`` egress converter.

Emily's agent replies are authored in standard Markdown (``**bold**``,
``# Heading``, ``[text](url)``).  Slack does NOT render standard Markdown in
message text — it uses its own ``mrkdwn`` flavor (``*bold*``, ``_italic_``, no
ATX headers, ``<url|text>`` links).  Without conversion, Slack users see literal
``**`` and ``#`` characters (issue #876).

``markdown_to_mrkdwn`` is a small, deterministic, pure function applied ONLY on
the Slack egress path (right before the bot posts a reply).  WhatsApp and web
replies are NOT touched — WhatsApp already uses ``*bold*`` / ``_italic_`` and
plain text, and the web client renders real Markdown.

Design guarantees:
  * Code fences (```` ``` ````) and inline code (`` `code` ``) are protected —
    their contents are never rewritten.  Slack supports both natively.
  * Idempotent: running the output through the function again yields the same
    result (already-valid ``*bold*`` / ``<url|text>`` are left untouched).
  * Bullets (``- item``) and blockquotes (``> quote``) pass through unchanged —
    Slack renders both.
"""

from __future__ import annotations

import re

__all__ = ["markdown_to_mrkdwn"]


# ``[text](url)`` -> ``<url|text>``.  ``text`` is non-greedy and forbids a
# nested closing bracket; ``url`` forbids whitespace and the closing paren.
_LINK_RE = re.compile(r"\[([^\]]*?)\]\((\S+?)\)")

# Paired ``**bold**`` (or ``__bold__``) runs -> ``*bold*``.  Non-greedy inner
# capture, must contain at least one non-asterisk/underscore char so empty
# ``****`` and stray ``**`` are not matched.  This deliberately does NOT touch
# single-asterisk runs (already Slack bold) or numeric expressions like ``2 * 3``.
_BOLD_STAR_RE = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", re.DOTALL)
_BOLD_USCORE_RE = re.compile(r"__(?=\S)(.+?)(?<=\S)__", re.DOTALL)

# ATX header at line start: 1-6 ``#`` then space(s) then text.
_HEADER_RE = re.compile(r"^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$")


def _convert_links(text: str) -> str:
    return _LINK_RE.sub(lambda m: f"<{m.group(2)}|{m.group(1)}>", text)


def _convert_bold(text: str) -> str:
    text = _BOLD_STAR_RE.sub(lambda m: f"*{m.group(1)}*", text)
    text = _BOLD_USCORE_RE.sub(lambda m: f"*{m.group(1)}*", text)
    return text


def _convert_header_line(line: str) -> str:
    m = _HEADER_RE.match(line)
    if not m:
        return line
    heading = m.group(1).strip()
    if not heading:
        return line
    return f"*{heading}*"


def markdown_to_mrkdwn(text: str) -> str:
    """Convert standard Markdown to Slack ``mrkdwn``.

    Rules:
      * ``**bold**`` / ``__bold__`` -> ``*bold*``
      * ``# H1`` .. ``###### H6`` at line start -> ``*Heading*`` (bold line)
      * ``[text](url)`` -> ``<url|text>``
      * Bullets, inline code, code fences, blockquotes: unchanged
      * Code-fence / inline-code contents are never rewritten
      * Idempotent

    Returns ``text`` unchanged when it is empty/None-ish.
    """
    if not text:
        return text

    # Split on triple-backtick fences so fence *contents* are never rewritten.
    # ``re.split`` with a capture group keeps the delimiters; even indices are
    # outside-fence segments, odd indices are the fenced blocks themselves.
    fence_parts = re.split(r"(```.*?```)", text, flags=re.DOTALL)

    out_segments: list[str] = []
    for idx, segment in enumerate(fence_parts):
        if idx % 2 == 1:
            # Fenced code block — leave entirely untouched.
            out_segments.append(segment)
            continue
        out_segments.append(_convert_segment(segment))

    return "".join(out_segments)


def _convert_segment(segment: str) -> str:
    """Convert a non-fenced segment, protecting inline-code spans."""
    if not segment:
        return segment

    # Protect inline ``code`` spans the same way: odd indices are inline-code.
    inline_parts = re.split(r"(`[^`\n]+`)", segment)

    converted: list[str] = []
    for idx, part in enumerate(inline_parts):
        if idx % 2 == 1:
            # Inline code span — leave untouched.
            converted.append(part)
            continue

        # Links first (so a URL containing ** is not mangled by bold), then
        # bold, then per-line headers.
        part = _convert_links(part)
        part = _convert_bold(part)
        lines = part.split("\n")
        part = "\n".join(_convert_header_line(line) for line in lines)
        converted.append(part)

    return "".join(converted)
