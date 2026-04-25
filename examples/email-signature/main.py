#!/usr/bin/env python3
# Status: prepared, not yet registered in seedLaunchDemos.
"""
Email Signature Generator -- Floom demo app.

Reads one JSON payload from argv[1]:
  {
    "action": "generate",
    "inputs": {
      "full_name": "Jane Doe",
      "title": "Founder",
      "company": "Acme",
      "email": "jane@acme.com",
      "phone": "+1 415 555 0101",
      "calendar_url": "https://cal.example.com/jane",
      "website_url": "https://acme.com",
      "linkedin_url": "https://linkedin.com/in/janedoe",
      "tagline_mode": "none"
    }
  }

Emits one JSON object on stdout:
  {
    "html": "...",
    "plaintext": "...",
    "markdown": "...",
    "meta": {
      "has_tagline": false,
      "tagline_source": "none",
      "made_with_floom": "https://floom.dev/p/email-signature"
    }
  }

Floom runner contract:
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

The default path is fully deterministic and offline. If tagline_mode='ai', the app
makes one Gemini call (gemini-2.5-flash-lite) to generate a short professional
(tagline <=80 chars) and still returns deterministic output structure.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_HTTP_TIMEOUT_MS = int(os.environ.get("FLOOM_APP_HTTP_TIMEOUT_MS", "10500"))
AI_BUDGET_S = 4.0
SAMPLE_CACHE_PATH = Path(__file__).parent / "sample-cache.json"

FOOTER_URL = "https://floom.dev/p/email-signature"
FOOTER_TEXT = "Made with Floom · floom.dev/p/email-signature"

NAME_MIN_LEN = 2
NAME_MAX_LEN = 80
TEXT_MAX_LEN = 80
PHONE_MAX_LEN = 30
TAGLINE_MAX_LEN = 80

INPUT_FIELDS = {
    "full_name",
    "title",
    "company",
    "email",
    "phone",
    "calendar_url",
    "website_url",
    "linkedin_url",
    "tagline_mode",
}

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

TAGLINE_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["tagline"],
    "additionalProperties": False,
    "properties": {
        "tagline": {
            "type": "string",
            "description": "One short professional email-signature tagline.",
            "maxLength": TAGLINE_MAX_LEN,
        }
    },
}

SYSTEM_PROMPT = (
    "You write concise professional email-signature taglines. "
    "Return JSON only, matching the schema."
)


class InputError(ValueError):
    """Raised for invalid inputs."""


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(f"[email-signature] {msg}", flush=True)


def _normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def _required_text(value: Any, field: str, min_len: int, max_len: int) -> str:
    if not isinstance(value, str):
        raise InputError(f"{field} must be a string")
    cleaned = _normalize_whitespace(value)
    if len(cleaned) < min_len or len(cleaned) > max_len:
        raise InputError(f"{field} must be {min_len}-{max_len} chars")
    return cleaned


def _optional_text(value: Any, field: str, max_len: int) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise InputError(f"{field} must be a string")
    cleaned = _normalize_whitespace(value)
    if len(cleaned) > max_len:
        raise InputError(f"{field} must be <= {max_len} chars")
    return cleaned


def _optional_email(value: Any) -> str:
    email_value = _optional_text(value, "email", TEXT_MAX_LEN)
    if not email_value:
        return ""
    if not EMAIL_RE.match(email_value):
        raise InputError("email must be a valid email address")
    return email_value


def _optional_https_url(value: Any, field: str) -> str:
    url_value = _optional_text(value, field, 2048)
    if not url_value:
        return ""
    parsed = urlparse(url_value)
    if parsed.scheme.lower() != "https" or not parsed.netloc:
        raise InputError(f"{field} must be an HTTPS URL")
    return url_value


def _optional_linkedin_url(value: Any) -> str:
    linkedin_url = _optional_https_url(value, "linkedin_url")
    if not linkedin_url:
        return ""
    if "linkedin.com" not in linkedin_url.lower():
        raise InputError("linkedin_url must contain 'linkedin.com'")
    return linkedin_url


def _sanitize_inputs(inputs: Any) -> dict[str, str]:
    if not isinstance(inputs, dict):
        raise InputError("inputs must be an object")

    extras = sorted(
        key for key in inputs.keys() if key not in INPUT_FIELDS and not str(key).startswith("_")
    )
    if extras:
        raise InputError(f"Unsupported inputs: {', '.join(extras)}")

    full_name = _required_text(inputs.get("full_name"), "full_name", NAME_MIN_LEN, NAME_MAX_LEN)
    title = _optional_text(inputs.get("title"), "title", TEXT_MAX_LEN)
    company = _optional_text(inputs.get("company"), "company", TEXT_MAX_LEN)
    email_value = _optional_email(inputs.get("email"))
    phone = _optional_text(inputs.get("phone"), "phone", PHONE_MAX_LEN)
    calendar_url = _optional_https_url(inputs.get("calendar_url"), "calendar_url")
    website_url = _optional_https_url(inputs.get("website_url"), "website_url")
    linkedin_url = _optional_linkedin_url(inputs.get("linkedin_url"))

    tagline_mode_raw = inputs.get("tagline_mode", "none")
    if tagline_mode_raw is None:
        tagline_mode_raw = "none"
    if not isinstance(tagline_mode_raw, str):
        raise InputError("tagline_mode must be a string")
    tagline_mode = tagline_mode_raw.strip().lower() or "none"
    if tagline_mode not in {"none", "ai"}:
        raise InputError("tagline_mode must be 'none' or 'ai'")

    return {
        "full_name": full_name,
        "title": title,
        "company": company,
        "email": email_value,
        "phone": phone,
        "calendar_url": calendar_url,
        "website_url": website_url,
        "linkedin_url": linkedin_url,
        "tagline_mode": tagline_mode,
    }


def canonical_input(inputs: dict[str, str]) -> str:
    payload = {
        "calendar_url": inputs["calendar_url"],
        "company": inputs["company"],
        "email": inputs["email"],
        "full_name": inputs["full_name"],
        "linkedin_url": inputs["linkedin_url"],
        "phone": inputs["phone"],
        "tagline_mode": inputs["tagline_mode"],
        "title": inputs["title"],
        "website_url": inputs["website_url"],
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _input_hash(inputs: dict[str, str]) -> str:
    return hashlib.sha256(canonical_input(inputs).encode("utf-8")).hexdigest()


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


def _resolve_model() -> str:
    model = (os.environ.get("GEMINI_MODEL") or DEFAULT_GEMINI_MODEL).strip()
    if not model.startswith("gemini-2.5"):
        raise RuntimeError(f"GEMINI_MODEL must be gemini-2.5.x (got '{model}')")
    return model


def _build_genai_client():
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is required when tagline_mode='ai'")
    try:
        from google import genai  # type: ignore
    except ImportError as exc:  # pragma: no cover - import path depends on env
        raise RuntimeError(f"google-genai is not installed: {exc}") from exc
    return genai.Client(api_key=api_key)


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


def _normalize_tagline(value: Any) -> str:
    if not isinstance(value, str):
        raise RuntimeError("Gemini response must include a string 'tagline'")
    cleaned = _normalize_whitespace(value).strip('"')
    if not cleaned:
        raise RuntimeError("Gemini returned an empty tagline")
    if len(cleaned) > TAGLINE_MAX_LEN:
        raise RuntimeError(f"Gemini tagline exceeds {TAGLINE_MAX_LEN} chars")
    return cleaned


def _generate_ai_tagline(full_name: str, title: str, company: str) -> str:
    from google.genai.types import (  # type: ignore
        GenerateContentConfig,
        HttpOptions,
        HttpRetryOptions,
    )

    role_phrase = title or "professional"
    company_phrase = company or "company"

    prompt = (
        "Write one concise professional email-signature tagline. "
        "It must be <=80 characters and plain text only. "
        "Avoid hype, emojis, and punctuation-heavy slogans.\n\n"
        f"Full name: {full_name}\n"
        f"Title: {role_phrase}\n"
        f"Company: {company_phrase}\n"
    )

    client = _build_genai_client()
    model = _resolve_model()
    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.2,
        max_output_tokens=120,
        response_mime_type="application/json",
        response_json_schema=TAGLINE_JSON_SCHEMA,
        http_options=HttpOptions(
            timeout=GEMINI_HTTP_TIMEOUT_MS,
            retry_options=HttpRetryOptions(attempts=1),
        ),
    )
    response = client.models.generate_content(model=model, contents=prompt, config=config)

    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, dict):
        return _normalize_tagline(parsed.get("tagline"))
    if hasattr(parsed, "model_dump"):
        return _normalize_tagline(parsed.model_dump().get("tagline"))

    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("empty response from Gemini")
    payload = _parse_json_answer(text)
    return _normalize_tagline(payload.get("tagline"))


def _display_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower()
    path = parsed.path.rstrip("/")
    if path:
        return f"{host}{path}"
    return host


def _build_plaintext_signature(inputs: dict[str, str], tagline: str) -> str:
    lines: list[str] = [inputs["full_name"]]

    role_parts = [part for part in (inputs["title"], inputs["company"]) if part]
    if role_parts:
        lines.append(" | ".join(role_parts))

    if tagline:
        lines.append(tagline)

    contact_parts: list[str] = []
    if inputs["email"]:
        contact_parts.append(inputs["email"])
    if inputs["phone"]:
        contact_parts.append(inputs["phone"])
    if contact_parts:
        lines.append(" | ".join(contact_parts))

    link_parts: list[str] = []
    if inputs["calendar_url"]:
        link_parts.append(f"Calendar: {inputs['calendar_url']}")
    if inputs["website_url"]:
        link_parts.append(f"Website: {inputs['website_url']}")
    if inputs["linkedin_url"]:
        link_parts.append(f"LinkedIn: {inputs['linkedin_url']}")
    if link_parts:
        lines.append(" | ".join(link_parts))

    lines.append("")
    lines.append(FOOTER_TEXT)
    return "\n".join(lines)


def _build_markdown_signature(inputs: dict[str, str], tagline: str) -> str:
    lines: list[str] = [f"**{inputs['full_name']}**"]

    role_parts = [part for part in (inputs["title"], inputs["company"]) if part]
    if role_parts:
        lines.append(" | ".join(role_parts))

    if tagline:
        lines.append(f"_{tagline}_")

    contact_parts: list[str] = []
    if inputs["email"]:
        email_value = inputs["email"]
        contact_parts.append(f"[Email](mailto:{email_value})")
    if inputs["phone"]:
        contact_parts.append(f"Phone: {inputs['phone']}")
    if contact_parts:
        lines.append(" | ".join(contact_parts))

    link_parts: list[str] = []
    if inputs["calendar_url"]:
        link_parts.append(f"[Calendar]({inputs['calendar_url']})")
    if inputs["website_url"]:
        website_label = _display_url(inputs["website_url"])
        link_parts.append(f"[Website: {website_label}]({inputs['website_url']})")
    if inputs["linkedin_url"]:
        link_parts.append(f"[LinkedIn]({inputs['linkedin_url']})")
    if link_parts:
        lines.append(" | ".join(link_parts))

    lines.append("")
    lines.append("---")
    lines.append(f"Made with Floom · [floom.dev/p/email-signature]({FOOTER_URL})")
    return "\n".join(lines)


def _build_html_signature(inputs: dict[str, str], tagline: str) -> str:
    esc = html.escape

    html_lines: list[str] = []
    html_lines.append(
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" '
        'style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;color:#111111;line-height:1.35;">'
    )

    html_lines.append(
        f'<tr><td style="font-size:18px;font-weight:700;padding:0 0 4px 0;">{esc(inputs["full_name"])}</td></tr>'
    )

    role_parts = [part for part in (inputs["title"], inputs["company"]) if part]
    if role_parts:
        html_lines.append(
            f'<tr><td style="font-size:14px;color:#374151;padding:0 0 6px 0;">{esc(" | ".join(role_parts))}</td></tr>'
        )

    if tagline:
        html_lines.append(
            f'<tr><td style="font-size:13px;color:#4b5563;padding:0 0 8px 0;">{esc(tagline)}</td></tr>'
        )

    contact_parts: list[str] = []
    if inputs["email"]:
        email_value = esc(inputs["email"])
        contact_parts.append(
            f'<a href="mailto:{email_value}" style="color:#111111;text-decoration:none;">{email_value}</a>'
        )
    if inputs["phone"]:
        contact_parts.append(esc(inputs["phone"]))
    if contact_parts:
        html_lines.append(
            '<tr><td style="font-size:13px;color:#111111;padding:0 0 4px 0;">'
            + " &nbsp;|&nbsp; ".join(contact_parts)
            + "</td></tr>"
        )

    link_parts: list[str] = []
    if inputs["calendar_url"]:
        safe_url = esc(inputs["calendar_url"], quote=True)
        link_parts.append(
            f'<a href="{safe_url}" style="color:#0f4c81;text-decoration:none;">Calendar</a>'
        )
    if inputs["website_url"]:
        safe_url = esc(inputs["website_url"], quote=True)
        link_parts.append(
            f'<a href="{safe_url}" style="color:#0f4c81;text-decoration:none;">Website</a>'
        )
    if inputs["linkedin_url"]:
        safe_url = esc(inputs["linkedin_url"], quote=True)
        link_parts.append(
            f'<a href="{safe_url}" style="color:#0f4c81;text-decoration:none;">LinkedIn</a>'
        )
    if link_parts:
        html_lines.append(
            '<tr><td style="font-size:13px;color:#0f4c81;padding:0 0 8px 0;">'
            + " &nbsp;|&nbsp; ".join(link_parts)
            + "</td></tr>"
        )

    html_lines.append(
        '<tr><td style="border-top:1px solid #d1d5db;padding-top:8px;font-size:11px;color:#6b7280;">'
        f'Made with Floom · <a href="{esc(FOOTER_URL, quote=True)}" '
        'style="color:#6b7280;text-decoration:none;">floom.dev/p/email-signature</a>'
        "</td></tr>"
    )

    html_lines.append("</table>")
    return "".join(html_lines)


def generate(**inputs: Any) -> dict[str, Any]:
    sanitized_inputs = _sanitize_inputs(inputs)

    input_hash = _input_hash(sanitized_inputs)
    cache = _load_sample_cache()
    if input_hash in cache:
        _log(f"cache hit for input_hash={input_hash[:12]}... (instant response)")
        return dict(cache[input_hash])

    tagline = ""
    tagline_source = "none"
    if sanitized_inputs["tagline_mode"] == "ai":
        started = time.monotonic()
        tagline = _generate_ai_tagline(
            full_name=sanitized_inputs["full_name"],
            title=sanitized_inputs["title"],
            company=sanitized_inputs["company"],
        )
        elapsed = time.monotonic() - started
        if elapsed > AI_BUDGET_S:
            raise TimeoutError(
                f"tagline generation exceeded {AI_BUDGET_S:.1f}s ({elapsed:.2f}s)"
            )
        _log(f"Gemini tagline generated in {elapsed:.2f}s")
        tagline_source = "ai"

    outputs = {
        "html": _build_html_signature(sanitized_inputs, tagline),
        "plaintext": _build_plaintext_signature(sanitized_inputs, tagline),
        "markdown": _build_markdown_signature(sanitized_inputs, tagline),
        "meta": {
            "has_tagline": bool(tagline),
            "tagline_source": tagline_source,
            "made_with_floom": FOOTER_URL,
        },
    }
    return outputs


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

    action = config.get("action") or "generate"
    if action != "generate":
        _emit(
            {
                "ok": False,
                "error": f"Unknown action '{action}'. Only 'generate' is supported.",
                "error_type": "invalid_action",
            }
        )
        return 1

    raw_inputs = config.get("inputs") or {}

    try:
        outputs = generate(**raw_inputs)
        _emit({"ok": True, "outputs": outputs})
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        _emit({"ok": False, "error": str(exc), "error_type": "runtime_error"})
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
