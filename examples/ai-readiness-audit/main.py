#!/usr/bin/env python3
"""
AI Readiness Audit — Floom demo app.

Reads one JSON payload from argv[1]:
  {
    "action": "audit",
    "inputs": {
      "company_url": "https://floom.dev"
    }
  }

Emits one JSON object on stdout:
  {
    "company_url": "https://floom.dev/",
    "readiness_score": 8,
    "score_rationale": "...",
    "risks": ["...", "...", "..."],
    "opportunities": ["...", "...", "..."],
    "next_action": "...",
    "dry_run": false,
    "cache_hit": false,
    "model": "gemini-3-pro"
  }

Floom runner contract:
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

Security and runtime constraints:
  - exactly one input (`company_url`) is accepted
  - HTTPS only
  - private / loopback / reserved IPs are rejected before fetch
  - fetch timeout is 5s, body is capped at 500KB
  - full audit is bounded to 10s wall-clock

If GEMINI_API_KEY is unset, the app still fetches and extracts the page but
returns a deterministic stub so the UI remains demoable offline.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import sys
import time
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunsplit

import httpx
from bs4 import BeautifulSoup

DEFAULT_MODEL_ID = "gemini-2.5-flash-lite"
# Benchmarked 2026-04-25: 2.5-flash-lite + JSON schema returns in 1-2s,
# well inside an 8s wall-clock. Page fetch adds 1-2s.
HARD_TIMEOUT_S = 8.0
FETCH_TIMEOUT_S = 5.0
DNS_TIMEOUT_S = 1.5
MAX_FETCH_BYTES = 500 * 1024
MAX_URL_LEN = 200
MAX_REDIRECTS = 3
MAX_PAGE_CHARS = 12_000
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"
REDIRECT_STATUSES = {301, 302, 303, 307, 308}

SYSTEM_PROMPT = """You evaluate how ready a company looks to ship AI products
based ONLY on the supplied homepage text.

Score strictly. Higher scores require:
- a clear AI story or positioning
- concrete technical signals
- proof-of-work signals such as docs, integrations, demos, architecture,
  case studies, evals, benchmarks, or deployment detail

If evidence is missing, score lower. Keep every string concise and factual.
`risks` must contain exactly 3 short strings. `opportunities` must contain
exactly 3 short strings. `next_action` must be one concrete sentence.
"""

AUDIT_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "readiness_score": {
            "type": "integer",
            "minimum": 0,
            "maximum": 10,
        },
        "score_rationale": {
            "type": "string",
            "minLength": 1,
            "maxLength": 400,
        },
        "risks": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {"type": "string", "minLength": 1, "maxLength": 140},
        },
        "opportunities": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {"type": "string", "minLength": 1, "maxLength": 140},
        },
        "next_action": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
        },
    },
    "required": [
        "readiness_score",
        "score_rationale",
        "risks",
        "opportunities",
        "next_action",
    ],
}


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[ai-readiness-audit] {msg}", flush=True)


def _collapse_ws(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _resolve_model() -> str:
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL_ID).strip()
    if not (model.startswith("gemini-2.5") or model.startswith("gemini-3")):
        raise SystemExit(
            f"refusing to run: model must be gemini-2.5.x or gemini-3.x (got '{model}')"
        )
    return model


def _normalize_company_url(company_url: str) -> str:
    if not isinstance(company_url, str):
        raise ValueError("company_url must be a string")
    raw = company_url.strip()
    if not raw:
        raise ValueError("company_url is required")
    if len(raw) > MAX_URL_LEN:
        raise ValueError(f"company_url must be <= {MAX_URL_LEN} characters")
    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise ValueError("company_url must use https://")
    if parsed.username or parsed.password:
        raise ValueError("company_url must not include credentials")
    if not parsed.hostname:
        raise ValueError("company_url must include a hostname")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f"company_url has an invalid port: {exc}") from exc
    hostname = parsed.hostname.lower()
    path = parsed.path or "/"
    netloc = hostname if port in (None, 443) else f"{hostname}:{port}"
    return urlunsplit(("https", netloc, path, parsed.query, ""))


def canonical_input(company_url: str) -> str:
    payload = {"company_url": _normalize_company_url(company_url)}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(company_url: str) -> str:
    return hashlib.sha256(canonical_input(company_url).encode("utf-8")).hexdigest()


def _load_sample_cache() -> dict[str, Any]:
    if not SAMPLE_CACHE_PATH.is_file():
        return {}
    try:
        with open(SAMPLE_CACHE_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as exc:  # noqa: BLE001
        _log(f"sample-cache.json unreadable ({exc}); ignoring")
        return {}
    entries = raw.get("entries") if isinstance(raw, dict) else None
    return entries or {}


def _is_forbidden_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return any(
        (
            ip.is_private,
            ip.is_loopback,
            ip.is_link_local,
            ip.is_reserved,
            ip.is_multicast,
            ip.is_unspecified,
        )
    )


def _assert_public_ip(ip_text: str) -> None:
    ip = ipaddress.ip_address(ip_text)
    if _is_forbidden_ip(ip):
        raise ValueError(
            "company_url must not target private, loopback, link-local, "
            "reserved, or unspecified IP addresses"
        )


async def _assert_public_hostname(url: str) -> None:
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    try:
        _assert_public_ip(hostname)
        return
    except ValueError as exc:
        try:
            ipaddress.ip_address(hostname)
        except ValueError:
            pass
        else:
            raise exc

    try:
        infos = await asyncio.wait_for(
            asyncio.to_thread(
                socket.getaddrinfo,
                hostname,
                parsed.port or 443,
                type=socket.SOCK_STREAM,
            ),
            timeout=DNS_TIMEOUT_S,
        )
    except socket.gaierror as exc:
        raise ValueError(f"company_url host could not be resolved: {hostname}") from exc
    except TimeoutError as exc:
        raise ValueError(f"company_url host lookup timed out: {hostname}") from exc

    resolved_any = False
    for _family, _type, _proto, _canonname, sockaddr in infos:
        ip_text = sockaddr[0]
        resolved_any = True
        _assert_public_ip(ip_text)
    if not resolved_any:
        raise ValueError(f"company_url host could not be resolved: {hostname}")


async def _fetch_url(url: str) -> tuple[str, str, bytes]:
    headers = {
        "User-Agent": "floom-ai-readiness-audit/1.0",
        "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
    }
    timeout = httpx.Timeout(FETCH_TIMEOUT_S)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        headers=headers,
    ) as client:
        current_url = url
        for _hop in range(MAX_REDIRECTS + 1):
            await _assert_public_hostname(current_url)
            async with client.stream("GET", current_url) as response:
                if response.status_code in REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("redirect response missing Location header")
                    current_url = _normalize_company_url(str(response.url.join(location)))
                    continue

                response.raise_for_status()

                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if not chunk:
                        continue
                    remaining = MAX_FETCH_BYTES - len(body)
                    if remaining <= 0:
                        break
                    body.extend(chunk[:remaining])
                    if len(body) >= MAX_FETCH_BYTES:
                        break

                final_url = _normalize_company_url(str(response.url))
                content_type = response.headers.get("content-type", "")
                return final_url, content_type, bytes(body)

    raise ValueError(f"too many redirects (max {MAX_REDIRECTS})")


def _extract_main_text(raw_bytes: bytes, company_url: str, content_type: str) -> str:
    decoded = raw_bytes.decode("utf-8", errors="ignore")
    looks_like_html = "html" in content_type.lower() or "<html" in decoded[:1000].lower()
    if not looks_like_html:
        plain = _collapse_ws(decoded)
        if not plain:
            raise ValueError("fetched page had no readable text")
        return plain[:MAX_PAGE_CHARS]

    soup = BeautifulSoup(decoded, "html.parser")
    for tag in soup(
        [
            "script",
            "style",
            "noscript",
            "svg",
            "form",
            "iframe",
            "header",
            "footer",
            "nav",
            "aside",
        ]
    ):
        tag.decompose()

    title = ""
    if soup.title and soup.title.string:
        title = _collapse_ws(soup.title.get_text(" ", strip=True))

    meta_description = ""
    for attrs in (
        {"name": "description"},
        {"property": "og:description"},
    ):
        tag = soup.find("meta", attrs=attrs)
        if tag and tag.get("content"):
            meta_description = _collapse_ws(str(tag["content"]))
            if meta_description:
                break

    candidates = []
    for selector in ("main", "article", '[role="main"]'):
        candidates.extend(soup.select(selector))
    target = max(
        candidates,
        key=lambda node: len(node.get_text(" ", strip=True)),
        default=soup.body or soup,
    )

    blocks: list[str] = []
    seen: set[str] = set()
    for node in target.find_all(["h1", "h2", "h3", "p", "li"], limit=200):
        text = _collapse_ws(node.get_text(" ", strip=True))
        if not text or text in seen:
            continue
        seen.add(text)
        blocks.append(text)

    if not blocks:
        fallback = _collapse_ws(target.get_text(" ", strip=True))
        if fallback:
            blocks.append(fallback)

    parts = [f"URL: {company_url}"]
    if title:
        parts.append(f"Title: {title}")
    if meta_description and meta_description != title:
        parts.append(f"Description: {meta_description}")
    parts.extend(blocks)

    extracted = "\n".join(parts).strip()
    if not extracted:
        raise ValueError("fetched page had no readable text")
    return extracted[:MAX_PAGE_CHARS]


def _clean_string_list(name: str, value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be a list")
    cleaned = []
    for item in value:
        text = _collapse_ws(str(item))
        if not text:
            raise ValueError(f"{name} must not contain empty items")
        cleaned.append(text)
    if len(cleaned) != 3:
        raise ValueError(f"{name} must contain exactly 3 items")
    return cleaned


def _finalize_output(
    payload: dict[str, Any],
    company_url: str,
    *,
    dry_run: bool,
    cache_hit: bool,
    model: str,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("audit response must be an object")

    score = payload.get("readiness_score")
    if not isinstance(score, int) or isinstance(score, bool):
        raise ValueError("readiness_score must be an integer 0-10")
    if score < 0 or score > 10:
        raise ValueError("readiness_score must be between 0 and 10")

    score_rationale = _collapse_ws(str(payload.get("score_rationale") or ""))
    next_action = _collapse_ws(str(payload.get("next_action") or ""))
    if not score_rationale:
        raise ValueError("score_rationale is required")
    if not next_action:
        raise ValueError("next_action is required")

    return {
        "company_url": company_url,
        "readiness_score": score,
        "score_rationale": score_rationale,
        "risks": _clean_string_list("risks", payload.get("risks")),
        "opportunities": _clean_string_list(
            "opportunities",
            payload.get("opportunities"),
        ),
        "next_action": next_action,
        "dry_run": dry_run,
        "cache_hit": cache_hit,
        "model": model,
    }


def _dry_run_payload(company_url: str) -> dict[str, Any]:
    host = urlparse(company_url).hostname or company_url
    return {
        "company_url": company_url,
        "readiness_score": 7,
        "score_rationale": (
            f"DRY RUN (no GEMINI_API_KEY). {host} has enough public product copy "
            "to demonstrate the audit flow, but this score is a deterministic "
            "placeholder rather than a live model judgment."
        ),
        "risks": [
            "no public evals or benchmark metrics",
            "proof-of-work signals are thin or scattered",
            "AI positioning may be clear but implementation depth is hard to verify",
        ],
        "opportunities": [
            "add one quantified AI case study with before-and-after metrics",
            "publish a short architecture or workflow page showing how the product works",
            "show concrete proof like demos, docs, or integration screenshots",
        ],
        "next_action": (
            "Publish one concrete case study with metrics, screenshots, and "
            "implementation detail to strengthen the public AI story."
        ),
    }


async def _call_gemini(company_url: str, page_text: str, model: str) -> dict[str, Any]:
    from google import genai  # type: ignore
    from google.genai.types import GenerateContentConfig, ThinkingConfig  # type: ignore

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is required for live runs")

    prompt = (
        f"Company URL: {company_url}\n\n"
        "Homepage text:\n"
        f"{page_text}\n\n"
        "Return the JSON audit."
    )

    client = genai.Client(api_key=api_key)
    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.1,
        max_output_tokens=1024,
        response_mime_type="application/json",
        response_json_schema=AUDIT_JSON_SCHEMA,
        thinking_config=ThinkingConfig(thinking_budget=0),
    )
    try:
        response = await client.aio.models.generate_content(
            model=model,
            contents=prompt,
            config=config,
        )
    finally:
        await client.aio.aclose()

    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("empty response from Gemini")
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("Gemini returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("Gemini response was not a JSON object")
    return payload


async def _audit_async(company_url: str) -> dict[str, Any]:
    started = time.perf_counter()
    normalized_url = _normalize_company_url(company_url)
    resolved_model = _resolve_model()

    cache = _load_sample_cache()
    cache_key = _input_hash(normalized_url)
    if cache_key in cache:
        _log(f"cache hit for input_hash={cache_key[:12]}... (instant response)")
        cached = _finalize_output(
            dict(cache[cache_key]),
            _normalize_company_url(str(cache[cache_key].get("company_url") or normalized_url)),
            dry_run=False,
            cache_hit=True,
            model=str(cache[cache_key].get("model") or "sample-cache"),
        )
        _log(f"done in {time.perf_counter() - started:.2f}s")
        return cached

    async with asyncio.timeout(HARD_TIMEOUT_S):
        _log("fetching URL")
        fetched_url, content_type, raw_bytes = await _fetch_url(normalized_url)
        _log(f"fetched {len(raw_bytes)} bytes")
        page_text = _extract_main_text(raw_bytes, fetched_url, content_type)

        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key:
            _log("calling Gemini (dry run stub)")
            payload = _dry_run_payload(fetched_url)
            result = _finalize_output(
                payload,
                fetched_url,
                dry_run=True,
                cache_hit=False,
                model="dry-run",
            )
        else:
            _log("calling Gemini")
            payload = await _call_gemini(fetched_url, page_text, resolved_model)
            result = _finalize_output(
                payload,
                fetched_url,
                dry_run=False,
                cache_hit=False,
                model=resolved_model,
            )

    _log(f"done in {time.perf_counter() - started:.2f}s")
    return result


def audit(company_url: str, **extra_inputs: Any) -> dict[str, Any]:
    if extra_inputs:
        extra = ", ".join(sorted(extra_inputs))
        raise ValueError(f"Only company_url is supported; unexpected input(s): {extra}")
    return asyncio.run(_audit_async(company_url))


def _read_payload() -> dict[str, Any]:
    if len(sys.argv) >= 2 and sys.argv[1] not in ("", "-"):
        return json.loads(sys.argv[1])
    data = sys.stdin.read()
    if not data.strip():
        raise SystemExit("no input: pass JSON as argv[1] or on stdin")
    return json.loads(data)


def main() -> int:
    try:
        payload = _read_payload()
    except json.JSONDecodeError as exc:
        _emit(
            {
                "ok": False,
                "error": f"invalid JSON: {exc}",
                "error_type": "runtime_error",
            }
        )
        return 2

    action = payload.get("action") or "audit"
    if action != "audit":
        _emit(
            {
                "ok": False,
                "error": f"Unknown action '{action}'. Only 'audit' is supported.",
                "error_type": "invalid_action",
            }
        )
        return 2

    inputs = payload.get("inputs") or {}
    if not isinstance(inputs, dict):
        _emit(
            {
                "ok": False,
                "error": "inputs must be an object",
                "error_type": "runtime_error",
            }
        )
        return 2

    unexpected = sorted(set(inputs) - {"company_url"})
    if unexpected:
        _emit(
            {
                "ok": False,
                "error": (
                    "Only company_url is supported; unexpected input(s): "
                    + ", ".join(unexpected)
                ),
                "error_type": "runtime_error",
            }
        )
        return 2

    try:
        out = audit(company_url=inputs.get("company_url"))
        _emit({"ok": True, "outputs": out})
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": str(exc), "error_type": "runtime_error"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
