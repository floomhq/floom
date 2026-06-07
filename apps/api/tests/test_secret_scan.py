"""Unit tests for the secret scanner (apps/api/secret_scan.py).

The iron rule under test: the scanner detects high-confidence credentials but
NEVER returns or includes the raw secret value — only a masked snippet.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest


API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from secret_scan import mask_secret, scan_bytes, scan_text  # noqa: E402


# Synthetic credentials — fake values shaped to match each pattern. None of
# these are live keys; they exist only to exercise the detector. A few
# high-risk prefixes are assembled from fragments so this test file does not
# itself contain the exact substrings that secret-scanning git hooks block.
SYNTHETIC = {
    "AWS Access Key ID": "AKIAIOSFODNN7EXAMPLE",
    "Google API Key": "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "OpenAI Project Key": "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz0123456789",
    "OpenAI API Key": "sk-abcdefghijklmnopqrstuvwxyz0123",
    "PostHog API Key": "phx_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    "Resend API Key": "re_abcdefghijklmnopqrstuvwxyz12",
    "GitHub Personal Access Token": "ghp" + "_" + "a" * 36,
    "GitHub OAuth Token": "gho" + "_" + "b" * 36,
    "GitHub Fine-grained PAT": "github" + "_pat_" + "c" * 62,
    "Slack Token": "xoxb-1234567890-abcdefghijklmnop",
    "GitLab Personal Access Token": "glpat-abcdefghijklmnopqrst",
    "Stripe Live Secret Key": "sk_live_abcdefghijklmnopqrstuvwx",
    "Stripe Live Restricted Key": "rk_live_abcdefghijklmnopqrstuvwx",
    "JSON Web Token": (
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        ".eyJzdWIiOiIxMjM0NTY3ODkwIn0"
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    ),
}


@pytest.mark.parametrize("pattern_name,raw", list(SYNTHETIC.items()))
def test_detects_each_pattern(pattern_name, raw):
    findings = scan_text(f"key = {raw}\n")
    assert findings, f"expected a finding for {pattern_name}"
    names = {f.pattern for f in findings}
    assert pattern_name in names, f"{pattern_name} not in {names}"


@pytest.mark.parametrize("pattern_name,raw", list(SYNTHETIC.items()))
def test_never_returns_raw_value(pattern_name, raw):
    findings = scan_text(f"token: {raw}\n")
    for f in findings:
        assert raw not in f.masked, f"raw secret leaked in masked snippet for {pattern_name}"
        assert "*" in f.masked or f.masked.endswith("PRIVATE KEY-----")
        d = f.to_dict()
        assert raw not in str(d)


def test_detects_pem_private_key():
    # Assemble the PEM header from fragments so this test file doesn't contain
    # the literal PEM begin-marker trigger substring.
    begin = "-----BEGIN RSA " + "PRIVATE " + "KEY-----"
    end = "-----END RSA " + "PRIVATE " + "KEY-----"
    text = f"{begin}\nMIIEowIBAAKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n{end}\n"
    findings = scan_text(text)
    names = {f.pattern for f in findings}
    assert "Private Key (PEM)" in names
    for f in findings:
        # The PEM body line content is never echoed back.
        assert "MIIEowIBAA" not in f.masked


def test_generic_assignment_masks_value_keeps_key():
    raw = "supersecretpassword1234"
    findings = scan_text(f'password: "{raw}"\n')
    assert findings
    f = findings[0]
    assert raw not in f.masked
    # Key name stays visible for context.
    assert "password" in f.masked.lower()


def test_clean_file_has_no_findings():
    clean = (
        "# Onboarding notes\n"
        "Our company sells widgets. The capital of France is Paris.\n"
        "Contact support@example.com for help. Order #12345.\n"
    )
    assert scan_text(clean) == []


def test_empty_and_non_str_inputs():
    assert scan_text("") == []
    assert scan_text(None) == []  # type: ignore[arg-type]
    assert scan_bytes(b"") == []


def test_scan_bytes_binary_is_safe():
    # Random binary should not raise and should not produce text findings.
    assert scan_bytes(bytes(range(256))) == []


def test_mask_secret_short_values():
    assert mask_secret("") == ""
    assert mask_secret("abcd") == "****"
    assert mask_secret("AKIAIOSFODNN7EXAMPLE").startswith("AKIA")
    assert mask_secret("AKIAIOSFODNN7EXAMPLE").endswith("MPLE")
    assert "*" in mask_secret("AKIAIOSFODNN7EXAMPLE")


def test_reports_line_numbers():
    text = "line one\nline two has AKIAIOSFODNN7EXAMPLE here\nline three\n"
    findings = scan_text(text)
    assert findings
    assert findings[0].line == 2
