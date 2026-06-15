"""#1184 — Rate-limit keys must include per-secret and per-session dimensions.

Previously _rate_caller_keys returned only [f"ip:{ip}:{path}"], which means:
- Behind NAT, one user exhausts the bucket for all others on the same IP.
- An attacker with many IPs can bypass the limit entirely.

Fix: add secret-hash and session-hash keys.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))


def _make_request(secret: str = "", session: str = "", bearer: str = "", ip: str = "1.2.3.4"):
    """Build a minimal mock Request for _rate_caller_keys."""
    headers = []
    if secret:
        headers.append((b"x-floom-secret", secret.encode()))
    if session:
        headers.append((b"cookie", f"wos_session={session}".encode()))
    if bearer:
        headers.append((b"authorization", f"Bearer {bearer}".encode()))
    req = MagicMock()
    req.url.path = "/workers"
    req.scope = {"headers": headers}
    # mock _client_ip
    return req, ip


def test_rate_keys_include_secret():
    for m in list(sys.modules):
        if m in ("main",):
            sys.modules.pop(m, None)
    import main as m_mod

    # Patch _client_ip
    original = m_mod._client_ip
    m_mod._client_ip = lambda r: "1.2.3.4"
    try:
        req = MagicMock()
        req.url.path = "/workers"
        req.scope = {"headers": [(b"x-floom-secret", b"mysecret123")]}
        keys = m_mod._rate_caller_keys(req, "/workers")
        assert any(k.startswith("secret:") for k in keys), (
            f"#1184: no secret: key in rate keys: {keys}"
        )
        assert any(k.startswith("ip:") for k in keys), f"ip: key missing: {keys}"
    finally:
        m_mod._client_ip = original


def test_rate_keys_include_session():
    for m in list(sys.modules):
        if m in ("main",):
            sys.modules.pop(m, None)
    import main as m_mod

    m_mod._client_ip = lambda r: "1.2.3.4"
    try:
        req = MagicMock()
        req.url.path = "/workers"
        req.scope = {"headers": [(b"cookie", b"wos_session=abc123token")]}
        keys = m_mod._rate_caller_keys(req, "/workers")
        assert any(k.startswith("session:") for k in keys), (
            f"#1184: no session: key in rate keys: {keys}"
        )
    finally:
        del m_mod._client_ip


def test_rate_keys_ip_only_when_no_auth():
    for m in list(sys.modules):
        if m in ("main",):
            sys.modules.pop(m, None)
    import main as m_mod

    m_mod._client_ip = lambda r: "1.2.3.4"
    try:
        req = MagicMock()
        req.url.path = "/workers"
        req.scope = {"headers": []}
        keys = m_mod._rate_caller_keys(req, "/workers")
        assert keys == ["ip:1.2.3.4:/workers"], f"Expected only ip key, got: {keys}"
    finally:
        del m_mod._client_ip
