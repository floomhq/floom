#!/usr/bin/env python3
"""
Competitor Analyzer — Floom demo app.

Reads one JSON payload from argv[1]:
  {
    "action": "analyze",
    "inputs": {
      "urls": ["https://linear.app", "https://notion.so"],
      "your_product": "One-line description of the user's own product."
    }
  }

Emits one JSON object on stdout:
  {
    "competitors": [ { url, company, positioning, pricing, target_market,
                       strengths: [], weaknesses: [], source_citations: [] }, ... ],
    "summary": "Comparative paragraph.",
    "meta": { "analyzed": N, "failed": M, "dry_run": bool }
  }

Floom runner contract:
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

Runs each URL concurrently (ThreadPoolExecutor, 8 workers) against Gemini 3
with the URL-context tool + Google Search grounding. No Claude, no OpenAI,
no Gemini 2.x. If GEMINI_API_KEY is unset, emits a mock payload for UI demos.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# Model is read from env so ops can upgrade free-tier (flash) → paid (pro)
# without touching code. Hard-fail on any Gemini 2.x / non-Gemini-3 model.
DEFAULT_MODEL = "gemini-3-flash-preview"
# 2026-04-24: bumped default 8 → 32 (Gemini Flash paid tier is ~2000 RPM, so 32
# concurrent calls is safe). Tunable via FLOOM_APP_MAX_WORKERS env. See
# /root/floom-perf-investigation-2026-04-24.md.
MAX_WORKERS = int(os.environ.get("FLOOM_APP_MAX_WORKERS", "32"))
# Hard cap on input URLs to protect Gemini quota + keep runtime bounded. URLs
# above the cap are truncated and a warning is included in the output.
MAX_URLS = int(os.environ.get("FLOOM_APP_MAX_ROWS", "200"))
RETRIES_PER_URL = 1  # one retry on top of the initial attempt

# Sample-input cache: if the canonical input hash matches an entry in
# sample-cache.json, return the frozen golden (generated with
# gemini-3.1-pro-preview) in <500ms. Any other input falls through to a
# live Flash call. See canonical_input() below for the hashing contract.
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"


def _emit(payload: dict[str, Any]) -> None:
    """Write the single-line Floom result the runner parses."""
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _resolve_model() -> str:
    m = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL).strip()
    if not m.startswith("gemini-3"):
        raise SystemExit(
            f"refusing to run: GEMINI_MODEL must be gemini-3.x (got '{m}')"
        )
    return m


def _gemini_endpoint(model: str) -> str:
    return (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent"
    )


PROMPT_TEMPLATE = """You are a competitor-analysis assistant. The user runs \
this product:

<user_product>
{your_product}
</user_product>

Analyze the competitor at this URL: {url}

Use the URL context tool to read the page. If the homepage does not have \
pricing or positioning details, use web search to find them (pricing page, \
about page, G2/Capterra, recent press). Ground every claim in a fetched source.

Return ONLY a JSON object, no prose, matching exactly this schema:

{{
  "company": "Legal / product name",
  "positioning": "One-sentence positioning statement in the competitor's own words when possible.",
  "pricing": "Pricing model summary. E.g. 'Free + $10/user/mo Pro + Enterprise (contact sales)'. Use 'Unknown' if not found.",
  "target_market": "Who they sell to. E.g. 'SMB software teams', 'Enterprise sales orgs'.",
  "strengths": ["3-5 bullets, concrete, differentiated vs user_product above"],
  "weaknesses": ["3-5 bullets, honest, concrete, where user_product could beat them"],
  "source_citations": ["URLs of pages you actually fetched for this analysis"]
}}

Do not wrap the JSON in markdown code fences. Do not add commentary. \
If the page cannot be fetched, return {{"error": "fetch_failed"}}."""


SUMMARY_PROMPT_TEMPLATE = """Given these competitor analyses for a product \
described as:

<user_product>
{your_product}
</user_product>

<analyses>
{analyses_json}
</analyses>

Write a single comparative paragraph (max 5 sentences, no bullet points, no \
headers) that tells the user:
1. The common ground across competitors (what they all do / charge).
2. The clearest white-space opportunity for user_product.
3. The strongest threat to watch.

Return only the paragraph as plain text. No JSON, no markdown."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _company_from_url(url: str) -> str:
    try:
        host = urlparse(url).hostname or url
    except Exception:
        host = url
    host = host.lstrip("www.")
    return host.split(".")[0].capitalize() if host else url


def _strip_code_fences(text: str) -> str:
    """Gemini occasionally wraps JSON in ```json ... ``` despite instructions."""
    t = text.strip()
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", t, flags=re.DOTALL)
    return fence.group(1).strip() if fence else t


def _normalize_urls(urls_raw: Any) -> list[str]:
    """Same normalization main() applies before the run. Extracted so the
    cache key and the runner see the exact same URL list.

    Rules:
      - accept list or newline/comma-separated string
      - strip whitespace, add https:// if missing
      - dedupe, preserve first-occurrence order
    """
    if isinstance(urls_raw, str):
        urls_raw = [p.strip() for p in re.split(r"[,\n]+", urls_raw) if p.strip()]
    elif urls_raw is None:
        urls_raw = []
    if not isinstance(urls_raw, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for u in urls_raw:
        if not isinstance(u, str):
            continue
        u2 = u.strip()
        if not u2:
            continue
        if not u2.startswith(("http://", "https://")):
            u2 = "https://" + u2
        if u2 in seen:
            continue
        seen.add(u2)
        out.append(u2)
    return out


def canonical_input(urls: Any, your_product: str) -> str:
    """Deterministic string representation of the inputs.

    Contract:
      - URLs are normalized via _normalize_urls (lowercase scheme + host is
        NOT forced; competitors often care about path e.g. /enterprise).
        Order is preserved from first occurrence so the canonical is stable
        whether the textarea is "a\\nb" or "a, b".
      - your_product is stripped + internal whitespace runs collapsed to
        single spaces (typo-indifferent canonicalization; Flash runs on
        small edits anyway).
      - JSON-encoded with sort_keys=True.
    """
    normalized_urls = _normalize_urls(urls)
    normalized_product = re.sub(r"\s+", " ", your_product.strip())
    payload = {"urls": normalized_urls, "your_product": normalized_product}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(urls: Any, your_product: str) -> str:
    return hashlib.sha256(canonical_input(urls, your_product).encode("utf-8")).hexdigest()


def _load_sample_cache() -> dict[str, Any]:
    """Load the frozen golden cache, or {} if the file is missing."""
    if not SAMPLE_CACHE_PATH.is_file():
        return {}
    try:
        with open(SAMPLE_CACHE_PATH, encoding="utf-8") as f:
            raw = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(f"[competitor-analyzer] sample-cache.json unreadable ({exc}); ignoring", flush=True)
        return {}
    entries = raw.get("entries") if isinstance(raw, dict) else None
    return entries or {}


def _mock_competitor(url: str, your_product: str) -> dict[str, Any]:
    company = _company_from_url(url)
    return {
        "url": url,
        "company": company,
        "positioning": f"{company} positions as a modern workspace for teams.",
        "pricing": "Free + $10/user/mo + Enterprise (contact sales)",
        "target_market": "SMB to mid-market software and product teams",
        "strengths": [
            "Strong brand recognition in the category",
            "Polished onboarding and UI",
            "Mature integrations ecosystem",
        ],
        "weaknesses": [
            "Expensive at seat-based pricing for large teams",
            "Feature bloat slows time-to-value",
            "Limited API depth for programmatic workflows",
        ],
        "source_citations": [url],
    }


def _mock_summary(your_product: str, competitors: list[dict[str, Any]]) -> str:
    names = ", ".join(c.get("company", c.get("url", "?")) for c in competitors)
    return (
        f"Competitors ({names}) cluster around seat-based SaaS pricing with "
        "polished UIs and broad integrations. The clearest opening is on "
        "programmatic/API depth and pricing that scales on usage rather than "
        "seats. The biggest threat is the incumbent with the largest network "
        "effect, because migration costs grow with every integration they add."
    )


# ---------------------------------------------------------------------------
# Gemini call
# ---------------------------------------------------------------------------

def _call_gemini(
    prompt: str, use_url_context: bool, api_key: str, model: str
) -> str:
    """POST to Gemini generateContent. Returns model text. Raises on HTTP error."""
    import urllib.request
    import urllib.error

    tools: list[dict[str, Any]] = []
    if use_url_context:
        # url_context is the primary grounding tool (reads the URL the user
        # pasted). google_search is a nice-to-have that fills pricing gaps
        # behind "Contact sales" walls. It is also on a stricter free-tier
        # quota bucket, so we gate it behind DISABLE_GOOGLE_SEARCH=1 for
        # operators who want to stay under free-tier limits.
        tools.append({"url_context": {}})
        if os.environ.get("DISABLE_GOOGLE_SEARCH", "").lower() not in (
            "1",
            "true",
            "yes",
        ):
            tools.append({"google_search": {}})

    body: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            # Gemini 3 spends a large chunk on hidden "thinking" tokens before
            # emitting text. 4096 leaves enough headroom after the thought pass
            # for a full JSON object with 5 strengths + 5 weaknesses.
            "maxOutputTokens": 4096,
        },
    }
    if tools:
        body["tools"] = tools

    req = urllib.request.Request(
        url=f"{_gemini_endpoint(model)}?key={api_key}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode("utf-8")

    payload = json.loads(raw)
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"no candidates in gemini response: {raw[:400]}")
    parts = candidates[0].get("content", {}).get("parts", []) or []
    text_chunks = [p.get("text", "") for p in parts if isinstance(p, dict)]
    text = "".join(text_chunks).strip()
    if not text:
        raise RuntimeError(f"empty text in gemini response: {raw[:400]}")
    return text


def _analyze_one(
    url: str, your_product: str, api_key: str, model: str
) -> dict[str, Any]:
    """Retry once on any exception. Return a per-competitor object."""
    import time

    prompt = PROMPT_TEMPLATE.format(url=url, your_product=your_product)
    last_err: Exception | None = None
    for attempt in range(RETRIES_PER_URL + 1):
        try:
            raw = _call_gemini(
                prompt, use_url_context=True, api_key=api_key, model=model
            )
            parsed = json.loads(_strip_code_fences(raw))
            if isinstance(parsed, dict) and parsed.get("error") == "fetch_failed":
                return {"url": url, "error": "fetch_failed"}
            # Normalize: guarantee shape.
            return {
                "url": url,
                "company": parsed.get("company") or _company_from_url(url),
                "positioning": parsed.get("positioning", ""),
                "pricing": parsed.get("pricing", "Unknown"),
                "target_market": parsed.get("target_market", ""),
                "strengths": parsed.get("strengths", []) or [],
                "weaknesses": parsed.get("weaknesses", []) or [],
                "source_citations": parsed.get("source_citations", []) or [],
            }
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            # Brief backoff before retry; helps when we race past a 429.
            if attempt < RETRIES_PER_URL:
                time.sleep(2.0 * (attempt + 1))
            continue
    # Both attempts failed.
    return {
        "url": url,
        "error": "fetch_failed",
        "error_detail": str(last_err)[:200] if last_err else "unknown",
    }


def _comparative_summary(
    your_product: str,
    competitors: list[dict[str, Any]],
    api_key: str,
    model: str,
) -> str:
    successes = [c for c in competitors if "error" not in c]
    if not successes:
        return "No competitors analyzed successfully; cannot produce summary."
    try:
        raw = _call_gemini(
            SUMMARY_PROMPT_TEMPLATE.format(
                your_product=your_product,
                analyses_json=json.dumps(successes, ensure_ascii=False),
            ),
            use_url_context=False,
            api_key=api_key,
            model=model,
        )
        return _strip_code_fences(raw).strip()
    except Exception as exc:  # noqa: BLE001
        return f"Summary unavailable ({type(exc).__name__})."


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def _read_payload() -> dict[str, Any]:
    if len(sys.argv) >= 2 and sys.argv[1] not in ("-", ""):
        return json.loads(sys.argv[1])
    data = sys.stdin.read()
    if not data.strip():
        raise SystemExit("no input: pass JSON as argv[1] or on stdin")
    return json.loads(data)


def main() -> int:
    try:
        payload = _read_payload()
    except json.JSONDecodeError as exc:
        _emit({"ok": False, "error": f"invalid JSON: {exc}", "error_type": "runtime_error"})
        return 2

    # Launch-hardening (2026-04-23): validate the action name so a direct
    # container caller can't bypass the manifest-declared action set. The
    # server already routes manifest-declared actions only, but the
    # entrypoint is also callable via `docker run ...` and `floom run`.
    action = payload.get("action") or "analyze"
    if action != "analyze":
        _emit({
            "ok": False,
            "error": f"Unknown action '{action}'. Only 'analyze' is supported.",
            "error_type": "invalid_action",
        })
        return 2

    inputs = payload.get("inputs") or {}
    urls_raw = inputs.get("urls")
    your_product = (inputs.get("your_product") or "").strip()

    # Bug #350 fix: the runtime manifest declares `urls` as `textarea` because
    # manifest v2.0 has no native array type. The web UI splits that string
    # client-side (see apps/web/src/components/runner/InputField.tsx's
    # ARRAY_INPUT_NAMES), but direct API/MCP callers send the raw string.
    # _normalize_urls() handles both shapes and also dedupes + https://-
    # prefixes. Kept as a helper so the sample-cache canonicalizer sees the
    # exact same URL list the runner does.
    if urls_raw is None or (isinstance(urls_raw, str) and not urls_raw.strip()) or (
        isinstance(urls_raw, list) and not urls_raw
    ):
        _emit(
            {
                "ok": False,
                "error": "inputs.urls must be a non-empty array",
                "error_type": "runtime_error",
            }
        )
        return 2
    if not your_product:
        _emit(
            {
                "ok": False,
                "error": "inputs.your_product is required",
                "error_type": "runtime_error",
            }
        )
        return 2

    urls = _normalize_urls(urls_raw)
    if not urls:
        _emit(
            {
                "ok": False,
                "error": "no valid URLs after normalization",
                "error_type": "runtime_error",
            }
        )
        return 2

    truncated_from = 0
    if len(urls) > MAX_URLS:
        truncated_from = len(urls)
        urls = urls[:MAX_URLS]
        print(
            f"[competitor-analyzer] input has {truncated_from} URLs; capped to "
            f"MAX_URLS={MAX_URLS} (raise FLOOM_APP_MAX_ROWS to override)",
            flush=True,
        )

    # Fast path: exact-match sample input returns the baked-in golden in
    # <500ms. The golden was produced with gemini-3.1-pro-preview (richer
    # reasoning than live Flash). Any other input falls through.
    cache = _load_sample_cache()
    h = _input_hash(urls_raw, your_product)
    if h in cache:
        print(f"[competitor-analyzer] cache hit for input_hash={h[:12]}...", flush=True)
        cached = dict(cache[h])
        meta = dict(cached.get("meta") or {})
        meta["cache_hit"] = True
        meta["dry_run"] = False
        meta.setdefault("model", "gemini-3.1-pro-preview (cached)")
        cached["meta"] = meta
        _emit({"ok": True, "outputs": cached})
        return 0

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    dry_run = not api_key
    model = _resolve_model()

    if dry_run:
        competitors = [_mock_competitor(u, your_product) for u in urls]
        meta: dict[str, Any] = {
            "analyzed": len(competitors),
            "failed": 0,
            "dry_run": True,
            "cache_hit": False,
            "model": model,
        }
        if truncated_from:
            meta["warning"] = (
                f"Input had {truncated_from} URLs; capped at {MAX_URLS} to "
                "protect Gemini quota. Split into smaller batches to analyze more."
            )
            meta["input_urls"] = truncated_from
        result = {
            "competitors": competitors,
            "summary": _mock_summary(your_product, competitors),
            "meta": meta,
        }
        _emit({"ok": True, "outputs": result})
        return 0

    competitors: list[dict[str, Any]] = [None] * len(urls)  # type: ignore[list-item]
    try:
        with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(urls))) as pool:
            futures = {
                pool.submit(_analyze_one, url, your_product, api_key, model): idx
                for idx, url in enumerate(urls)
            }
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    competitors[idx] = fut.result()
                except Exception as exc:  # noqa: BLE001 — keep batch alive
                    competitors[idx] = {
                        "url": urls[idx],
                        "error": "fetch_failed",
                        "error_detail": f"{type(exc).__name__}: {exc}"[:200],
                    }
    except Exception:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": "internal_error", "error_type": "runtime_error"})
        return 1

    failed = sum(1 for c in competitors if c.get("error"))
    analyzed = len(competitors) - failed
    summary = _comparative_summary(your_product, competitors, api_key, model)

    meta: dict[str, Any] = {
        "analyzed": analyzed,
        "failed": failed,
        "dry_run": False,
        "cache_hit": False,
        "model": model,
    }
    if truncated_from:
        meta["warning"] = (
            f"Input had {truncated_from} URLs; capped at {MAX_URLS} to "
            "protect Gemini quota. Split into smaller batches to analyze more."
        )
        meta["input_urls"] = truncated_from
    result = {
        "competitors": competitors,
        "summary": summary,
        "meta": meta,
    }
    _emit({"ok": True, "outputs": result})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
