#!/usr/bin/env python3
"""
Lead Scorer — Floom demo app.

Takes a CSV of leads and an ICP description. For each row, asks Gemini 3 (with
native web search + URL context grounding) to research the company and return
a fit score 0-100, human-readable reasoning, and enriched fields.

Protocol (per apps/server/src/lib/entrypoint.py):
  argv[1] JSON: {"action": "score", "inputs": {"data": "/floom/inputs/data.csv", "icp": "..."}}
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

File inputs (file/csv) arrive as a path mounted read-only at /floom/inputs/
(see WORKPLAN-20260421-file-inputs-root-fix.md). If that mount is not present
(e.g. local dev before runtime plumbing ships), we also accept a raw CSV
string in the `data` input.

Model: gemini-3-flash-preview by default (fast, demo-grade). Override with
GEMINI_MODEL env var or `model` input (e.g. `gemini-3.1-pro-preview` for
deeper reasoning). No Claude, no OpenAI, no Gemini 2.x — enforced in code.
Fallback to dry-run (random scores) only if GEMINI_API_KEY is unset.

Sample-input cache: if the canonical input hash matches an entry in
`sample-cache.json`, return the frozen golden output immediately (<500ms).
Any other input falls through to a live Gemini call. See `canonical_input`
below for the hashing contract and `sample-cache.json` for the baked-in
responses.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import random
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

DEFAULT_MODEL_ID = "gemini-3-flash-preview"
# 2026-04-24: bumped default 8 → 32 (Gemini Flash paid tier is ~2000 RPM, so 32
# concurrent calls is safe). Tunable via FLOOM_APP_MAX_WORKERS env. See
# /root/floom-perf-investigation-2026-04-24.md — 168 rows × 3s / 32 ≈ 16s
# instead of ~63s on 8 workers.
MAX_WORKERS = int(os.environ.get("FLOOM_APP_MAX_WORKERS", "32"))
# Hard cap on input rows to protect Gemini quota + keep runtime bounded. Rows
# above the cap are truncated and a warning is included in the output.
MAX_ROWS = int(os.environ.get("FLOOM_APP_MAX_ROWS", "200"))
PER_CALL_TIMEOUT_S = 45

# Path to the pre-generated golden cache. Lives next to this file so the
# container image bundles it automatically.
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"

SYSTEM_PROMPT = """You are a B2B lead qualification analyst.

For the lead below, use web search and URL context tools to find:
- what the company does (product, industry)
- rough employee count / stage
- country or HQ region
- signals of fit with the ICP (hiring, funding, tech stack, customers)

Then return ONLY a JSON object (no markdown, no prose, no code fences) with:
{
  "score": <int 0-100, how well this lead matches the ICP>,
  "reasoning": "<2-3 sentences, plain English, cite concrete evidence>",
  "enriched_fields": {
    "industry": "<short>",
    "employee_range": "<e.g. 10-50, 50-200>",
    "country": "<ISO country or region>",
    "signal": "<one concrete buy signal or disqualifier>"
  }
}

Rules:
- Score strictly against the ICP. Default to lower scores unless evidence is strong.
- If you cannot verify the company at all, score 0-20 and say so in reasoning.
- Return ONLY the JSON object. No ```json fences. No extra keys."""


def _emit(payload: dict) -> None:
    """Write the single-line Floom result the runner parses."""
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[lead-scorer] {msg}", flush=True)


def _resolve_model(model_override: str | None = None) -> str:
    """Resolve the Gemini model. Env > explicit override > default. Enforce gemini-3.x.

    Precedence:
      1. GEMINI_MODEL env var (operator override)
      2. `model` input (creator override)
      3. DEFAULT_MODEL_ID
    """
    m = (os.environ.get("GEMINI_MODEL") or model_override or DEFAULT_MODEL_ID).strip()
    if not m.startswith("gemini-3"):
        raise SystemExit(
            f"refusing to run: model must be gemini-3.x (got '{m}')"
        )
    return m


def _read_data_bytes(data_input: str) -> bytes:
    """Return the raw bytes of the CSV input, whether it's a path or inline text.

    Used by `canonical_input` to hash the actual CSV content, so the cache
    keys remain stable whether the Floom runtime mounts a file or a direct
    caller passes the CSV string.
    """
    if os.path.isfile(data_input):
        with open(data_input, "rb") as f:
            return f.read()
    return data_input.encode("utf-8")


def _load_rows(data_input: str) -> list[dict[str, str]]:
    """Accept either a filesystem path or a raw CSV string."""
    if os.path.isfile(data_input):
        _log(f"reading CSV from path: {data_input}")
        with open(data_input, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))
    _log("treating `data` as inline CSV text (no file at that path)")
    return list(csv.DictReader(io.StringIO(data_input.strip())))


# ---------------------------------------------------------------------------
# Sample-input cache (the "instant" demo path)
# ---------------------------------------------------------------------------
def canonical_input(data: str, icp: str) -> str:
    """Deterministic string representation of the inputs.

    Contract:
      - CSV content is read as bytes (file path OR inline) and SHA-256'd to
        collapse large fixtures to a short, stable hex digest.
      - `icp` is stripped of leading/trailing whitespace and all internal
        newlines collapsed to single `\\n` (so cosmetic re-wrapping doesn't
        invalidate the cache).
      - The two parts are JSON-encoded with `sort_keys=True` so dict key
        ordering is never a source of drift.

    Returns a canonical JSON string; callers hash that string to get a
    cache key. Keeping canonicalization distinct from hashing makes it
    easy to debug a missed cache hit (just print the canonical string).
    """
    csv_bytes = _read_data_bytes(data)
    csv_hash = hashlib.sha256(csv_bytes).hexdigest()
    icp_normalized = "\n".join(
        line.rstrip() for line in icp.strip().splitlines() if line.strip()
    )
    payload = {"data_sha256": csv_hash, "icp": icp_normalized}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(data: str, icp: str) -> str:
    return hashlib.sha256(canonical_input(data, icp).encode("utf-8")).hexdigest()


def _load_sample_cache() -> dict[str, Any]:
    """Load the frozen golden cache, or {} if the file is missing."""
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


def _row_to_prompt(row: dict[str, str], icp: str) -> str:
    """Render the row as a human-readable block the model can search on."""
    lead_lines = [f"- {k}: {v}" for k, v in row.items() if v and v.strip()]
    lead_block = "\n".join(lead_lines) if lead_lines else "(empty row)"
    return (
        f"ICP (ideal customer profile):\n{icp.strip()}\n\n"
        f"Lead to score:\n{lead_block}\n\n"
        "Research this company using web search and URL context, then return the JSON."
    )


def _parse_json_answer(text: str) -> dict[str, Any]:
    """Strip optional code fences, parse JSON."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        # drop opening fence
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        # drop closing fence
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[:-3]
    cleaned = cleaned.strip()
    # some models prefix the object with a stray newline/word; find first {
    if not cleaned.startswith("{"):
        i = cleaned.find("{")
        if i >= 0:
            cleaned = cleaned[i:]
    return json.loads(cleaned)


def _dry_run_score(row: dict[str, str], icp: str) -> dict[str, Any]:
    """Used when GEMINI_API_KEY is missing. Deterministic-ish random score."""
    random.seed(json.dumps(row, sort_keys=True))
    score = random.randint(20, 95)
    return {
        "score": score,
        "reasoning": "DRY RUN (no GEMINI_API_KEY set). Random placeholder score.",
        "enriched_fields": {
            "industry": row.get("industry") or "unknown",
            "employee_range": row.get("employee_count") or "unknown",
            "country": row.get("country") or "unknown",
            "signal": "dry-run placeholder",
        },
    }


def _score_with_gemini(row: dict, icp: str, client, tools, model: str) -> dict[str, Any]:
    """Single scoring call. Retries once on rate limit."""
    from google.genai import errors as genai_errors  # type: ignore
    from google.genai.types import GenerateContentConfig  # type: ignore

    prompt = _row_to_prompt(row, icp)
    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        tools=tools,
        temperature=0.2,
    )

    for attempt in (1, 2):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=prompt,
                config=config,
            )
            text = (resp.text or "").strip()
            if not text:
                raise RuntimeError("empty response from Gemini")
            return _parse_json_answer(text)
        except genai_errors.APIError as exc:
            code = getattr(exc, "code", None)
            transient = code in (429, 500, 503) or "rate" in str(exc).lower()
            if attempt == 1 and transient:
                _log(f"rate limit / transient error, retrying once: {exc}")
                time.sleep(1.5)
                continue
            raise
        except json.JSONDecodeError:
            if attempt == 1:
                _log("JSON parse failed, retrying once")
                continue
            raise


def _build_genai():
    """Create a google-genai client + search/url-context tools. Returns (client, tools) or None on missing key."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai.types import Tool, GoogleSearch, UrlContext  # type: ignore
    except ImportError as exc:
        _log(f"google-genai not installed: {exc}")
        return None

    client = genai.Client(api_key=api_key)
    tools = [
        Tool(google_search=GoogleSearch()),
        Tool(url_context=UrlContext()),
    ]
    return client, tools


def score(data: str, icp: str, model: str | None = None, **_kwargs) -> dict[str, Any]:
    """
    Score each CSV row against the ICP using Gemini 3 with web search + URL context.

    Args:
      data:  path to a CSV file (/floom/inputs/data.csv) OR a raw CSV string.
      icp:   free-text ICP description.
      model: optional Gemini model override. Defaults to env GEMINI_MODEL
             or DEFAULT_MODEL_ID (gemini-3-flash-preview). Must be gemini-3.x.

    Returns:
      {total, scored, failed, rows: [...], score_distribution: {...}, dry_run: bool,
       cache_hit: bool, model: str}
    """
    if not icp or not icp.strip():
        raise ValueError("icp is required")

    resolved_model = _resolve_model(model)

    # Fast path: if the input exactly matches a baked-in sample, return the
    # pre-generated golden in <500ms. The golden was produced with
    # gemini-3.1-pro-preview for higher quality than a live Flash call.
    cache = _load_sample_cache()
    h = _input_hash(data, icp)
    if h in cache:
        _log(f"cache hit for input_hash={h[:12]}... (instant response)")
        cached = dict(cache[h])  # shallow copy so we don't mutate the loaded dict
        cached["cache_hit"] = True
        cached["dry_run"] = False
        # Preserve the golden's model field (pro-generated) so the UI chip
        # shows the truthful source of the cached output.
        cached.setdefault("model", "gemini-3.1-pro-preview (cached)")
        return cached

    rows = _load_rows(data)
    if not rows:
        return {
            "total": 0,
            "scored": 0,
            "failed": 0,
            "rows": [],
            "score_distribution": {},
            "dry_run": False,
            "cache_hit": False,
            "model": resolved_model,
        }
    truncated_from = 0
    if len(rows) > MAX_ROWS:
        truncated_from = len(rows)
        rows = rows[:MAX_ROWS]
        _log(
            f"input has {truncated_from} rows; capped to MAX_ROWS={MAX_ROWS} "
            "(raise FLOOM_APP_MAX_ROWS to override)"
        )
    _log(f"scoring {len(rows)} rows against ICP ({len(icp)} chars) with {resolved_model}")

    genai_bits = _build_genai()
    dry_run = genai_bits is None
    if dry_run:
        _log("DRY RUN: GEMINI_API_KEY missing or google-genai not installed. Returning random scores.")

    def _score_one(idx_row: tuple[int, dict]) -> dict:
        idx, row = idx_row
        base = {"#": idx + 1, **row}
        if dry_run:
            try:
                out = _dry_run_score(row, icp)
                return {**base, "status": "ok", **out}
            except Exception as exc:  # noqa: BLE001
                return {**base, "status": "error", "score": None, "reasoning": f"dry_run_failed: {exc}", "enriched_fields": {}}
        client, tools = genai_bits
        try:
            out = _score_with_gemini(row, icp, client, tools, resolved_model)
            # defensive: enforce shape
            if not isinstance(out.get("score"), (int, float)):
                raise ValueError(f"bad score field: {out!r}")
            out["score"] = max(0, min(100, int(out["score"])))
            out.setdefault("reasoning", "")
            out.setdefault("enriched_fields", {})
            return {**base, "status": "ok", **out}
        except Exception as exc:  # noqa: BLE001
            _log(f"row {idx+1} scoring_failed: {exc}")
            return {
                **base,
                "status": "error",
                "score": None,
                "reasoning": "scoring_failed",
                "enriched_fields": {},
                "error": str(exc)[:300],
            }

    results: list[dict] = [None] * len(rows)  # type: ignore
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(rows))) as pool:
        futures = {pool.submit(_score_one, (i, r)): i for i, r in enumerate(rows)}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                results[i] = fut.result(timeout=PER_CALL_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                _log(f"row {i+1} future failed: {exc}")
                results[i] = {
                    "#": i + 1,
                    **rows[i],
                    "status": "error",
                    "score": None,
                    "reasoning": "scoring_failed",
                    "enriched_fields": {},
                    "error": str(exc)[:300],
                }

    # Sort by score desc (nulls last), then original index.
    def _sort_key(r: dict) -> tuple:
        s = r.get("score")
        return (0 if s is None else 1, s or 0, -(r.get("#", 0)))

    ranked = sorted(results, key=_sort_key, reverse=True)

    # Distribution buckets.
    buckets = {"80-100": 0, "60-79": 0, "40-59": 0, "20-39": 0, "0-19": 0, "unscored": 0}
    for r in results:
        s = r.get("score")
        if s is None:
            buckets["unscored"] += 1
        elif s >= 80:
            buckets["80-100"] += 1
        elif s >= 60:
            buckets["60-79"] += 1
        elif s >= 40:
            buckets["40-59"] += 1
        elif s >= 20:
            buckets["20-39"] += 1
        else:
            buckets["0-19"] += 1

    scored = sum(1 for r in results if r.get("status") == "ok")
    failed = len(results) - scored

    out: dict[str, Any] = {
        "total": len(rows),
        "scored": scored,
        "failed": failed,
        "dry_run": dry_run,
        "cache_hit": False,
        "model": resolved_model if not dry_run else "dry-run",
        "rows": ranked,
        "score_distribution": buckets,
    }
    if truncated_from:
        out["warning"] = (
            f"Input had {truncated_from} rows; capped at {MAX_ROWS} to protect "
            "Gemini quota. Split into smaller batches to score more."
        )
        out["input_rows"] = truncated_from
    return out


# ---------------------------------------------------------------------------
# Standalone CLI (so the container can be run without the floom server).
# When imported by apps/server/src/lib/entrypoint.py the module exposes
# `score(...)` directly; the entrypoint handles argv parsing.
# This __main__ block is for `docker run ... '{"action":"score", ...}'` use.
# ---------------------------------------------------------------------------
def _cli() -> int:
    if len(sys.argv) < 2:
        _emit({"ok": False, "error": "Missing config argument (argv[1] JSON)", "error_type": "runtime_error"})
        return 1
    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        _emit({"ok": False, "error": f"Invalid config JSON: {exc}", "error_type": "runtime_error"})
        return 1

    action = config.get("action") or "score"
    inputs = config.get("inputs") or {}

    if action != "score":
        _emit({"ok": False, "error": f"Unknown action '{action}'. Only 'score' is supported.", "error_type": "invalid_action"})
        return 1

    try:
        out = score(**inputs)
        _emit({"ok": True, "outputs": out})
        return 0
    except Exception as exc:  # noqa: BLE001
        # Public-run safety: never emit raw tracebacks in the result payload
        # (they leak absolute filesystem paths and internal structure). The
        # full traceback still goes to stderr so the operator can debug.
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": str(exc), "error_type": "runtime_error"})
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
