#!/usr/bin/env python3
# Status: prepared, not yet registered in seedLaunchDemos. Add to DEMOS array there to publish.
"""
LinkedIn Profile Roaster -- Floom demo app.

Reads one JSON payload from argv[1]:
  {
    "action": "roast",
    "inputs": {
      "profile_text": "..."
    }
  }

Emits one JSON object on stdout with the Floom runner contract:
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

Uses one Gemini 2.5 Flash Lite call with response_json_schema enforcement.
If GEMINI_API_KEY is missing, falls back to a deterministic dry-run output.
Exact sample inputs are served from sample-cache.json.
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
HTTP_TIMEOUT_MS = int(os.environ.get("FLOOM_APP_HTTP_TIMEOUT_MS", "10500"))
TOTAL_BUDGET_S = 12.0
MIN_PROFILE_CHARS = 200
MAX_PROFILE_CHARS = 5000
MAX_EXCERPT_CHARS = 180
REWRITE_SECTIONS = ("headline", "about_intro", "experience_bullet")
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"

SYSTEM_PROMPT = (
    "You are a brutally honest LinkedIn coach in the style of an A+ recruiter. "
    "Tone: direct, specific, never mean. Roasts must reference actual phrases "
    "from the profile."
)

RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["roast", "rewrites", "top_tip"],
    "properties": {
        "roast": {
            "type": "array",
            "minItems": 3,
            "maxItems": 5,
            "items": {
                "type": "object",
                "required": ["observation", "sting"],
                "properties": {
                    "observation": {
                        "type": "string",
                        "description": "Specific observation tied to profile wording.",
                    },
                    "sting": {
                        "type": "string",
                        "description": "One-line ouch that is direct but not mean.",
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
                "required": ["section", "original_excerpt", "rewritten", "why_better"],
                "properties": {
                    "section": {
                        "type": "string",
                        "enum": list(REWRITE_SECTIONS),
                    },
                    "original_excerpt": {
                        "type": "string",
                    },
                    "rewritten": {
                        "type": "string",
                    },
                    "why_better": {
                        "type": "string",
                    },
                },
            },
        },
        "top_tip": {
            "type": "string",
            "description": "Single biggest improvement in one sentence.",
        },
    },
}


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[linkedin-roaster] {msg}", flush=True)


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = _normalize_whitespace(value)
    if not cleaned:
        raise ValueError(f"{field} must be non-empty")
    return cleaned


def _resolve_model() -> str:
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL_ID).strip()
    if not (model.startswith("gemini-2.5") or model.startswith("gemini-3")):
        raise SystemExit(
            f"refusing to run: GEMINI_MODEL must be gemini-2.5.x or gemini-3.x (got '{model}')"
        )
    return model


def _validate_profile_text(profile_text: Any) -> str:
    if not isinstance(profile_text, str):
        raise ValueError("profile_text must be text")
    normalized = _normalize_whitespace(profile_text)
    if len(normalized) < MIN_PROFILE_CHARS:
        raise ValueError(
            "Profile text is too short to roast. Paste at least 200 characters."
        )
    if len(normalized) > MAX_PROFILE_CHARS:
        raise ValueError(
            "Profile text is too long. Keep it under 5000 chars and focus on About plus 1-2 roles."
        )
    return normalized


def canonical_input(profile_text: str) -> str:
    payload = {"profile_text": _normalize_whitespace(profile_text)}
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(profile_text: str) -> str:
    return hashlib.sha256(canonical_input(profile_text).encode("utf-8")).hexdigest()


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


def _trim_excerpt(text: str) -> str:
    text = _normalize_whitespace(text)
    if len(text) <= MAX_EXCERPT_CHARS:
        return text
    return text[: MAX_EXCERPT_CHARS - 1].rstrip() + "..."


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text)
    sentences = [_normalize_whitespace(part) for part in parts if _normalize_whitespace(part)]
    return sentences


def _extract_excerpts(profile_text: str) -> list[str]:
    excerpts: list[str] = []
    for sentence in _split_sentences(profile_text):
        if len(sentence) < 25:
            continue
        excerpts.append(_trim_excerpt(sentence))
        if len(excerpts) == 6:
            break
    if not excerpts:
        excerpts.append(_trim_excerpt(profile_text))
    while len(excerpts) < 3:
        excerpts.append(excerpts[-1])
    return excerpts


def _infer_role(profile_text: str) -> str:
    lower = profile_text.lower()
    role_map = (
        ("founder", "Founder"),
        ("product manager", "Product Manager"),
        ("engineering manager", "Engineering Manager"),
        ("software engineer", "Software Engineer"),
        ("designer", "Product Designer"),
        ("marketer", "Growth Marketer"),
        ("sales", "Sales Leader"),
        ("recruit", "Recruiting Lead"),
    )
    for needle, role in role_map:
        if needle in lower:
            return role
    return "Operator"


def _dry_run_response(profile_text: str) -> dict[str, Any]:
    excerpts = _extract_excerpts(profile_text)
    role = _infer_role(profile_text)

    roast = [
        {
            "observation": f"You say \"{excerpts[0]}\" which sounds broad and unspecific.",
            "sting": "If every candidate can claim this, it is not a differentiator.",
        },
        {
            "observation": f"This line \"{excerpts[1]}\" talks activity, not measurable impact.",
            "sting": "Recruiters skim for outcomes, and this reads like a task list.",
        },
        {
            "observation": f"The phrasing in \"{excerpts[2]}\" is heavy on buzzwords and light on proof.",
            "sting": "Strong profile energy, weak evidence density.",
        },
    ]

    rewrites = [
        {
            "section": "headline",
            "original_excerpt": excerpts[0],
            "rewritten": (
                f"{role} | Turn ambiguous priorities into shipped outcomes with clear business impact"
            ),
            "why_better": "States role plus concrete value instead of generic self-description.",
        },
        {
            "section": "about_intro",
            "original_excerpt": excerpts[1],
            "rewritten": (
                "I build repeatable systems that improve decision speed, execution quality, and team trust."
            ),
            "why_better": "Leads with a specific value proposition and names outcomes readers care about.",
        },
        {
            "section": "experience_bullet",
            "original_excerpt": excerpts[2],
            "rewritten": (
                "Redesigned the workflow, cut handoff delays, and raised delivery reliability across the team."
            ),
            "why_better": "Uses action plus outcomes instead of vague responsibility language.",
        },
    ]

    return _normalize_response(
        {
            "roast": roast,
            "rewrites": rewrites,
            "top_tip": "Replace broad claims with one quantified result per section so your credibility is obvious at a glance.",
        }
    )


def _normalize_response(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Gemini payload must be an object")

    roast = payload.get("roast")
    if not isinstance(roast, list) or len(roast) < 3 or len(roast) > 5:
        raise ValueError("Gemini payload must include 3-5 roast items")
    normalized_roast: list[dict[str, str]] = []
    for idx, item in enumerate(roast):
        if not isinstance(item, dict):
            raise ValueError(f"roast[{idx}] must be an object")
        normalized_roast.append(
            {
                "observation": _required_string(
                    item.get("observation"), f"roast[{idx}].observation"
                ),
                "sting": _required_string(item.get("sting"), f"roast[{idx}].sting"),
            }
        )

    rewrites = payload.get("rewrites")
    if not isinstance(rewrites, list) or len(rewrites) != 3:
        raise ValueError("Gemini payload must include exactly 3 rewrites")

    by_section: dict[str, dict[str, str]] = {}
    for idx, item in enumerate(rewrites):
        if not isinstance(item, dict):
            raise ValueError(f"rewrites[{idx}] must be an object")
        section = item.get("section")
        if section not in REWRITE_SECTIONS:
            raise ValueError(f"rewrites[{idx}].section must be one of {REWRITE_SECTIONS}")
        if section in by_section:
            raise ValueError(f"duplicate rewrite section: {section}")
        by_section[section] = {
            "section": section,
            "original_excerpt": _required_string(
                item.get("original_excerpt"), f"rewrites[{idx}].original_excerpt"
            ),
            "rewritten": _required_string(item.get("rewritten"), f"rewrites[{idx}].rewritten"),
            "why_better": _required_string(
                item.get("why_better"), f"rewrites[{idx}].why_better"
            ),
        }

    if set(by_section) != set(REWRITE_SECTIONS):
        raise ValueError("Gemini payload must contain one rewrite for each required section")

    top_tip = _required_string(payload.get("top_tip"), "top_tip")
    if "\n" in top_tip:
        raise ValueError("top_tip must be a single sentence line")

    return {
        "roast": normalized_roast,
        "rewrites": [by_section[section] for section in REWRITE_SECTIONS],
        "top_tip": top_tip,
    }


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


def _roast_with_gemini(profile_text: str, client, model: str) -> dict[str, Any]:
    from google.genai.types import (  # type: ignore
        GenerateContentConfig,
        HttpOptions,
        HttpRetryOptions,
    )

    prompt = (
        "Profile text to analyze:\n"
        f"{profile_text}\n\n"
        "Return strictly valid JSON matching the schema.\n"
        "Rules:\n"
        "- roast must have 3 to 5 items\n"
        "- every roast.observation must quote or point to actual wording from the profile text\n"
        "- rewrites must contain exactly one item for each section: headline, about_intro, experience_bullet\n"
        "- original_excerpt must be copied from the profile text\n"
        "- rewritten must be concise and punchy\n"
        "- why_better must explain the upgrade in one sentence\n"
        "- top_tip must be exactly one sentence"
    )

    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.3,
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


def roast_profile(profile_text: str) -> dict[str, Any]:
    normalized_profile = _validate_profile_text(profile_text)

    cache = _load_sample_cache()
    input_hash = _input_hash(normalized_profile)
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
        outputs = _dry_run_response(normalized_profile)
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
    outputs = _normalize_response(_roast_with_gemini(normalized_profile, client, model))
    elapsed = time.monotonic() - start
    if elapsed > TOTAL_BUDGET_S:
        raise TimeoutError(f"linkedin roaster exceeded {TOTAL_BUDGET_S:.0f}s budget")
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
        key for key in inputs.keys() if key != "profile_text" and not str(key).startswith("_")
    )
    if extras:
        raise ValueError(
            "Only 'profile_text' is supported "
            f"(got: {', '.join(str(item) for item in extras)})"
        )
    if "profile_text" not in inputs:
        raise ValueError("profile_text is required")
    return {"profile_text": inputs.get("profile_text")}


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

    action = config.get("action") or "roast"
    inputs = config.get("inputs") or {}

    if action != "roast":
        _emit(
            {
                "ok": False,
                "error": f"Unknown action '{action}'. Only 'roast' is supported.",
                "error_type": "invalid_action",
            }
        )
        return 1

    try:
        out = roast_profile(**_sanitize_inputs(inputs))
        _emit({"ok": True, "outputs": out})
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": str(exc), "error_type": "runtime_error"})
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
