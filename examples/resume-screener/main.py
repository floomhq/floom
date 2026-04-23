#!/usr/bin/env python3
"""
Resume Screener -- Floom demo app.

Ranks candidate CVs (PDFs) against a job description using Gemini 3 native.

Protocol (per apps/server/src/lib/entrypoint.py):
  argv[1] JSON: {
    "action": "screen",
    "inputs": {
      "cvs_zip": "/floom/inputs/cvs_zip.zip",      # path OR raw base64 str
      "job_description": "Senior Backend Engineer ...",
      "must_haves": "Python\\nPostgres\\n5+ years"
    }
  }
  stdout last line: __FLOOM_RESULT__{"ok": true, "outputs": {...}}

Schema note: the Floom manifest v2.0 InputType set is
  text, textarea, url, number, enum, boolean, date, file
(see apps/server/src/services/manifest.ts -> INPUT_TYPES). No `array` type,
no nested items/pdf. So instead of `cvs: array of file/pdf`, we accept a
single zip (`cvs_zip: file`) and unpack it in the container.

Model: gemini-3.1-pro-preview via google-genai. No web search or URL context
(everything is in the CVs already). No Claude, no OpenAI, no Gemini 2.x.
Falls back to dry-run deterministic scoring if GEMINI_API_KEY is unset.

Privacy: candidate names and contact info are redacted from stdout logs.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import random
import re
import sys
import time
import traceback
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

MODEL_ID = "gemini-3.1-pro-preview"
MAX_WORKERS = 8
PER_CALL_TIMEOUT_S = 45
MAX_CV_CHARS = 20_000  # truncate very long CVs to stay under token budget

SYSTEM_PROMPT = """You are a senior technical recruiter screening candidate CVs.

For the CV below, compare it strictly against the job description and (if
provided) the hard must-haves. Return ONLY a JSON object (no markdown, no
prose, no code fences) with this exact shape:

{
  "score": <int 0-100, overall fit with the JD>,
  "reasoning": "<3-4 sentences, plain English, cite concrete evidence from the CV>",
  "match_summary": "<1-2 sentences: the strongest reasons to interview>",
  "gaps": ["<concrete gap 1>", "<concrete gap 2>"],
  "must_have_pass": <true if every listed must-have is clearly present in the CV, else false>
}

Rules:
- Score strictly. Default to lower scores unless the evidence is strong.
- If a must-have is not clearly present, must_have_pass = false. If no must-haves
  were provided, must_have_pass = true.
- Cite specific roles, years, technologies, or achievements in `reasoning`.
- `gaps` must be concrete (e.g. "no Kubernetes experience", not "junior").
- Return ONLY the JSON object. No ```json fences. No extra keys."""


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------
def _emit(payload: dict) -> None:
    """Write the single-line Floom result the runner parses."""
    sys.stdout.write("__FLOOM_RESULT__" + json.dumps(payload) + "\n")
    sys.stdout.flush()


def _redact(name: str) -> str:
    """Stable short hash for a CV filename or candidate label. Used in logs."""
    h = hashlib.sha256(name.encode("utf-8")).hexdigest()[:8]
    return f"cv-{h}"


def _log(msg: str) -> None:
    print(f"[resume-screener] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Zip + PDF loading
# ---------------------------------------------------------------------------
def _load_zip_bytes(cvs_zip_input: str) -> bytes:
    """Accept either a filesystem path or raw base64-encoded bytes."""
    if os.path.isfile(cvs_zip_input):
        _log(f"reading zip from path: {cvs_zip_input}")
        with open(cvs_zip_input, "rb") as f:
            return f.read()
    # treat as base64 (inline) -- used for local tests where no /floom/inputs mount exists
    _log("treating `cvs_zip` as base64-encoded bytes (no file at that path)")
    try:
        return base64.b64decode(cvs_zip_input)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"cvs_zip is neither a file path nor valid base64: {exc}")


def _extract_pdfs(zip_bytes: bytes) -> list[tuple[str, bytes]]:
    """Return list of (filename, pdf_bytes) for every .pdf in the zip."""
    out: list[tuple[str, bytes]] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            # skip macOS metadata
            if name.startswith("__MACOSX") or os.path.basename(name).startswith("."):
                continue
            if not name.lower().endswith(".pdf"):
                continue
            out.append((os.path.basename(name), zf.read(info)))
    return out


def _parse_pdf(pdf_bytes: bytes) -> str:
    """Extract text from a PDF. Raises on failure."""
    from pypdf import PdfReader  # type: ignore

    reader = PdfReader(io.BytesIO(pdf_bytes))
    chunks: list[str] = []
    for page in reader.pages:
        try:
            chunks.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001 -- pypdf can raise on weird fonts
            continue
    text = "\n".join(chunks).strip()
    if not text:
        raise ValueError("pdf yielded no extractable text (image-only or encrypted?)")
    if len(text) > MAX_CV_CHARS:
        text = text[:MAX_CV_CHARS] + f"\n\n[...truncated, original {len(text)} chars]"
    return text


# ---------------------------------------------------------------------------
# Model call
# ---------------------------------------------------------------------------
def _parse_json_answer(text: str) -> dict[str, Any]:
    """Strip optional code fences, parse JSON."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned
        if cleaned.rstrip().endswith("```"):
            cleaned = cleaned.rstrip()[:-3]
    cleaned = cleaned.strip()
    if not cleaned.startswith("{"):
        i = cleaned.find("{")
        if i >= 0:
            cleaned = cleaned[i:]
    return json.loads(cleaned)


def _build_genai():
    """Create a google-genai client. Returns client or None on missing key."""
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
    except ImportError as exc:
        _log(f"google-genai not installed: {exc}")
        return None
    return genai.Client(api_key=api_key)


def _score_with_gemini(
    cv_text: str,
    jd: str,
    must_haves: list[str],
    client,
) -> dict[str, Any]:
    """Single scoring call. Retries once on rate limit / JSON parse failure."""
    from google.genai import errors as genai_errors  # type: ignore
    from google.genai.types import GenerateContentConfig  # type: ignore

    mh_block = (
        "Hard must-haves (all must be clearly present):\n"
        + "\n".join(f"- {m}" for m in must_haves)
        if must_haves
        else "Hard must-haves: (none provided)"
    )
    prompt = (
        f"Job description:\n{jd.strip()}\n\n"
        f"{mh_block}\n\n"
        f"Candidate CV:\n{cv_text.strip()}\n\n"
        "Score this candidate. Return ONLY the JSON object."
    )
    config = GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        temperature=0.2,
    )

    for attempt in (1, 2):
        try:
            resp = client.models.generate_content(
                model=MODEL_ID,
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
    raise RuntimeError("unreachable")


def _dry_run_score(cv_text: str, jd: str, must_haves: list[str]) -> dict[str, Any]:
    """Deterministic mock scoring used when GEMINI_API_KEY is missing.

    Scoring: count how many JD keywords appear in the CV, plus noise seeded by
    a stable hash of the CV text. This is a toy metric but it lets the demo
    run end-to-end without a live API key.
    """
    # crude keyword overlap
    jd_words = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9+#.]{2,}", jd)}
    cv_words = {w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9+#.]{2,}", cv_text)}
    overlap = len(jd_words & cv_words)
    base = min(95, 30 + overlap * 2)

    seed = int(hashlib.sha256(cv_text.encode()).hexdigest()[:8], 16)
    rng = random.Random(seed)
    score = max(10, min(98, base + rng.randint(-8, 8)))

    cv_lower = cv_text.lower()
    missing = [m for m in must_haves if m.strip() and m.strip().lower() not in cv_lower]
    must_have_pass = (not must_haves) or not missing
    return {
        "score": score,
        "reasoning": "DRY RUN (no GEMINI_API_KEY). Keyword-overlap heuristic; not a real evaluation.",
        "match_summary": f"Keyword overlap with JD: {overlap} terms.",
        "gaps": [f"missing must-have: {m}" for m in missing] or ["dry-run: gaps not analysed"],
        "must_have_pass": must_have_pass,
    }


# ---------------------------------------------------------------------------
# Public action
# ---------------------------------------------------------------------------
def _split_must_haves(mh: Any) -> list[str]:
    """Accept a list OR a textarea string (one per line)."""
    if mh is None or mh == "":
        return []
    if isinstance(mh, list):
        return [str(x).strip() for x in mh if str(x).strip()]
    # textarea
    return [line.strip() for line in str(mh).splitlines() if line.strip()]


def screen(
    cvs_zip: str,
    job_description: str,
    must_haves: Any = None,
    **_kwargs,
) -> dict[str, Any]:
    """Screen every PDF in the zip against the JD. Returns a ranked list."""
    if not job_description or not job_description.strip():
        raise ValueError("job_description is required")
    if not cvs_zip:
        raise ValueError("cvs_zip is required (path to a .zip of PDFs)")

    mh_list = _split_must_haves(must_haves)
    zip_bytes = _load_zip_bytes(cvs_zip)
    pdfs = _extract_pdfs(zip_bytes)
    if not pdfs:
        return {
            "total": 0,
            "scored": 0,
            "failed": 0,
            "ranked": [],
            "summary": "No PDFs found in the uploaded archive.",
            "dry_run": False,
            "model": MODEL_ID,
        }
    _log(f"found {len(pdfs)} PDF(s) in archive; must_haves={len(mh_list)}")

    client = _build_genai()
    dry_run = client is None
    if dry_run:
        _log("DRY RUN: GEMINI_API_KEY missing or google-genai not installed.")

    def _screen_one(idx_item: tuple[int, tuple[str, bytes]]) -> dict:
        idx, (filename, pdf_bytes) = idx_item
        redacted = _redact(filename)
        base = {
            "#": idx + 1,
            "filename": filename,
            "redacted_id": redacted,
        }
        # 1. parse PDF
        try:
            cv_text = _parse_pdf(pdf_bytes)
        except Exception as exc:  # noqa: BLE001
            _log(f"{redacted}: pdf_parse_failed: {exc}")
            return {
                **base,
                "status": "error",
                "error": "pdf_parse_failed",
                "error_detail": str(exc)[:300],
                "score": None,
                "must_have_pass": False,
            }

        # 2. score
        try:
            if dry_run:
                out = _dry_run_score(cv_text, job_description, mh_list)
            else:
                out = _score_with_gemini(cv_text, job_description, mh_list, client)

            score = out.get("score")
            if not isinstance(score, (int, float)):
                raise ValueError(f"bad score field: {out!r}")
            out["score"] = max(0, min(100, int(score)))
            out.setdefault("reasoning", "")
            out.setdefault("match_summary", "")
            out.setdefault("gaps", [])
            out.setdefault("must_have_pass", not mh_list)
            if not isinstance(out["gaps"], list):
                out["gaps"] = [str(out["gaps"])]
            return {**base, "status": "ok", **out}
        except Exception as exc:  # noqa: BLE001
            _log(f"{redacted}: scoring_failed: {exc}")
            return {
                **base,
                "status": "error",
                "error": "scoring_failed",
                "error_detail": str(exc)[:300],
                "score": None,
                "must_have_pass": False,
            }

    results: list[dict] = [None] * len(pdfs)  # type: ignore
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(pdfs))) as pool:
        futures = {pool.submit(_screen_one, (i, item)): i for i, item in enumerate(pdfs)}
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                results[i] = fut.result(timeout=PER_CALL_TIMEOUT_S)
            except Exception as exc:  # noqa: BLE001
                filename = pdfs[i][0]
                _log(f"{_redact(filename)}: future_failed: {exc}")
                results[i] = {
                    "#": i + 1,
                    "filename": filename,
                    "redacted_id": _redact(filename),
                    "status": "error",
                    "error": "future_failed",
                    "error_detail": str(exc)[:300],
                    "score": None,
                    "must_have_pass": False,
                }

    # Sort: must_have_pass first, then score desc, then nulls last.
    def _sort_key(r: dict) -> tuple:
        s = r.get("score")
        return (
            1 if r.get("must_have_pass") else 0,
            s if s is not None else -1,
            -(r.get("#", 0)),
        )

    ranked = sorted(results, key=_sort_key, reverse=True)

    scored = sum(1 for r in results if r.get("status") == "ok")
    failed = len(results) - scored
    top = ranked[0] if ranked and ranked[0].get("score") is not None else None
    summary = (
        f"Screened {len(pdfs)} CV(s) against the JD."
        f" {scored} scored, {failed} failed."
        + (
            f" Top candidate: {top['redacted_id']} ({top['score']}/100)."
            if top
            else ""
        )
    )

    return {
        "total": len(pdfs),
        "scored": scored,
        "failed": failed,
        "dry_run": dry_run,
        "model": MODEL_ID if not dry_run else "dry-run",
        "ranked": ranked,
        "summary": summary,
    }


# ---------------------------------------------------------------------------
# Standalone CLI
# ---------------------------------------------------------------------------
def _cli() -> int:
    if len(sys.argv) < 2:
        _emit({
            "ok": False,
            "error": "Missing config argument (argv[1] JSON)",
            "error_type": "runtime_error",
        })
        return 1
    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as exc:
        _emit({
            "ok": False,
            "error": f"Invalid config JSON: {exc}",
            "error_type": "runtime_error",
        })
        return 1

    action = config.get("action") or "screen"
    inputs = config.get("inputs") or {}

    if action != "screen":
        _emit({
            "ok": False,
            "error": f"Unknown action '{action}'. Only 'screen' is supported.",
            "error_type": "invalid_action",
        })
        return 1

    try:
        out = screen(**inputs)
        _emit({"ok": True, "outputs": out})
        return 0
    except Exception as exc:  # noqa: BLE001
        # Public-run safety: never emit raw tracebacks in the result payload
        # (they leak absolute filesystem paths and internal structure). Full
        # traceback still goes to stderr so the operator can debug the run.
        traceback.print_exc(file=sys.stderr)
        _emit({
            "ok": False,
            "error": str(exc),
            "error_type": "runtime_error",
        })
        return 1


if __name__ == "__main__":
    sys.exit(_cli())
