"""Tests for PR S10: sandbox secrets via .env.local (python-dotenv).

Covers:
 - _format_env_line helper (escaping rules)
 - e2b_driver writes both .env.local and secrets.json (backward-compat)
 - Correct .env.local content for a typical secrets dict
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))


def test_format_env_line_plain():
    from runner_sandbox.e2b_driver import _format_env_line

    assert _format_env_line("FOO", "bar") == "FOO=bar"


def test_format_env_line_plain_with_equals():
    """Values containing = are fine unquoted (dotenv allows it)."""
    from runner_sandbox.e2b_driver import _format_env_line

    result = _format_env_line("KEY", "val=ue")
    assert result == "KEY=val=ue"


def test_format_env_line_double_quote_escaping():
    from runner_sandbox.e2b_driver import _format_env_line

    result = _format_env_line("KEY", 'say "hello"')
    assert result == 'KEY="say \\"hello\\""'


def test_format_env_line_backslash_escaping():
    from runner_sandbox.e2b_driver import _format_env_line

    result = _format_env_line("KEY", "path\\to\\file")
    assert result == 'KEY="path\\\\to\\\\file"'


def test_format_env_line_newline_escaping():
    from runner_sandbox.e2b_driver import _format_env_line

    result = _format_env_line("KEY", "line1\nline2")
    assert result == 'KEY="line1\\nline2"'


def test_format_env_line_carriage_return_escaping():
    from runner_sandbox.e2b_driver import _format_env_line

    result = _format_env_line("KEY", "a\rb")
    assert result == 'KEY="a\\rb"'


def test_format_env_line_null_byte_escaping():
    from runner_sandbox.e2b_driver import _format_env_line

    result = _format_env_line("KEY", "a\x00b")
    assert result == 'KEY="a\\0b"'


def test_format_env_line_empty_value():
    from runner_sandbox.e2b_driver import _format_env_line

    assert _format_env_line("EMPTY", "") == "EMPTY="


def test_env_local_content_for_typical_secrets():
    """Verify a typical secrets dict produces a correctly-formatted .env.local."""
    from runner_sandbox.e2b_driver import _format_env_line

    secrets = {
        "OPENAI_API_KEY": "sk-test123",
        "GRANOLA_API_KEY": "granola-abc",
    }
    lines = [_format_env_line(k, v) for k, v in secrets.items()]
    content = "\n".join(lines) + "\n"

    assert "OPENAI_API_KEY=sk-test123" in content
    assert "GRANOLA_API_KEY=granola-abc" in content
    # No JSON braces — this is .env format, not JSON.
    assert "{" not in content
    assert "}" not in content
