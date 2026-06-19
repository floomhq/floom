"""#1042 — TRUSTED_PROXIES='*' trusted any peer, letting clients spoof
x-forwarded-for / cf-connecting-ip and bypass IP rate limits.

Fix: a '*' entry is ignored (with a warning); explicit IPs/CIDRs still work,
and a wildcard-only config falls back to the localhost-only default.

_trusted_proxy_peer reads the env at call time, so each test just sets the env
and calls the helper — no module reload needed.
"""
from __future__ import annotations

import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import main


def _clear_proxy_env(monkeypatch):
    for key in ("trusted_proxies", "TRUSTED_PROXIES", "WORKEROS_TRUSTED_PROXIES"):
        monkeypatch.delenv(key, raising=False)


def test_wildcard_alone_does_not_trust_arbitrary_peer(monkeypatch):
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRUSTED_PROXIES", "*")
    assert main._trusted_proxy_peer("203.0.113.7") is False
    # localhost default still applies after the wildcard is dropped
    assert main._trusted_proxy_peer("127.0.0.1") is True


def test_wildcard_mixed_with_cidr_ignores_wildcard_keeps_cidr(monkeypatch):
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRUSTED_PROXIES", "*,10.0.0.0/8")
    assert main._trusted_proxy_peer("10.1.2.3") is True
    assert main._trusted_proxy_peer("203.0.113.7") is False


def test_explicit_cidr_unchanged(monkeypatch):
    _clear_proxy_env(monkeypatch)
    monkeypatch.setenv("TRUSTED_PROXIES", "10.0.0.0/8,192.168.0.0/16,127.0.0.1")
    assert main._trusted_proxy_peer("10.9.9.9") is True
    assert main._trusted_proxy_peer("192.168.5.5") is True
    assert main._trusted_proxy_peer("172.16.0.1") is False


def test_no_config_defaults_to_localhost(monkeypatch):
    _clear_proxy_env(monkeypatch)
    assert main._trusted_proxy_peer("127.0.0.1") is True
    assert main._trusted_proxy_peer("::1") is True
    assert main._trusted_proxy_peer("203.0.113.7") is False
