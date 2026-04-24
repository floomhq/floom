#!/usr/bin/env python3
"""
Pitch Coach -- Floom demo app.

Reads one JSON payload from argv[1]:
  {
    "action": "coach",
    "inputs": {
      "pitch": "We are a platform for AI apps that helps teams ship faster"
    }
  }

Emits one JSON object on stdout:
  {
    "harsh_truth": [
      {"critique": "...", "vc_reaction": "..."},
      {"critique": "...", "vc_reaction": "..."},
      {"critique": "...", "vc_reaction": "..."}
    ],
    "rewrites": [
      {"angle": "user-outcome", "pitch": "...", "when_to_use": "..."},
      {"angle": "market-size", "pitch": "...", "when_to_use": "..."},
      {"angle": "technical-moat", "pitch": "...", "when_to_use": "..."}
    ],
    "one_line_tldr": "...",
    "dry_run": false,
    "cache_hit": false,
    "model": "gemini-3-pro-preview"
  }

Floom runner contract:
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

Single Gemini 3 Pro call, no search tools, no external fetches. If
GEMINI_API_KEY is unset, falls back to a deterministic dry-run payload so the
demo still renders end-to-end. Exact sample inputs are served instantly from
sample-cache.json.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any

DEFAULT_MODEL_ID = "gemini-2.5-flash-lite"
# Benchmarked 2026-04-25: gemini-2.5-flash-lite with JSON schema returns in
# 1.4-2.1s on comparable prompts. Gemini enforces a 10s minimum request
# deadline at the API layer (reject <10000ms with INVALID_ARGUMENT), so we
# set 10500ms as a floor. Actual wall-clock is still 2-3s; TOTAL_BUDGET_S
# kicks in if the server is the bottleneck.
HTTP_TIMEOUT_MS = int(os.environ.get("FLOOM_APP_HTTP_TIMEOUT_MS", "10500"))
TOTAL_BUDGET_S = 8.0
MIN_PITCH_CHARS = 20
MAX_PITCH_CHARS = 500
REWRITE_ANGLES = ("user-outcome", "market-size", "technical-moat")
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"

SYSTEM_PROMPT = """You are a brutally honest but fair startup pitch coach.

Give specific feedback, not generic advice. Be direct, never cruel.
Focus on clarity, buyer, wedge, credibility, and investor-readiness.
Do not praise weak copy. Do not write an essay. Return only the JSON that
matches the provided schema."""

RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["harsh_truth", "rewrites", "one_line_tldr"],
    "properties": {
        "harsh_truth": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
                "type": "object",
                "required": ["critique", "vc_reaction"],
                "properties": {
                    "critique": {
                        "type": "string",
                        "description": "A short, specific flaw in the pitch.",
                    },
                    "vc_reaction": {
                        "type": "string",
                        "description": "One line describing the investor reaction.",
                    },
                },
            },
        },
        "rewrites": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
                "type": "object",
                "required": ["angle", "pitch", "when_to_use"],
                "properties": {
                    "angle": {
                        "type": "string",
                        "enum": list(REWRITE_ANGLES),
                    },
                    "pitch": {
                        "type": "string",
                        "description": "A tighter rewritten pitch.",
                    },
                    "when_to_use": {
                        "type": "string",
                        "description": "When that framing is the right one to use.",
                    },
                },
            },
        },
        "one_line_tldr": {
            "type": "string",
            "description": "One sentence naming the biggest issue.",
        },
    },
}


def _emit(payload: dict[str, Any]) -> None:
    """Write the single-line Floom result the runner parses."""
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[pitch-coach] {msg}", flush=True)


def _resolve_model() -> str:
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL_ID).strip()
    if not (model.startswith("gemini-2.5") or model.startswith("gemini-3")):
        raise SystemExit(
            f"refusing to run: GEMINI_MODEL must be gemini-2.5.x or gemini-3.x (got '{model}')"
        )
    return model


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def _validate_pitch(pitch: Any) -> str:
    if not isinstance(pitch, str):
        raise ValueError("pitch must be text")
    normalized = _normalize_whitespace(pitch)
    if len(normalized) < MIN_PITCH_CHARS:
        raise ValueError("not enough to critique")
    if len(normalized) > MAX_PITCH_CHARS:
        raise ValueError("keep it tight")
    return normalized


def canonical_input(pitch: str) -> str:
    """Deterministic string representation of the input pitch."""
    payload = {"pitch": _normalize_whitespace(pitch)}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(pitch: str) -> str:
    return hashlib.sha256(canonical_input(pitch).encode("utf-8")).hexdigest()


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


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = _normalize_whitespace(value)
    if not cleaned:
        raise ValueError(f"{field} must be non-empty")
    return cleaned


def _normalize_response(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Gemini payload must be an object")

    harsh_truth = payload.get("harsh_truth")
    if not isinstance(harsh_truth, list) or len(harsh_truth) != 3:
        raise ValueError("Gemini payload must contain exactly 3 harsh_truth items")
    normalized_harsh_truth: list[dict[str, str]] = []
    for item in harsh_truth:
        if not isinstance(item, dict):
            raise ValueError("harsh_truth items must be objects")
        normalized_harsh_truth.append(
            {
                "critique": _required_string(item.get("critique"), "harsh_truth.critique"),
                "vc_reaction": _required_string(
                    item.get("vc_reaction"), "harsh_truth.vc_reaction"
                ),
            }
        )

    rewrites = payload.get("rewrites")
    if not isinstance(rewrites, list) or len(rewrites) != 3:
        raise ValueError("Gemini payload must contain exactly 3 rewrites")
    by_angle: dict[str, dict[str, str]] = {}
    for item in rewrites:
        if not isinstance(item, dict):
            raise ValueError("rewrite items must be objects")
        angle = item.get("angle")
        if angle not in REWRITE_ANGLES:
            raise ValueError(f"invalid rewrite angle: {angle!r}")
        if angle in by_angle:
            raise ValueError(f"duplicate rewrite angle: {angle}")
        by_angle[angle] = {
            "angle": angle,
            "pitch": _required_string(item.get("pitch"), f"rewrites.{angle}.pitch"),
            "when_to_use": _required_string(
                item.get("when_to_use"), f"rewrites.{angle}.when_to_use"
            ),
        }
    if set(by_angle) != set(REWRITE_ANGLES):
        raise ValueError("Gemini payload must include one rewrite for each required angle")

    return {
        "harsh_truth": normalized_harsh_truth,
        "rewrites": [by_angle[angle] for angle in REWRITE_ANGLES],
        "one_line_tldr": _required_string(payload.get("one_line_tldr"), "one_line_tldr"),
    }


def _parse_json_answer(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[:-3]
    cleaned = cleaned.strip()
    if not cleaned.startswith("{"):
        idx = cleaned.find("{")
        if idx >= 0:
            cleaned = cleaned[idx:]
    return json.loads(cleaned)


def _mentions_specific_buyer(text: str) -> bool:
    buyer_terms = (
        "engineer",
        "engineering",
        "developer",
        "product",
        "founder",
        "sales",
        "recruit",
        "marketer",
        "finance",
        "cfo",
        "cto",
        "designer",
        "support",
        "operations",
        "ops",
        "security",
        "hr",
    )
    return any(term in text for term in buyer_terms)


def _has_technical_wedge(text: str) -> bool:
    wedge_terms = (
        "api",
        "openapi",
        "runtime",
        "workflow",
        "infrastructure",
        "infra",
        "pipeline",
        "automation",
        "agent",
        "evaluation",
        "orchestration",
        "deployment",
        "data",
    )
    return any(term in text for term in wedge_terms)


def _guess_audience(text: str) -> str:
    if "sales" in text:
        return "sales teams"
    if "recruit" in text or "hiring" in text:
        return "recruiting teams"
    if "finance" in text or "cfo" in text:
        return "finance teams"
    if "marketer" in text or "marketing" in text:
        return "marketing teams"
    if "support" in text:
        return "support teams"
    if "founder" in text:
        return "founders"
    if "engineer" in text or "developer" in text:
        return "engineering teams"
    if "team" in text:
        return "product and engineering teams"
    return "teams"


def _guess_domain(text: str) -> str:
    if "ai app" in text:
        return "AI apps"
    if "sales" in text:
        return "sales workflows"
    if "recruit" in text or "hiring" in text:
        return "hiring workflows"
    if "finance" in text or "cfo" in text:
        return "finance workflows"
    if "developer" in text or "engineer" in text:
        return "developer workflows"
    return "new products"


def _dry_run_response(pitch: str) -> dict[str, Any]:
    lower = pitch.lower()
    audience = _guess_audience(lower)
    domain = _guess_domain(lower)

    critique_pool: list[dict[str, str]] = []
    if any(term in lower for term in ("platform", "solution", "ecosystem", "tool")):
        critique_pool.append(
            {
                "critique": "vague claim",
                "vc_reaction": "I hear category words, but I still cannot picture the product.",
            }
        )
    if not _mentions_specific_buyer(lower):
        critique_pool.append(
            {
                "critique": "unclear buyer",
                "vc_reaction": "If everyone is the user, I still do not know who writes the check.",
            }
        )
    if any(term in lower for term in ("faster", "better", "easier", "simpler")) or not re.search(
        r"\d", lower
    ):
        critique_pool.append(
            {
                "critique": "generic promise",
                "vc_reaction": "A speed claim without a concrete before-and-after sounds like marketing copy.",
            }
        )
    if not _has_technical_wedge(lower):
        critique_pool.append(
            {
                "critique": "missing wedge",
                "vc_reaction": "I do not hear why this is defensible instead of a feature.",
            }
        )
    critique_pool.append(
        {
            "critique": "no market frame",
            "vc_reaction": "I still do not know why this market is big enough right now.",
        }
    )
    critique_pool.append(
        {
            "critique": "blurry outcome",
            "vc_reaction": "I get the direction, but not the concrete result for the user.",
        }
    )
    critique_pool.append(
        {
            "critique": "low urgency",
            "vc_reaction": "I do not yet feel a painful problem that forces adoption.",
        }
    )

    harsh_truth: list[dict[str, str]] = []
    seen_critiques: set[str] = set()
    for item in critique_pool:
        critique = item["critique"]
        if critique in seen_critiques:
            continue
        seen_critiques.add(critique)
        harsh_truth.append(item)
        if len(harsh_truth) == 3:
            break

    if domain == "AI apps":
        user_outcome_pitch = (
            f"We help {audience} turn AI app ideas into shipped products in days instead of weeks."
        )
        market_size_pitch = (
            "Every software team is racing to ship AI products; we give them a faster path from prototype to production."
        )
        technical_moat_pitch = (
            "Our runtime turns one API-defined workflow into a deployable AI app, so teams ship faster without rebuilding the same plumbing."
        )
    else:
        user_outcome_pitch = (
            f"We help {audience} turn ideas into shipped {domain} in days instead of weeks."
        )
        market_size_pitch = (
            f"The market for {domain} is getting more competitive; we give {audience} a faster path from prototype to production."
        )
        technical_moat_pitch = (
            f"Our product handles the hard infrastructure behind {domain}, so {audience} ship faster without stitching together brittle tooling."
        )

    rewrites = [
        {
            "angle": "user-outcome",
            "pitch": user_outcome_pitch,
            "when_to_use": "Use this when the listener cares most about time-to-value and a concrete user benefit.",
        },
        {
            "angle": "market-size",
            "pitch": market_size_pitch,
            "when_to_use": "Use this when you need to explain the category, urgency, and why now.",
        },
        {
            "angle": "technical-moat",
            "pitch": technical_moat_pitch,
            "when_to_use": "Use this when the room is skeptical and wants a sharper wedge or defensibility story.",
        },
    ]

    tldr = (
        "The pitch hints at the category, but it hides the buyer and wedge behind generic language."
    )
    return _normalize_response(
        {
            "harsh_truth": harsh_truth,
            "rewrites": rewrites,
            "one_line_tldr": tldr,
        }
    )


def _build_genai():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
    except ImportError as exc:
        _log(f"google-genai not installed: {exc}")
        return None
    return genai.Client(api_key=api_key)


def _coach_with_gemini(pitch: str, client, model: str) -> dict[str, Any]:
    from google.genai.types import (  # type: ignore
        GenerateContentConfig,
        HttpOptions,
        HttpRetryOptions,
    )

    prompt = (
        f"Pitch:\n{pitch}\n\n"
        "Return exactly three harsh truths and exactly three rewrites.\n"
        "The three rewrite angles must be user-outcome, market-size, and technical-moat.\n"
        "Be honest and specific, not mean.\n"
        "Each VC reaction must be a single line.\n"
        "The TL;DR must be one sentence naming the biggest issue."
    )

    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.2,
        max_output_tokens=1024,
        response_mime_type="application/json",
        response_json_schema=RESPONSE_JSON_SCHEMA,
        http_options=HttpOptions(
            timeout=HTTP_TIMEOUT_MS,
            retry_options=HttpRetryOptions(attempts=1),
        ),
    )
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=config,
    )

    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, dict):
        return parsed
    if hasattr(parsed, "model_dump"):
        return parsed.model_dump()

    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("empty response from Gemini")
    return _parse_json_answer(text)


def coach(pitch: str) -> dict[str, Any]:
    """Critique one pitch and return strict structured JSON."""
    normalized_pitch = _validate_pitch(pitch)

    cache = _load_sample_cache()
    input_hash = _input_hash(normalized_pitch)
    if input_hash in cache:
        _log(f"cache hit for input_hash={input_hash[:12]}... (instant response)")
        cached = dict(cache[input_hash])
        cached["cache_hit"] = True
        cached["dry_run"] = False
        cached.setdefault("model", "sample-fixture (cached)")
        return cached

    start = time.monotonic()
    client = _build_genai()
    if client is None:
        outputs = _dry_run_response(normalized_pitch)
        elapsed = time.monotonic() - start
        _log(f"done in {elapsed:.2f}s")
        return {
            **outputs,
            "dry_run": True,
            "cache_hit": False,
            "model": "dry-run",
        }

    model = _resolve_model()
    _log("calling Gemini")
    outputs = _normalize_response(_coach_with_gemini(normalized_pitch, client, model))
    elapsed = time.monotonic() - start
    if elapsed > TOTAL_BUDGET_S:
        raise TimeoutError(f"pitch coach exceeded {TOTAL_BUDGET_S:.0f}s budget")
    _log(f"done in {elapsed:.2f}s")
    return {
        **outputs,
        "dry_run": False,
        "cache_hit": False,
        "model": model,
    }


def _sanitize_inputs(inputs: Any) -> dict[str, Any]:
    if not isinstance(inputs, dict):
        raise ValueError("inputs must be an object")
    extras = sorted(
        key for key in inputs.keys() if key != "pitch" and not str(key).startswith("_")
    )
    if extras:
        raise ValueError(f"Only 'pitch' is supported (got: {', '.join(extras)})")
    if "pitch" not in inputs:
        raise ValueError("pitch is required")
    return {"pitch": inputs.get("pitch")}


def _cli() -> int:
    if len(sys.argv) < 2:
        _emit(
            {
                "ok": False,
                "error": "Missing config argument (argv[1] JSON)",
                "error_type": "runtime_error",
            }
        )
        return 1
    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        _emit(
            {
                "ok": False,
                "error": f"Invalid config JSON: {exc}",
                "error_type": "runtime_error",
            }
        )
        return 1

    action = config.get("action") or "coach"
    inputs = config.get("inputs") or {}

    if action != "coach":
        _emit(
            {
                "ok": False,
                "error": f"Unknown action '{action}'. Only 'coach' is supported.",
                "error_type": "invalid_action",
            }
        )
        return 1

    try:
        out = coach(**_sanitize_inputs(inputs))
        _emit({"ok": True, "outputs": out})
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": str(exc), "error_type": "runtime_error"})
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
