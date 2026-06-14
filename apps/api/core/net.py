"""Client-IP resolution with trusted-proxy handling.

Extracted from main.py. Resolves the real client IP for rate limiting and audit,
honouring Cloudflare / X-Forwarded-For headers ONLY when the immediate peer is a
configured trusted proxy (env: trusted_proxies / TRUSTED_PROXIES /
WORKEROS_TRUSTED_PROXIES). Pure functions over the request + env; no app state.
"""

from __future__ import annotations

import ipaddress
import logging
import os

from fastapi import Request

logger = logging.getLogger("floom.api")

try:
    from slowapi.util import get_remote_address as _slowapi_get_remote_address
except Exception:  # pragma: no cover - fallback only used when dependency is absent locally
    _slowapi_get_remote_address = None


def _client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    if _trusted_proxy_peer(peer):
        cf_connecting_ip = (request.headers.get("cf-connecting-ip") or "").strip()
        if _valid_ip_literal(cf_connecting_ip):
            return cf_connecting_ip

        forwarded_for = (request.headers.get("x-forwarded-for") or "").split(",", 1)[0].strip()
        if _valid_ip_literal(forwarded_for):
            return forwarded_for

    if _slowapi_get_remote_address is not None:
        return _slowapi_get_remote_address(request) or peer or "unknown"
    return peer or "unknown"


def _trusted_proxy_peer(peer: str) -> bool:
    configured = (
        os.environ.get("trusted_proxies")
        or os.environ.get("TRUSTED_PROXIES")
        or os.environ.get("WORKEROS_TRUSTED_PROXIES")
        or ""
    )
    entries = [entry.strip() for entry in configured.split(",") if entry.strip()]
    # #1042 — a "*" wildcard trusted every peer, letting any client spoof
    # x-forwarded-for / cf-connecting-ip and bypass IP rate limits. Drop it and
    # require explicit IPs/CIDRs; if only wildcards were configured, fall back
    # to the localhost-only default rather than trusting everyone.
    if "*" in entries:
        logger.warning(
            "TRUSTED_PROXIES contains '*' which is insecure and is ignored; "
            "configure explicit IPs/CIDRs instead."
        )
        entries = [entry for entry in entries if entry != "*"]
    if not entries:
        return peer in {"testclient", "127.0.0.1", "::1", "localhost"}
    if peer in entries:
        return True
    try:
        peer_ip = ipaddress.ip_address(peer)
    except ValueError:
        return False
    for entry in entries:
        try:
            if "/" in entry and peer_ip in ipaddress.ip_network(entry, strict=False):
                return True
            if "/" not in entry and peer_ip == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


def _valid_ip_literal(value: str) -> bool:
    if not value:
        return False
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False
