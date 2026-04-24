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
FETCH_TIMEOUT_S = 5.0
# Benchmarked 2026-04-25: 2.5-flash-lite + JSON schema returns in 1-3s.
# Total budget is fetch(5s max × 2 in parallel) + Gemini(8s cap) + slack.
TOTAL_BUDGET_S = 12.0
MAX_RESPONSE_BYTES = 500_000
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
        "positioning_diff": {
            "type": "OBJECT",
            "properties": {
                "your_angle": {"type": "STRING"},
                "their_angle": {"type": "STRING"},
                "contrast_1_liner": {"type": "STRING"},
            },
            "required": ["your_angle", "their_angle", "contrast_1_liner"],
        },
        "pricing_diff": {
            "type": "OBJECT",
            "properties": {
                "your_pricing": {"type": "STRING"},
                "their_pricing": {"type": "STRING"},
                "insight": {"type": "STRING"},
            },
            "required": ["your_pricing", "their_pricing", "insight"],
        },
        "unique_angles": {
            "type": "OBJECT",
            "properties": {
                "you_only_3": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"},
                    "minItems": 3,
                    "maxItems": 3,
                },
                "them_only_3": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"},
                    "minItems": 3,
                    "maxItems": 3,
                },
            },
            "required": ["you_only_3", "them_only_3"],
        },
    },
    "required": ["positioning_diff", "pricing_diff", "unique_angles"],
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


class PositioningDiff(BaseModel):
    your_angle: str
    their_angle: str
    contrast_1_liner: str


class PricingDiff(BaseModel):
    your_pricing: str
    their_pricing: str
    insight: str


class UniqueAngles(BaseModel):
    you_only_3: list[str]
    them_only_3: list[str]


class MetaInfo(BaseModel):
    dry_run: bool
    cache_hit: bool
    model: str


class AnalyzeOutput(BaseModel):
    positioning_diff: PositioningDiff
    pricing_diff: PricingDiff
    unique_angles: UniqueAngles
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


def _extract_main_text(html_bytes: bytes) -> tuple[str, str]:
    soup = BeautifulSoup(html_bytes, "html.parser")
    title = ""
    if soup.title:
        title = _clean_text(soup.title.get_text(" ", strip=True))

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
    if len(combined) < 200:
        raise AnalysisError(
            "Couldn't extract enough readable page text. Try a homepage or pricing page."
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
            "One of the URLs took longer than 5 seconds to load. Try lighter pages and retry."
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


def _require_string_list(data: Any, path: str) -> list[str]:
    if not isinstance(data, list):
        raise AnalysisError(f"Gemini returned an invalid `{path}` field.")
    values = []
    for item in data:
        if not isinstance(item, str):
            continue
        cleaned = _clean_text(item)
        if cleaned:
            values.append(cleaned)
    if len(values) < 1:
        raise AnalysisError(f"Gemini returned an empty `{path}` field.")
    return values[:3]


def _normalize_result(
    raw: dict[str, Any],
    *,
    model: str,
    dry_run: bool,
    cache_hit: bool,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise AnalysisError("Gemini returned a non-object response.")

    positioning = raw.get("positioning_diff") or {}
    pricing = raw.get("pricing_diff") or {}
    unique = raw.get("unique_angles") or {}

    return {
        "positioning_diff": {
            "your_angle": _require_text(positioning.get("your_angle"), "positioning_diff.your_angle"),
            "their_angle": _require_text(positioning.get("their_angle"), "positioning_diff.their_angle"),
            "contrast_1_liner": _require_text(
                positioning.get("contrast_1_liner"),
                "positioning_diff.contrast_1_liner",
            ),
        },
        "pricing_diff": {
            "your_pricing": _require_text(
                pricing.get("your_pricing"),
                "pricing_diff.your_pricing",
                default="Not visible on page.",
            ),
            "their_pricing": _require_text(
                pricing.get("their_pricing"),
                "pricing_diff.their_pricing",
                default="Not visible on page.",
            ),
            "insight": _require_text(pricing.get("insight"), "pricing_diff.insight"),
        },
        "unique_angles": {
            "you_only_3": _require_string_list(unique.get("you_only_3"), "unique_angles.you_only_3"),
            "them_only_3": _require_string_list(unique.get("them_only_3"), "unique_angles.them_only_3"),
        },
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
        "positioning_diff": {
            "your_angle": (
                f"{your_name.capitalize()} reads like a focused product page that pushes a single deployment outcome."
            ),
            "their_angle": (
                f"{competitor_name.capitalize()} reads like a broader platform with more visible workflow surface area."
            ),
            "contrast_1_liner": (
                f"{your_name.capitalize()} feels narrower and faster to grasp, while {competitor_name.capitalize()} feels broader and more configurable."
            ),
        },
        "pricing_diff": {
            "your_pricing": "Not visible on page.",
            "their_pricing": "Not visible on page.",
            "insight": (
                "The dry-run path only compares page framing. Add GEMINI_API_KEY for a live structured read."
            ),
        },
        "unique_angles": {
            "you_only_3": [
                "Tighter single-job framing",
                "Faster time-to-value messaging",
                "Less category sprawl on-page",
            ],
            "them_only_3": [
                "Broader platform framing",
                "More visible workflow breadth",
                "More enterprise/platform cues",
            ],
        },
    }
    return _normalize_result(stub, model=model, dry_run=True, cache_hit=False)


def _build_prompt(your_page: FetchedPage, competitor_page: FetchedPage) -> str:
    return f"""You are analyzing two product pages.

Use only the page extracts below. Do not invent pricing, packaging, or claims
that are not supported by the supplied text. If pricing is missing, say
"Not visible on page."

Return ONLY JSON matching the provided schema. Keep the language concise and
commercially useful.

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

            headers = {
                "User-Agent": "floom-competitor-lens/1.0 (+https://floom.dev)",
                "Accept": "text/html,application/xhtml+xml",
            }
            timeout = httpx.Timeout(connect=2.0, read=FETCH_TIMEOUT_S, write=2.0, pool=1.0)
            async with httpx.AsyncClient(
                headers=headers,
                timeout=timeout,
                http2=True,
            ) as client:
                _log("fetching URLs")
                your_page, competitor_page = await asyncio.gather(
                    _fetch_page(client, inputs.your_url),
                    _fetch_page(client, inputs.competitor_url),
                )
                _log(
                    "fetched "
                    f"{your_page.byte_count} bytes / {competitor_page.byte_count} bytes"
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
                # Raw httpx call bypasses the 10s SDK minimum; 8s cap is
                # plenty for 2.5-flash-lite (typical 1-3s).
                remaining_budget = max(4.0, min(8.0, TOTAL_BUDGET_S - elapsed - 0.25))
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
            "Competitor Lens hit its 10-second limit. Try lighter pages or retry."
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
