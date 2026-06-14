"""Preview/log redaction primitives for the chat tool-card pipeline.

Pure helpers extracted verbatim from chat_service.py: the secret/token regexes,
the streaming text sanitizer, and arg-key sensitivity classification. These have
no chat_service dependency; chat_service re-imports these names for backward
compatibility, so every existing ``from chat_service import ...`` keeps working.
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List

_SENSITIVE_ARG_KEY_RE = re.compile(
    r"(?:^|_)(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|bearer|credential|client[_-]?secret|refresh[_-]?token)(?:$|_)",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
_TOKEN_LIKE_RE = re.compile(r"\b(?:sk|pat|ghp|glpat|xox[baprs])[-_A-Za-z0-9]{12,}\b")
_SECRET_QUERY_RE = re.compile(
    r"([?&](?:token|key|secret|signature|sig|code)=)([^&\s]+)",
    re.IGNORECASE,
)
_SECRET_QUERY_PREFIX_RE = re.compile(
    r"([?&](?:token|key|secret|signature|sig|code)=)$",
    re.IGNORECASE,
)
_SECRET_QUERY_VALUE_DELIMITERS = frozenset('& \t\r\n"\'<>)]}')


def _safe_json_dumps(value: Any) -> str:
    return json.dumps(value, default=str, sort_keys=True)


def _redacted_marker(reason: str, value: Any = None) -> Dict[str, Any]:
    marker: Dict[str, Any] = {"redacted": True, "reason": reason}
    try:
        marker["bytes"] = len(str(value).encode("utf-8")) if value is not None else 0
    except Exception:
        pass
    return marker


def _looks_sensitive_string(value: str) -> bool:
    return bool(_BEARER_RE.search(value) or _TOKEN_LIKE_RE.search(value))


def _sanitize_preview_text(value: str) -> str:
    return _SECRET_QUERY_RE.sub(r"\1[redacted]", value)


class _StreamingTextSanitizer:
    """Redact sensitive query values without trusting SSE delta boundaries."""

    _TAIL_LENGTH = 24

    def __init__(self) -> None:
        self._pending = ""
        self._sensitive_prefix = ""
        self._redacting_value = False

    def feed(self, value: str) -> str:
        output: List[str] = []

        for char in str(value or ""):
            if self._redacting_value:
                if char not in _SECRET_QUERY_VALUE_DELIMITERS:
                    continue
                self._redacting_value = False

            if self._sensitive_prefix:
                if char in _SECRET_QUERY_VALUE_DELIMITERS:
                    output.append(self._sensitive_prefix)
                    self._sensitive_prefix = ""
                else:
                    output.append(f"{self._sensitive_prefix}[redacted]")
                    self._sensitive_prefix = ""
                    self._redacting_value = True
                    continue

            self._pending += char
            prefix_match = _SECRET_QUERY_PREFIX_RE.search(self._pending)
            if prefix_match:
                prefix_start = prefix_match.start(1)
                output.append(_sanitize_preview_text(self._pending[:prefix_start]))
                self._sensitive_prefix = prefix_match.group(1)
                self._pending = ""
                continue

            if len(self._pending) > self._TAIL_LENGTH:
                flush_length = len(self._pending) - self._TAIL_LENGTH
                output.append(_sanitize_preview_text(self._pending[:flush_length]))
                self._pending = self._pending[flush_length:]

        return "".join(output)

    def flush(self) -> str:
        output = ""
        if self._sensitive_prefix:
            output = self._sensitive_prefix
        if not self._redacting_value:
            output += _sanitize_preview_text(self._pending)
        self._pending = ""
        self._sensitive_prefix = ""
        self._redacting_value = False
        return output


def _arg_key_tokens(key: str) -> str:
    snake = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key or ""))
    snake = re.sub(r"[^A-Za-z0-9]+", "_", snake)
    return snake.strip("_").lower()


def _is_sensitive_arg_key(key: str) -> bool:
    tokens = _arg_key_tokens(key)
    if _SENSITIVE_ARG_KEY_RE.search(tokens):
        return True
    compact = tokens.replace("_", "")
    return any(
        marker in compact
        for marker in (
            "accesstoken",
            "refreshtoken",
            "bearertoken",
            "sessiontoken",
            "apikey",
            "clientsecret",
            "privatekey",
            "authorization",
            "credential",
            "password",
        )
    )
