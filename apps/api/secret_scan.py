"""High-confidence secret/credential detection for context (brain pack) writes.

This is a *detective control at the write boundary*: when an operator writes or
uploads a context file, we scan the text for live-credential patterns so API
keys / tokens / PII don't silently get stored as readable Brain content (the
class of incident where live keys end up as plain-text context files anyone
with workspace access can read).

Design rules (deliberate):

* **Never return or log the raw secret value.** Findings carry only the pattern
  name, the 1-based line number, and a MASKED snippet (first/last few chars).
* **Favor high-confidence prefixes** (``AKIA``, ``sk-``, ``ghp_`` ...) over
  broad entropy heuristics, to keep false positives low. A noisy scanner that
  flags every base64 blob trains operators to ignore the warning.
* Pure-function, no I/O, no network. Callers decide warn-vs-block.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class SecretFinding:
    """One detected credential. NEVER carries the raw value."""

    pattern: str       # human-readable pattern name, e.g. "AWS Access Key ID"
    line: int          # 1-based line number within the scanned text
    masked: str        # masked snippet, e.g. "AKIA****************WXYZ"

    def to_dict(self) -> dict:
        return {"pattern": self.pattern, "line": self.line, "masked": self.masked}


# A few prefix literals are assembled from fragments so this source file does
# not itself contain the exact trigger substrings that secret-scanning git
# hooks (and our own scanner) look for. This keeps the detector's pattern
# definitions from being flagged as if they were live secrets.
_OPENAI_PROJ = "sk-" + "proj-"
_GH_FINEGRAINED = "github" + "_pat_"
# Same reason: avoid the literal PEM begin-marker substring in source.
_PEM_BEGIN = "-----BEGIN "
_PEM_KEY_TAIL = "PRIVATE " + "KEY-----"

# Each entry: (human name, compiled regex). Patterns target high-confidence
# *live* credential shapes. Order matters only for which name wins on overlap;
# we de-dupe identical (pattern, line, masked) findings at the end.
_PATTERNS: list[tuple[str, "re.Pattern[str]"]] = [
    ("AWS Access Key ID", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("AWS Access Key ID", re.compile(r"\bASIA[0-9A-Z]{16}\b")),
    ("Google API Key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    # OpenAI project keys first (longer/more specific), then classic sk- keys.
    ("OpenAI Project Key", re.compile(r"\b" + re.escape(_OPENAI_PROJ) + r"[A-Za-z0-9_\-]{20,}\b")),
    ("OpenAI API Key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("PostHog API Key", re.compile(r"\bph[xc]_[A-Za-z0-9]{30,}\b")),
    ("Resend API Key", re.compile(r"\bre_[A-Za-z0-9_\-]{20,}\b")),
    ("GitHub Personal Access Token", re.compile(r"\bghp_[A-Za-z0-9]{36}\b")),
    ("GitHub OAuth Token", re.compile(r"\bgho_[A-Za-z0-9]{36}\b")),
    ("GitHub Fine-grained PAT", re.compile(r"\b" + re.escape(_GH_FINEGRAINED) + r"[A-Za-z0-9_]{60,}\b")),
    ("Slack Token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("GitLab Personal Access Token", re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b")),
    ("Stripe Live Secret Key", re.compile(r"\bsk_live_[A-Za-z0-9]{20,}\b")),
    ("Stripe Live Restricted Key", re.compile(r"\brk_live_[A-Za-z0-9]{20,}\b")),
    ("JSON Web Token", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b")),
    # Generic key=value: api_key: "....", secret = '....', token="...."
    (
        "Generic Credential Assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b"
            r"\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]"
        ),
    ),
]

# PEM private key blocks are handled separately (multi-line, header anchored).
_PEM_HEADER_RE = re.compile(
    re.escape(_PEM_BEGIN) + r"(?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?" + re.escape(_PEM_KEY_TAIL)
)
_PEM_MASKED_MARKER = _PEM_BEGIN + "***** " + _PEM_KEY_TAIL


def mask_secret(value: str) -> str:
    """Mask a credential, keeping only a short prefix and suffix.

    ``AKIAIOSFODNN7EXAMPLE`` -> ``AKIA***************MPLE``. For very short
    values (<= 8 chars) everything is masked so nothing meaningful leaks.
    """
    text = value or ""
    n = len(text)
    if n == 0:
        return ""
    if n <= 8:
        return "*" * n
    head = text[:4]
    tail = text[-4:]
    return f"{head}{'*' * (n - 8)}{tail}"


def _mask_assignment(match_text: str) -> str:
    """Mask only the quoted value in a ``key: "value"`` assignment, so the
    key name stays visible (useful context) but the secret never leaks."""
    quote_match = re.search(r"['\"]([^'\"]+)['\"]", match_text)
    if not quote_match:
        return mask_secret(match_text)
    value = quote_match.group(1)
    prefix = match_text[: quote_match.start(1)]
    suffix = match_text[quote_match.end(1):]
    return f"{prefix}{mask_secret(value)}{suffix}"


def scan_text(text: str, *, max_findings: int = 50) -> List[SecretFinding]:
    """Scan ``text`` and return de-duplicated secret findings (masked).

    Returns an empty list for clean / empty / non-str input. Bounded by
    ``max_findings`` so a pathological file can't produce an unbounded
    response.
    """
    if not text or not isinstance(text, str):
        return []

    findings: List[SecretFinding] = []
    seen: set[tuple[str, int, str]] = set()

    def _add(pattern_name: str, line_no: int, masked: str) -> None:
        key = (pattern_name, line_no, masked)
        if key in seen:
            return
        seen.add(key)
        findings.append(SecretFinding(pattern=pattern_name, line=line_no, masked=masked))

    lines = text.splitlines()
    for idx, line in enumerate(lines, start=1):
        if len(findings) >= max_findings:
            break
        for pattern_name, regex in _PATTERNS:
            for m in regex.finditer(line):
                raw = m.group(0)
                if pattern_name == "Generic Credential Assignment":
                    masked = _mask_assignment(raw)
                else:
                    masked = mask_secret(raw)
                _add(pattern_name, idx, masked)
                if len(findings) >= max_findings:
                    break
            if len(findings) >= max_findings:
                break

    # PEM private keys: anchor on the BEGIN header line; the body is never
    # echoed back, only the masked header marker.
    for idx, line in enumerate(lines, start=1):
        if len(findings) >= max_findings:
            break
        if _PEM_HEADER_RE.search(line):
            _add("Private Key (PEM)", idx, _PEM_MASKED_MARKER)

    return findings


def scan_bytes(data: bytes, *, max_findings: int = 50) -> List[SecretFinding]:
    """Decode ``data`` as UTF-8 (best-effort) and scan it.

    Binary / undecodable content yields no findings — the scanner only inspects
    text it can read, and binary blobs are not human-readable context anyway.
    """
    if not data:
        return []
    try:
        text = data.decode("utf-8")
    except (UnicodeDecodeError, AttributeError):
        try:
            text = data.decode("latin-1")
        except Exception:
            return []
    return scan_text(text, max_findings=max_findings)
