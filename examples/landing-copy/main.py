#!/usr/bin/env python3
"""
Landing Copy -- Floom demo app.

Accepts either:
1) Floom runner config JSON in argv[1]
2) Raw app idea text in argv[1] (quick local test mode)

Floom runner contract:
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}
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

# Status: prepared, not yet registered in seedLaunchDemos.
DEFAULT_MODEL_ID = "gemini-2.5-flash-lite"
HTTP_TIMEOUT_MS = int(os.environ.get("FLOOM_APP_HTTP_TIMEOUT_MS", "10500"))
TOTAL_BUDGET_S = 8.0
MIN_APP_IDEA_CHARS = 20
MAX_APP_IDEA_CHARS = 500
MAX_AUDIENCE_CHARS = 100
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"

BANNED_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bai[- ]powered\b", re.IGNORECASE), "AI-powered"),
    (re.compile(r"\bleverag\w*\b", re.IGNORECASE), "leverag*"),
    (re.compile(r"\brevolutioniz\w*\b", re.IGNORECASE), "revolutioniz*"),
    (re.compile(r"\btransform\w*\b", re.IGNORECASE), "transform*"),
    (re.compile(r"\brobust\b", re.IGNORECASE), "robust"),
    (re.compile(r"\bseamless\b", re.IGNORECASE), "seamless"),
    (re.compile(r"\bcutting[- ]edge\b", re.IGNORECASE), "cutting-edge"),
    (re.compile(r"\bnext[- ]gen\b", re.IGNORECASE), "next-gen"),
)

SYSTEM_PROMPT = """Write conversion-focused landing page copy.

Style: Linear, Raycast, Vercel, Arc.
Tone: punchy, modern, benefit-led, concrete.

Hard bans: no AI buzzwords and no hype language.
Never use: AI-powered, leverage/leverage*, revolutionize/revolutionary,
transform/transformative, robust, seamless, cutting-edge, next-gen.
Do not write "platform for X" headlines.

Output must make the product understandable in 5 seconds.
Return only JSON matching the schema."""

RESPONSE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": [
        "h1",
        "sub",
        "bullets",
        "primary_cta",
        "secondary_cta",
        "social_proof_line",
        "alternates",
    ],
    "properties": {
        "h1": {
            "type": "string",
            "description": "3-9 words. Hero headline. Benefit-led.",
        },
        "sub": {
            "type": "string",
            "description": "One sentence. Concrete. Names the user.",
        },
        "bullets": {
            "type": "array",
            "minItems": 3,
            "maxItems": 3,
            "items": {
                "type": "object",
                "required": ["label", "copy"],
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "2-4 word kicker.",
                    },
                    "copy": {
                        "type": "string",
                        "description": "One sentence describing what it does.",
                    },
                },
            },
        },
        "primary_cta": {
            "type": "string",
            "description": "2-4 words.",
        },
        "secondary_cta": {
            "type": "string",
            "description": "2-4 words.",
        },
        "social_proof_line": {
            "type": "string",
            "description": "One sentence, max 14 words.",
        },
        "alternates": {
            "type": "array",
            "minItems": 2,
            "maxItems": 2,
            "items": {
                "type": "string",
                "description": "Alternate H1 option, 3-9 words.",
            },
        },
    },
}


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[landing-copy] {msg}", flush=True)


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip())


def _word_count(text: str) -> int:
    return len([part for part in re.split(r"\s+", text.strip()) if part])


def _sentence_count(text: str) -> int:
    return len([m.group(0) for m in re.finditer(r"[.!?]+", text)])


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned = _normalize_whitespace(value)
    if not cleaned:
        raise ValueError(f"{field} must be non-empty")
    return cleaned


def _validate_words(text: str, min_words: int, max_words: int, field: str) -> None:
    count = _word_count(text)
    if count < min_words or count > max_words:
        raise ValueError(f"{field} must be {min_words}-{max_words} words")


def _validate_single_sentence(text: str, field: str) -> None:
    count = _sentence_count(text)
    if count != 1:
        raise ValueError(f"{field} must be exactly one sentence")


def _assert_buzzword_free(text: str, field: str) -> None:
    for pattern, label in BANNED_PATTERNS:
        if pattern.search(text):
            raise ValueError(f"{field} contains banned term ({label})")


def _assert_no_platform_headline(text: str, field: str) -> None:
    if re.search(r"\bplatform for\b", text, flags=re.IGNORECASE):
        raise ValueError(f"{field} contains banned cliché ('platform for')")


def _validate_app_idea(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("app_idea must be text")
    normalized = _normalize_whitespace(value)
    if len(normalized) < MIN_APP_IDEA_CHARS:
        raise ValueError("app_idea must be at least 20 chars")
    if len(normalized) > MAX_APP_IDEA_CHARS:
        raise ValueError("app_idea must be <=500 chars")
    return normalized


def _validate_audience(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("audience must be text")
    normalized = _normalize_whitespace(value)
    if len(normalized) > MAX_AUDIENCE_CHARS:
        raise ValueError("audience must be <=100 chars")
    return normalized


def canonical_input(app_idea: str, audience: str) -> str:
    payload = {
        "app_idea": _normalize_whitespace(app_idea),
        "audience": _normalize_whitespace(audience),
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(app_idea: str, audience: str) -> str:
    payload = canonical_input(app_idea, audience)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


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


def _normalize_response(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Gemini payload must be an object")

    h1 = _required_string(payload.get("h1"), "h1")
    _validate_words(h1, 3, 9, "h1")
    _assert_buzzword_free(h1, "h1")
    _assert_no_platform_headline(h1, "h1")

    sub = _required_string(payload.get("sub"), "sub")
    _validate_single_sentence(sub, "sub")
    _assert_buzzword_free(sub, "sub")

    bullets = payload.get("bullets")
    if not isinstance(bullets, list) or len(bullets) != 3:
        raise ValueError("bullets must contain exactly 3 items")
    normalized_bullets: list[dict[str, str]] = []
    for idx, item in enumerate(bullets):
        if not isinstance(item, dict):
            raise ValueError("bullet items must be objects")
        label = _required_string(item.get("label"), f"bullets[{idx}].label")
        copy = _required_string(item.get("copy"), f"bullets[{idx}].copy")
        _validate_words(label, 2, 4, f"bullets[{idx}].label")
        _validate_single_sentence(copy, f"bullets[{idx}].copy")
        _assert_buzzword_free(label, f"bullets[{idx}].label")
        _assert_buzzword_free(copy, f"bullets[{idx}].copy")
        normalized_bullets.append({"label": label, "copy": copy})

    primary_cta = _required_string(payload.get("primary_cta"), "primary_cta")
    _validate_words(primary_cta, 2, 4, "primary_cta")
    _assert_buzzword_free(primary_cta, "primary_cta")

    secondary_cta = _required_string(payload.get("secondary_cta"), "secondary_cta")
    _validate_words(secondary_cta, 2, 4, "secondary_cta")
    _assert_buzzword_free(secondary_cta, "secondary_cta")

    social_proof_line = _required_string(payload.get("social_proof_line"), "social_proof_line")
    _validate_single_sentence(social_proof_line, "social_proof_line")
    if _word_count(social_proof_line) > 14:
        raise ValueError("social_proof_line must be <=14 words")
    _assert_buzzword_free(social_proof_line, "social_proof_line")

    alternates = payload.get("alternates")
    if not isinstance(alternates, list) or len(alternates) != 2:
        raise ValueError("alternates must contain exactly 2 items")
    normalized_alternates: list[str] = []
    for idx, alt in enumerate(alternates):
        alt_text = _required_string(alt, f"alternates[{idx}]")
        _validate_words(alt_text, 3, 9, f"alternates[{idx}]")
        _assert_buzzword_free(alt_text, f"alternates[{idx}]")
        _assert_no_platform_headline(alt_text, f"alternates[{idx}]")
        normalized_alternates.append(alt_text)

    return {
        "h1": h1,
        "sub": sub,
        "bullets": normalized_bullets,
        "primary_cta": primary_cta,
        "secondary_cta": secondary_cta,
        "social_proof_line": social_proof_line,
        "alternates": normalized_alternates,
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


def _resolve_model() -> str:
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL_ID).strip()
    if not model.startswith("gemini-2.5"):
        raise ValueError(f"GEMINI_MODEL must be gemini-2.5.x (got '{model}')")
    return model


def _guess_audience(app_idea: str) -> str:
    lower = app_idea.lower()
    if "founder" in lower:
        return "founders"
    if "indie" in lower:
        return "indie hackers"
    if "sales" in lower or "lead" in lower:
        return "sales and ops teams"
    if "developer" in lower or "engineer" in lower:
        return "developers"
    if "ops" in lower or "operations" in lower:
        return "ops teams"
    return "early teams"


def _dry_run_response(app_idea: str, audience: str) -> dict[str, Any]:
    resolved_audience = audience or _guess_audience(app_idea)
    return _normalize_response(
        {
            "h1": "Turn inbound leads into revenue",
            "sub": f"{resolved_audience.capitalize()} qualify the right prospects in minutes, not hours.",
            "bullets": [
                {
                    "label": "Paste lead details",
                    "copy": "Drop in a lead and get an instant fit score against your ICP.",
                },
                {
                    "label": "See clear rationale",
                    "copy": "Get a short breakdown of why each lead is a fit or a pass.",
                },
                {
                    "label": "Prioritize follow up",
                    "copy": "Route high-fit leads first so your team spends time where it converts.",
                },
            ],
            "primary_cta": "Try it free",
            "secondary_cta": "See scoring flow",
            "social_proof_line": "Used by 200+ early founders to triage inbound faster.",
            "alternates": [
                "Know which leads deserve your time",
                "Score every lead before your first call",
            ],
        }
    )


def _generate_with_gemini(app_idea: str, audience: str, client, model: str) -> dict[str, Any]:
    from google.genai.types import (  # type: ignore
        GenerateContentConfig,
        HttpOptions,
        HttpRetryOptions,
    )

    resolved_audience = audience or "infer from the app idea"
    prompt = (
        "Write landing copy in the style of Linear, Raycast, Vercel, Arc. "
        "Punchy, benefit-led, no buzzwords (no AI-powered, no revolutionary, "
        "no leveraging, no synergy). The user pasted their idea. Output should "
        "make THEIR product clear in 5 seconds.\n\n"
        f"App idea:\n{app_idea}\n\n"
        f"Audience:\n{resolved_audience}\n\n"
        "Constraints:\n"
        "- h1: 3-9 words, benefit-led, no clichés\n"
        "- sub: one sentence, concrete, names the user\n"
        "- bullets: exactly 3 items, each label 2-4 words and copy one sentence\n"
        "- primary_cta and secondary_cta: 2-4 words each\n"
        "- social_proof_line: one sentence, <=14 words; if no real metric is known, "
        "use a transparent placeholder such as 'Used by 200+ early founders'\n"
        "- alternates: exactly 2 alternate H1 options\n"
        "- never use these banned terms: AI-powered, leverag*, revolutioniz*, "
        "transform*, robust, seamless, cutting-edge, next-gen\n"
    )

    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.35,
        max_output_tokens=700,
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


def generate(app_idea: str, audience: str = "") -> dict[str, Any]:
    normalized_idea = _validate_app_idea(app_idea)
    normalized_audience = _validate_audience(audience)

    cache = _load_sample_cache()
    input_hash = _input_hash(normalized_idea, normalized_audience)
    if input_hash in cache:
        _log(f"cache hit for input_hash={input_hash[:12]}... (instant response)")
        cached = dict(cache[input_hash])
        cached["cache_hit"] = True
        cached["dry_run"] = False
        cached.setdefault("model", "sample-fixture")
        return _normalize_response(cached) | {
            "cache_hit": cached["cache_hit"],
            "dry_run": cached["dry_run"],
            "model": cached["model"],
        }

    start = time.monotonic()
    client = _build_genai()
    if client is None:
        outputs = _dry_run_response(normalized_idea, normalized_audience)
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
    outputs = _normalize_response(
        _generate_with_gemini(normalized_idea, normalized_audience, client, model)
    )
    elapsed = time.monotonic() - start
    if elapsed > TOTAL_BUDGET_S:
        raise TimeoutError(f"landing-copy exceeded {TOTAL_BUDGET_S:.0f}s budget")
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
        key
        for key in inputs.keys()
        if key not in {"app_idea", "audience"} and not str(key).startswith("_")
    )
    if extras:
        raise ValueError(
            f"Only 'app_idea' and optional 'audience' are supported (got: {', '.join(extras)})"
        )
    if "app_idea" not in inputs:
        raise ValueError("app_idea is required")
    return {
        "app_idea": inputs.get("app_idea"),
        "audience": inputs.get("audience", ""),
    }


def _parse_invocation(argv_value: str) -> tuple[dict[str, Any], bool]:
    quick_mode = False
    try:
        parsed = json.loads(argv_value)
    except json.JSONDecodeError:
        quick_mode = True
        return ({"action": "generate", "inputs": {"app_idea": argv_value}}, quick_mode)

    if isinstance(parsed, dict) and ("action" in parsed or "inputs" in parsed):
        return (parsed, quick_mode)
    if isinstance(parsed, dict) and "app_idea" in parsed:
        quick_mode = True
        return ({"action": "generate", "inputs": parsed}, quick_mode)

    quick_mode = True
    return ({"action": "generate", "inputs": {"app_idea": argv_value}}, quick_mode)


def _cli() -> int:
    if len(sys.argv) < 2:
        _emit(
            {
                "ok": False,
                "error": "Missing config argument (argv[1] JSON or app_idea text)",
                "error_type": "runtime_error",
            }
        )
        return 1

    config, quick_mode = _parse_invocation(sys.argv[1])
    action = config.get("action") or "generate"
    inputs = config.get("inputs") or {}

    if action != "generate":
        _emit(
            {
                "ok": False,
                "error": f"Unknown action '{action}'. Only 'generate' is supported.",
                "error_type": "invalid_action",
            }
        )
        return 1

    try:
        out = generate(**_sanitize_inputs(inputs))
        if quick_mode:
            print(json.dumps(out, ensure_ascii=False), flush=True)
        _emit({"ok": True, "outputs": out})
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": str(exc), "error_type": "runtime_error"})
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
