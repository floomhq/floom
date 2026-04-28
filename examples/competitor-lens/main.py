#!/usr/bin/env python3
"""
Competitor Lens — bounded Floom demo app.

This example compares exactly two HTTPS URLs: one for the user's product and
one for a competitor. It exposes:

- `app`: a FastAPI application with auto-generated OpenAPI.
- `analyze(...)`: a shared Python entrypoint used by both FastAPI and the
  Floom CLI-style runner contract.
- `python main.py '{"action":"analyze","inputs":{...}}'`: the same single-run
  CLI protocol the other demo apps use.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
import uvicorn
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

DEFAULT_MODEL = "gemini-2.5-flash-lite"
# 2026-04-28 (R9): bumped 5s → 8s. Modern Next.js / Webflow marketing
# sites are 1-2.5MB with the meta tags we need past byte 500KB. With the
# new 1.5MB cap, slow tail fetches need a bit more headroom.
FETCH_TIMEOUT_S = 8.0
# Benchmarked 2026-04-25: 2.5-flash-lite + JSON schema returns in 1-3s.
# Re-benchmarked 2026-04-28 (R9 launch): observed 6-9s tail latency on
# generativelanguage.googleapis.com under load. Bumped total budget so a
# realistic worst-case fetch (5s) + slow Gemini (12s) doesn't time out.
# Still well under the 30s manifest timeout.
TOTAL_BUDGET_S = 22.0
# 2026-04-28 (R9): bumped from 500KB → 1.5MB. Modern marketing sites
# (Next.js / Nuxt / Webflow) emit 1-2.5MB of HTML where the meta tags
# we need for the fallback path can sit past byte 500KB. The DOM cost
# under BS4 is still well within the 512MB RUNNER_MEMORY ceiling.
MAX_RESPONSE_BYTES = 1_500_000
MAX_URL_LEN = 200
MAX_TEXT_CHARS = 12_000
MAX_REDIRECTS = 3
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"

DROP_TAGS = (
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "video",
    "audio",
    "picture",
    "img",
    "form",
    "header",
    "footer",
    "nav",
    "aside",
)

READABLE_SELECTORS = (
    "main",
    '[role="main"]',
    "article",
    '[class*="content"]',
    '[id*="content"]',
    '[class*="main"]',
    '[id*="main"]',
    ".prose",
)

GEMINI_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "positioning": {
            "type": "ARRAY",
            "minItems": 3,
            "maxItems": 3,
            "description": (
                "Exactly three rows in this order: row 0 = your page's "
                "positioning angle (perspective='You'); row 1 = the "
                "competitor's positioning angle (perspective='Competitor'); "
                "row 2 = the one-line contrast (perspective='Contrast')."
            ),
            "items": {
                "type": "OBJECT",
                "properties": {
                    "perspective": {
                        "type": "STRING",
                        "enum": ["You", "Competitor", "Contrast"],
                    },
                    "angle": {"type": "STRING"},
                },
                "required": ["perspective", "angle"],
            },
        },
        "pricing": {
            "type": "ARRAY",
            "minItems": 2,
            "maxItems": 2,
            "description": (
                "Exactly two rows: row 0 for your page (who='You'); row 1 "
                "for the competitor's page (who='Competitor')."
            ),
            "items": {
                "type": "OBJECT",
                "properties": {
                    "who": {
                        "type": "STRING",
                        "enum": ["You", "Competitor"],
                    },
                    "pricing": {"type": "STRING"},
                },
                "required": ["who", "pricing"],
            },
        },
        "pricing_insight": {"type": "STRING"},
        "unique_to_you": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
            "minItems": 3,
            "maxItems": 3,
        },
        "unique_to_competitor": {
            "type": "ARRAY",
            "items": {"type": "STRING"},
            "minItems": 3,
            "maxItems": 3,
        },
    },
    "required": [
        "positioning",
        "pricing",
        "pricing_insight",
        "unique_to_you",
        "unique_to_competitor",
    ],
}


class AppError(Exception):
    status_code = 400
    error_type = "runtime_error"

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class InputValidationError(AppError):
    status_code = 400


class FriendlyTimeoutError(AppError):
    status_code = 504
    error_type = "timeout"


class AnalysisError(AppError):
    status_code = 502


@dataclass(frozen=True)
class ValidatedInputs:
    your_url: str
    competitor_url: str
    your_host: str
    competitor_host: str


@dataclass(frozen=True)
class FetchedPage:
    requested_url: str
    final_url: str
    title: str
    text: str
    byte_count: int


class PositioningRow(BaseModel):
    perspective: str
    angle: str


class PricingRow(BaseModel):
    who: str
    pricing: str


class MetaInfo(BaseModel):
    dry_run: bool
    cache_hit: bool
    model: str


class AnalyzeOutput(BaseModel):
    positioning: list[PositioningRow]
    pricing: list[PricingRow]
    pricing_insight: str
    unique_to_you: list[str]
    unique_to_competitor: list[str]
    meta: MetaInfo


class AnalyzeInputs(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    your_url: str = Field(..., description="Your HTTPS homepage or product page.", max_length=MAX_URL_LEN)
    competitor_url: str = Field(..., description="A competitor HTTPS homepage or product page.", max_length=MAX_URL_LEN)


class RunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str = "analyze"
    inputs: AnalyzeInputs


class RunResponse(BaseModel):
    ok: bool
    outputs: AnalyzeOutput


app = FastAPI(
    title="Competitor Lens",
    version="1.0.0",
    description=(
        "Compare one product page against one competitor page with strict URL "
        "validation, bounded fetches, and a single Gemini 3 structured output."
    ),
)


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    print(f"[competitor-lens] {message}", flush=True)


def _resolve_model() -> str:
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL).strip()
    if not (model.startswith("gemini-2.5") or model.startswith("gemini-3")):
        raise InputValidationError(
            f"GEMINI_MODEL must be gemini-3.x (got '{model}')."
        )
    return model


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _normalize_host(hostname: str) -> str:
    return hostname.rstrip(".").lower()


def _build_normalized_url(raw_url: str) -> tuple[str, str]:
    if not isinstance(raw_url, str):
        raise InputValidationError("Both inputs must be strings.")
    value = raw_url.strip()
    if not value:
        raise InputValidationError("Both URLs are required.")
    if len(value) > MAX_URL_LEN:
        raise InputValidationError(
            f"URLs must be {MAX_URL_LEN} characters or fewer."
        )
    parts = urlsplit(value)
    if parts.scheme.lower() != "https":
        raise InputValidationError("Only HTTPS URLs are allowed.")
    if not parts.hostname:
        raise InputValidationError("Each URL must include a valid hostname.")
    if parts.username or parts.password:
        raise InputValidationError("Embedded credentials are not allowed in URLs.")
    host = _normalize_host(parts.hostname)
    netloc = host
    if parts.port:
        netloc = f"{host}:{parts.port}"
    normalized = urlunsplit(
        ("https", netloc, parts.path or "", parts.query, "")
    )
    return normalized, host


def canonical_input(your_url: str, competitor_url: str) -> str:
    normalized_your_url, _ = _build_normalized_url(your_url)
    normalized_competitor_url, _ = _build_normalized_url(competitor_url)
    payload = {
        "competitor_url": normalized_competitor_url,
        "your_url": normalized_your_url,
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(your_url: str, competitor_url: str) -> str:
    return hashlib.sha256(
        canonical_input(your_url, competitor_url).encode("utf-8")
    ).hexdigest()


def _load_sample_cache() -> dict[str, Any]:
    if not SAMPLE_CACHE_PATH.is_file():
        return {}
    try:
        with open(SAMPLE_CACHE_PATH, encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception as exc:  # noqa: BLE001
        _log(f"sample-cache.json unreadable ({exc}); ignoring")
        return {}
    entries = raw.get("entries") if isinstance(raw, dict) else None
    return entries or {}


def _meta_blob(soup: BeautifulSoup) -> str:
    """Stitch <meta description / og:* / twitter:*> together as a fallback for
    JS-hydrated SPAs that ship empty bodies. Many landing pages put their
    real positioning in og:title + og:description, which is the same signal
    Gemini needs."""
    parts: list[str] = []
    seen: set[str] = set()

    def _push(value: str | None) -> None:
        if not value:
            return
        cleaned = _clean_text(value)
        if not cleaned:
            return
        key = cleaned.lower()
        if key in seen:
            return
        seen.add(key)
        parts.append(cleaned)

    for selector, attr in (
        ('meta[name="description"]', "content"),
        ('meta[name="twitter:title"]', "content"),
        ('meta[name="twitter:description"]', "content"),
        ('meta[property="og:title"]', "content"),
        ('meta[property="og:description"]', "content"),
        ('meta[property="og:site_name"]', "content"),
    ):
        for tag in soup.select(selector):
            _push(tag.get(attr))

    return "\n".join(parts)


def _extract_main_text(html_bytes: bytes) -> tuple[str, str]:
    soup = BeautifulSoup(html_bytes, "html.parser")
    title = ""
    if soup.title:
        title = _clean_text(soup.title.get_text(" ", strip=True))

    # Capture meta-description/og fallbacks BEFORE we decompose() drop-tags,
    # otherwise <head> meta tags inside dropped containers (rare but possible)
    # are lost. Meta-blob is a non-empty signal even when the SPA body is
    # essentially empty pre-hydration.
    meta_blob = _meta_blob(soup)

    for tag in DROP_TAGS:
        for node in soup.find_all(tag):
            node.decompose()

    candidates = []
    for selector in READABLE_SELECTORS:
        candidates.extend(soup.select(selector))
    if not candidates and soup.body is not None:
        candidates = [soup.body]

    root = max(
        candidates or [soup],
        key=lambda node: len(node.get_text(" ", strip=True)),
    )

    seen: set[str] = set()
    lines: list[str] = []
    total_chars = 0
    for node in root.find_all(["h1", "h2", "h3", "p", "li"]):
        text = _clean_text(node.get_text(" ", strip=True))
        if len(text) < 25:
            continue
        lowered = text.lower()
        if lowered in seen:
            continue
        seen.add(lowered)
        lines.append(text)
        total_chars += len(text) + 1
        if total_chars >= MAX_TEXT_CHARS:
            break

    if not lines:
        fallback = []
        for chunk in re.split(r"\n+", root.get_text("\n", strip=True)):
            text = _clean_text(chunk)
            if len(text) >= 25:
                fallback.append(text)
        lines = fallback

    combined = "\n".join(lines).strip()[:MAX_TEXT_CHARS]

    # 2026-04-28 (R9 reliability fix): if the body extraction returned almost
    # nothing — typical for JS-hydrated SPAs that defer real content to client
    # rendering — fall back to the meta/OG description blob. Many landing
    # pages encode their entire positioning pitch in <meta> tags for social
    # previews. Combined with the title, that's enough signal for the
    # comparison even when the rendered DOM is mostly skeleton.
    if len(combined) < 200 and meta_blob:
        prefix = combined + ("\n" if combined else "")
        combined = (prefix + meta_blob)[:MAX_TEXT_CHARS]

    # 2026-04-28 (R9 last-resort): if even meta is thin (sites where the
    # SSR shell only carries the title + brand), pull whatever raw text the
    # body still has. Better to give Gemini a thin signal than to surface
    # an opaque error to the user.
    if len(combined) < 120 and soup.body is not None:
        raw = _clean_text(soup.body.get_text(" ", strip=True))[:MAX_TEXT_CHARS]
        if len(raw) >= 40:
            combined = (combined + "\n" + raw).strip()[:MAX_TEXT_CHARS]

    if len(combined) < 60:
        body_len = max(0, len(combined) - len(meta_blob))
        raise AnalysisError(
            "Couldn't extract enough readable page text. Try a homepage or pricing page. "
            f"(body={body_len}, meta={len(meta_blob)}, total={len(combined)})"
        )
    return title, combined


def _is_privateish_ip(ip_value: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return any(
        (
            ip_value.is_private,
            ip_value.is_loopback,
            ip_value.is_link_local,
            ip_value.is_reserved,
            ip_value.is_multicast,
            ip_value.is_unspecified,
        )
    )


async def _assert_public_host(hostname: str) -> None:
    normalized = _normalize_host(hostname)
    if normalized == "localhost" or normalized.endswith(".localhost"):
        raise InputValidationError("Localhost URLs are not allowed.")

    literal = normalized.strip("[]")
    try:
        ip_value = ipaddress.ip_address(literal)
    except ValueError:
        return
    if _is_privateish_ip(ip_value):
        raise InputValidationError("Private or loopback IP URLs are not allowed.")


def _validate_basic_inputs(your_url: str, competitor_url: str) -> ValidatedInputs:
    normalized_your_url, your_host = _build_normalized_url(your_url)
    normalized_competitor_url, competitor_host = _build_normalized_url(
        competitor_url
    )
    if your_host == competitor_host:
        raise InputValidationError(
            "competitor_url must use a different host than your_url."
        )
    return ValidatedInputs(
        your_url=normalized_your_url,
        competitor_url=normalized_competitor_url,
        your_host=your_host,
        competitor_host=competitor_host,
    )


async def _validate_public_hosts(inputs: ValidatedInputs) -> ValidatedInputs:
    await asyncio.gather(
        _assert_public_host(inputs.your_host),
        _assert_public_host(inputs.competitor_host),
    )
    return inputs


async def _validate_inputs(your_url: str, competitor_url: str) -> ValidatedInputs:
    return await _validate_public_hosts(
        _validate_basic_inputs(your_url, competitor_url)
    )


async def _fetch_page(client: httpx.AsyncClient, url: str) -> FetchedPage:
    current_url = url
    try:
        async with asyncio.timeout(FETCH_TIMEOUT_S):
            for _ in range(MAX_REDIRECTS + 1):
                async with client.stream(
                    "GET",
                    current_url,
                    follow_redirects=False,
                ) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location", "").strip()
                        if not location:
                            raise AnalysisError(
                                f"{url} redirected without a Location header."
                            )
                        next_url = urljoin(str(response.url), location)
                        current_url, next_host = _build_normalized_url(next_url)
                        await _assert_public_host(next_host)
                        continue

                    response.raise_for_status()
                    buffer = bytearray()
                    async for chunk in response.aiter_bytes():
                        buffer.extend(chunk)
                        if len(buffer) >= MAX_RESPONSE_BYTES:
                            del buffer[MAX_RESPONSE_BYTES:]
                            break
                    if not buffer:
                        raise AnalysisError(f"{url} returned an empty response.")
                    title, text = _extract_main_text(bytes(buffer))
                    return FetchedPage(
                        requested_url=url,
                        final_url=str(response.url),
                        title=title,
                        text=text,
                        byte_count=len(buffer),
                    )
    except asyncio.TimeoutError as exc:
        raise FriendlyTimeoutError(
            "One of the URLs took longer than 8 seconds to load. Try lighter pages and retry."
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise AnalysisError(
            f"Failed to fetch {url} (HTTP {exc.response.status_code})."
        ) from exc
    except httpx.HTTPError as exc:
        raise AnalysisError(f"Failed to fetch {url} ({type(exc).__name__}).") from exc

    raise AnalysisError(f"Too many redirects while fetching {url}.")


def _require_text(data: Any, path: str, default: str | None = None) -> str:
    if isinstance(data, str):
        cleaned = _clean_text(data)
        if cleaned:
            return cleaned
    if default is not None:
        return default
    raise AnalysisError(f"Gemini returned an invalid `{path}` field.")


def _require_string_list(
    data: Any,
    path: str,
    *,
    expected_count: int | None = None,
) -> list[str]:
    if not isinstance(data, list):
        raise AnalysisError(f"Gemini returned an invalid `{path}` field.")
    values = []
    for item in data:
        if not isinstance(item, str):
            continue
        cleaned = _clean_text(item)
        if cleaned:
            values.append(cleaned)
    if expected_count is None:
        if len(values) < 1:
            raise AnalysisError(f"Gemini returned an empty `{path}` field.")
        return values
    if len(values) != expected_count:
        raise AnalysisError(
            f"Gemini returned `{path}` with {len(values)} items (expected {expected_count})."
        )
    return values


def _require_table_rows(
    data: Any,
    path: str,
    *,
    first_key: str,
    second_key: str,
    expected_count: int,
) -> list[dict[str, str]]:
    if not isinstance(data, list):
        raise AnalysisError(f"Gemini returned an invalid `{path}` field.")
    rows: list[dict[str, str]] = []
    for index, item in enumerate(data):
        if not isinstance(item, dict):
            raise AnalysisError(f"Gemini returned an invalid `{path}[{index}]` row.")
        rows.append(
            {
                first_key: _require_text(item.get(first_key), f"{path}[{index}].{first_key}"),
                second_key: _require_text(item.get(second_key), f"{path}[{index}].{second_key}"),
            }
        )
    if len(rows) != expected_count:
        raise AnalysisError(
            f"Gemini returned `{path}` with {len(rows)} rows (expected {expected_count})."
        )
    return rows


def _normalize_result(
    raw: dict[str, Any],
    *,
    model: str,
    dry_run: bool,
    cache_hit: bool,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise AnalysisError("Gemini returned a non-object response.")

    return {
        "positioning": _require_table_rows(
            raw.get("positioning"),
            "positioning",
            first_key="perspective",
            second_key="angle",
            expected_count=3,
        ),
        "pricing": _require_table_rows(
            raw.get("pricing"),
            "pricing",
            first_key="who",
            second_key="pricing",
            expected_count=2,
        ),
        "pricing_insight": _require_text(
            raw.get("pricing_insight"),
            "pricing_insight",
        ),
        "unique_to_you": _require_string_list(
            raw.get("unique_to_you"),
            "unique_to_you",
            expected_count=3,
        ),
        "unique_to_competitor": _require_string_list(
            raw.get("unique_to_competitor"),
            "unique_to_competitor",
            expected_count=3,
        ),
        "meta": {
            "dry_run": dry_run,
            "cache_hit": cache_hit,
            "model": model,
        },
    }


def _dry_run_stub(inputs: ValidatedInputs, model: str) -> dict[str, Any]:
    your_name = inputs.your_host.split(".")[0]
    competitor_name = inputs.competitor_host.split(".")[0]
    stub = {
        "positioning": [
            {
                "perspective": "You",
                "angle": (
                    f"{your_name.capitalize()} reads like a focused product page that pushes a single deployment outcome."
                ),
            },
            {
                "perspective": "Competitor",
                "angle": (
                    f"{competitor_name.capitalize()} reads like a broader platform with more visible workflow surface area."
                ),
            },
            {
                "perspective": "Contrast",
                "angle": (
                    f"{your_name.capitalize()} feels narrower and faster to grasp, while {competitor_name.capitalize()} feels broader and more configurable."
                ),
            },
        ],
        "pricing": [
            {
                "who": "You",
                "pricing": "Not visible on page.",
            },
            {
                "who": "Competitor",
                "pricing": "Not visible on page.",
            },
        ],
        "pricing_insight": (
            "The dry-run path only compares page framing. Add GEMINI_API_KEY for a live structured read."
        ),
        "unique_to_you": [
            "Tighter single-job framing",
            "Faster time-to-value messaging",
            "Less category sprawl on-page",
        ],
        "unique_to_competitor": [
            "Broader platform framing",
            "More visible workflow breadth",
            "More enterprise/platform cues",
        ],
    }
    return _normalize_result(stub, model=model, dry_run=True, cache_hit=False)


def _build_prompt(your_page: FetchedPage, competitor_page: FetchedPage) -> str:
    return f"""You are comparing two product pages: YOUR PAGE and the COMPETITOR PAGE.

Use only the page extracts below. Do not invent pricing, packaging, or claims
that are not supported by the supplied text. If pricing is missing, say
"Not visible on page."

Return ONLY JSON matching the provided schema. Keep the language concise and
commercially useful.

OUTPUT RULES (critical — schema enforces order):
- positioning rows MUST be in this exact order:
    1. perspective = "You"        → one sentence describing YOUR PAGE's positioning angle.
    2. perspective = "Competitor" → one sentence describing the COMPETITOR PAGE's positioning angle.
    3. perspective = "Contrast"   → one sentence comparing the two (what each leans into vs the other).
- pricing rows MUST be in this exact order:
    1. who = "You"        → YOUR PAGE's pricing as quoted on page (or "Not visible on page.").
    2. who = "Competitor" → COMPETITOR PAGE's pricing (or "Not visible on page.").
- pricing_insight: 1 sentence on what's interesting about the pricing diff (or about the absence).
- unique_to_you: 3 distinct things YOUR PAGE highlights that the COMPETITOR doesn't.
- unique_to_competitor: 3 distinct things the COMPETITOR highlights that YOUR PAGE doesn't.

YOUR PAGE
URL: {your_page.final_url}
TITLE: {your_page.title or "(untitled)"}
TEXT:
{your_page.text}

COMPETITOR PAGE
URL: {competitor_page.final_url}
TITLE: {competitor_page.title or "(untitled)"}
TEXT:
{competitor_page.text}
"""


async def _call_gemini(
    client: httpx.AsyncClient,
    *,
    api_key: str,
    model: str,
    prompt: str,
    timeout_s: float,
) -> dict[str, Any]:
    if timeout_s <= 0:
        raise FriendlyTimeoutError(
            "The comparison step ran out of time before Gemini could start."
        )

    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 1200,
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_SCHEMA,
        },
    }

    try:
        async with asyncio.timeout(timeout_s):
            response = await client.post(
                (
                    "https://generativelanguage.googleapis.com/v1beta/models/"
                    f"{model}:generateContent"
                ),
                params={"key": api_key},
                json=payload,
                timeout=timeout_s,
            )
            response.raise_for_status()
    except asyncio.TimeoutError as exc:
        raise FriendlyTimeoutError(
            "Gemini took too long. Try simpler pages or retry."
        ) from exc
    except httpx.HTTPStatusError as exc:
        raise AnalysisError(
            f"Gemini request failed (HTTP {exc.response.status_code})."
        ) from exc
    except httpx.HTTPError as exc:
        raise AnalysisError(
            f"Gemini request failed ({type(exc).__name__})."
        ) from exc

    body = response.json()
    candidates = body.get("candidates") or []
    if not candidates:
        raise AnalysisError("Gemini returned no candidates.")
    parts = candidates[0].get("content", {}).get("parts", []) or []
    text = "".join(
        part.get("text", "")
        for part in parts
        if isinstance(part, dict)
    ).strip()
    if not text:
        raise AnalysisError("Gemini returned an empty response.")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise AnalysisError("Gemini returned invalid JSON.") from exc
    return _normalize_result(parsed, model=model, dry_run=False, cache_hit=False)


async def _analyze_async(your_url: str, competitor_url: str) -> dict[str, Any]:
    started = time.monotonic()
    try:
        async with asyncio.timeout(TOTAL_BUDGET_S):
            inputs = _validate_basic_inputs(your_url, competitor_url)

            cache = _load_sample_cache()
            cache_key = _input_hash(inputs.your_url, inputs.competitor_url)
            if cache_key in cache:
                cached = dict(cache[cache_key])
                meta = dict(cached.get("meta") or {})
                meta["cache_hit"] = True
                meta["dry_run"] = False
                meta.setdefault("model", f"{DEFAULT_MODEL} (cached)")
                cached["meta"] = meta
                _log(f"done in {time.monotonic() - started:.2f}s")
                return cached

            inputs = await _validate_public_hosts(inputs)

            # 2026-04-28 (R9 reliability fix): some marketing sites (openai.com,
            # several Cloudflare-fronted SaaS) 403 the bot-shaped UA. A
            # conventional browser UA gets through. We also identify
            # ourselves via X-Floom-App so server logs/abuse triage can still
            # pin the source.
            headers = {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0.0.0 Safari/537.36"
                ),
                "X-Floom-App": "competitor-lens/1.0 (+https://floom.dev)",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }
            timeout = httpx.Timeout(connect=2.0, read=FETCH_TIMEOUT_S, write=2.0, pool=1.0)
            # HTTP/1.1 is fine for fetching 2 pages. Dropped http2=True to
            # avoid the optional 'h2' dep that isn't in the runtime image.
            async with httpx.AsyncClient(
                headers=headers,
                timeout=timeout,
            ) as client:
                _log("fetching URLs")
                try:
                    your_page, competitor_page = await asyncio.gather(
                        _fetch_page(client, inputs.your_url),
                        _fetch_page(client, inputs.competitor_url),
                    )
                except AppError as exc:
                    # 2026-04-28 (R9 diag): make the failing URL visible in
                    # logs so we can tell which side of the diff died.
                    _log(f"fetch failed: {type(exc).__name__}: {exc.message}")
                    raise
                _log(
                    "fetched "
                    f"{your_page.byte_count} bytes ({your_page.final_url}) / "
                    f"{competitor_page.byte_count} bytes ({competitor_page.final_url})"
                )

                model = _resolve_model()
                api_key = os.environ.get("GEMINI_API_KEY", "").strip()
                if not api_key:
                    _log("calling Gemini (dry-run stub)")
                    result = _dry_run_stub(inputs, model)
                    _log(f"done in {time.monotonic() - started:.2f}s")
                    return result

                _log("calling Gemini")
                elapsed = time.monotonic() - started
                # Raw httpx call bypasses the 10s SDK minimum. Cap Gemini
                # at 15s — typical 1-3s, observed tail 6-9s, so 15s gives
                # comfortable headroom without blowing the 22s total budget
                # or the 30s manifest timeout.
                remaining_budget = max(4.0, min(15.0, TOTAL_BUDGET_S - elapsed - 0.25))
                result = await _call_gemini(
                    client,
                    api_key=api_key,
                    model=model,
                    prompt=_build_prompt(your_page, competitor_page),
                    timeout_s=remaining_budget,
                )
                _log(f"done in {time.monotonic() - started:.2f}s")
                return result
    except asyncio.TimeoutError as exc:
        raise FriendlyTimeoutError(
            "Competitor Lens hit its time budget. Try lighter pages or retry."
        ) from exc


def analyze(*, your_url: str, competitor_url: str) -> dict[str, Any]:
    return asyncio.run(_analyze_async(your_url=your_url, competitor_url=competitor_url))


@app.post("/analyze", response_model=AnalyzeOutput)
async def analyze_route(inputs: AnalyzeInputs) -> dict[str, Any]:
    try:
        return await _analyze_async(
            your_url=inputs.your_url,
            competitor_url=inputs.competitor_url,
        )
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


@app.post("/run", response_model=RunResponse)
async def run_route(payload: RunRequest) -> dict[str, Any]:
    if payload.action != "analyze":
        raise HTTPException(
            status_code=400,
            detail=f"Unknown action '{payload.action}'. Only 'analyze' is supported.",
        )
    try:
        outputs = await _analyze_async(
            your_url=payload.inputs.your_url,
            competitor_url=payload.inputs.competitor_url,
        )
        return {"ok": True, "outputs": outputs}
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc


def _read_payload() -> dict[str, Any] | None:
    if len(sys.argv) >= 2 and sys.argv[1] in ("serve", "server"):
        return None
    if len(sys.argv) >= 2 and sys.argv[1] not in ("", "-"):
        return json.loads(sys.argv[1])
    if not sys.stdin.isatty():
        data = sys.stdin.read()
        if data.strip():
            return json.loads(data)
    return None


def _serve() -> int:
    uvicorn.run(
        "main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        log_level=os.environ.get("LOG_LEVEL", "info"),
    )
    return 0


def _cli() -> int:
    try:
        payload = _read_payload()
    except json.JSONDecodeError as exc:
        _emit(
            {
                "ok": False,
                "error": f"Invalid config JSON: {exc}",
                "error_type": "runtime_error",
            }
        )
        return 1

    if payload is None:
        return _serve()

    action = payload.get("action") or "analyze"
    inputs = payload.get("inputs") or {}

    if action != "analyze":
        _emit(
            {
                "ok": False,
                "error": f"Unknown action '{action}'. Only 'analyze' is supported.",
                "error_type": "invalid_action",
            }
        )
        return 1

    if not isinstance(inputs, dict):
        _emit(
            {
                "ok": False,
                "error": "inputs must be a JSON object.",
                "error_type": "runtime_error",
            }
        )
        return 1

    extras = sorted(set(inputs) - {"your_url", "competitor_url"})
    if extras:
        _emit(
            {
                "ok": False,
                "error": (
                    "Only `your_url` and `competitor_url` are accepted inputs. "
                    f"Unexpected keys: {', '.join(extras)}."
                ),
                "error_type": "runtime_error",
            }
        )
        return 1

    try:
        outputs = analyze(
            your_url=str(inputs.get("your_url", "")),
            competitor_url=str(inputs.get("competitor_url", "")),
        )
        _emit({"ok": True, "outputs": outputs})
        return 0
    except AppError as exc:
        _emit(
            {
                "ok": False,
                "error": exc.message,
                "error_type": exc.error_type,
            }
        )
        return 1
    except Exception as exc:  # noqa: BLE001
        _emit(
            {
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
                "error_type": "runtime_error",
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())
