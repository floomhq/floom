"""CV Writeup — E2B-native worker.

Reads inputs.json and secrets from .env.local (python-dotenv). Writes result.json.
Falls back to secrets.json for backward-compat during transition period.
"""
import base64
import io
import json
import os
import re

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional; secrets.json fallback covers transition


FORMAT_INSTRUCTIONS = {
    "branded_markdown": """Write a professional NovaSearch-branded candidate writeup in Markdown for a recruiter to review and edit before sending.
No marketing language. No "ideal candidate". No "accomplished". Write as a senior recruiter's internal assessment.
Structure:
# [Candidate Name] — [Current Title]
## Profile
2-3 factual paragraphs covering background, client fit, and key differentiators. Reference specific skills and the client context.
## Strengths
Bullet list of 4-6 concrete strengths relevant to the role (with evidence from CV where possible).
## Risks / Open Questions
Bullet list of 2-4 genuine caveats or gaps a client may raise (gaps, tenure, rate, availability, etc.).
If none, write "No significant risks identified."
## Key Competencies
Bullet list of 5-8 most relevant skills and experiences.
## Career Highlights
3-5 bullet points of notable achievements/tenure.
## Logistics
- Location, availability, employment type preference, languages
---
*Prepared by NovaSearch | DACH Tech Recruiting Specialists*""",

    "plain_summary": """Write a concise 1-page plain-English summary (no markdown headers, flowing prose).
3 paragraphs: background, relevant skills, logistics. End with a one-sentence assessment of fit and main caveat.""",

    "two_pager": """Write a detailed two-page Markdown writeup for client submission. Structure:
# [Candidate Name] — Executive Summary
## Professional Overview (full career narrative, 3-4 paragraphs)
## Technical Competencies (detailed skill breakdown by category)
## Selected Projects & Achievements (3-5 detailed bullet points)
## Education & Certifications
## Languages & Location
## NovaSearch Assessment
Strengths: bullet list. Risks: bullet list. Overall fit verdict (1 sentence).
---
*NovaSearch GmbH · DACH Tech Recruiting · novasearch.de*""",
}


def _extract_text_from_base64(data_uri: str) -> str:
    """Extract text from a base64-encoded file (PDF, DOCX, or plain text)."""
    if "," in data_uri:
        header, b64data = data_uri.split(",", 1)
    else:
        header = ""
        b64data = data_uri

    raw_bytes = base64.b64decode(b64data)

    mime = ""
    if "application/pdf" in header or header == "":
        if raw_bytes[:4] == b"%PDF":
            mime = "pdf"
        elif raw_bytes[:2] in (b"PK",):
            mime = "docx"
        else:
            mime = "text"
    elif "pdf" in header.lower():
        mime = "pdf"
    elif "docx" in header.lower() or "openxmlformats" in header.lower() or "msword" in header.lower():
        mime = "docx"
    else:
        mime = "text"

    if not mime:
        if raw_bytes[:4] == b"%PDF":
            mime = "pdf"
        elif raw_bytes[:2] == b"PK":
            mime = "docx"
        else:
            mime = "text"

    if mime == "pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(raw_bytes))
            pages = []
            for page in reader.pages:
                pages.append(page.extract_text() or "")
            return "\n".join(pages)
        except Exception as e:
            raise RuntimeError(f"PDF parsing failed: {e}")

    if mime == "docx":
        try:
            from docx import Document
            doc = Document(io.BytesIO(raw_bytes))
            paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
            return "\n".join(paragraphs)
        except Exception as e:
            raise RuntimeError(f"DOCX parsing failed: {e}")

    try:
        return raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return raw_bytes.decode("latin-1", errors="replace")


def _write_error(error: str) -> None:
    with open("result.json", "w") as f:
        json.dump({"status": "error", "error": error}, f)


def _secrets_fallback() -> dict:
    """Load secrets.json for backward-compat when dotenv import failed."""
    try:
        with open("secrets.json") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def main():
    with open("inputs.json") as f:
        inputs = json.load(f)

    _secrets_fb = _secrets_fallback()

    try:
        with open("connections.json") as f:
            connections = json.load(f)
    except FileNotFoundError:
        connections = {}

    # cv_file may be a path (e2b file input) or a base64 data URI
    cv_file_input = inputs.get("cv_file", "").strip()
    client_brief = inputs.get("client_brief", "").strip()
    target_format = inputs.get("target_format", "branded_markdown").strip()

    if not cv_file_input:
        _write_error("Missing required input: cv_file")
        return
    if not client_brief:
        _write_error("Missing required input: client_brief")
        return
    if target_format not in FORMAT_INSTRUCTIONS:
        target_format = "branded_markdown"

    # Resolve file: if it's a relative/absolute path written by the E2B driver, read it
    if not cv_file_input.startswith("data:"):
        try:
            with open(cv_file_input, "rb") as fh:
                raw = fh.read()
            # Wrap as base64 so the shared extractor can handle it
            import base64 as _b64
            cv_file_b64 = "data:application/octet-stream;base64," + _b64.b64encode(raw).decode()
        except Exception as e:
            _write_error(f"Could not read cv_file path: {e}")
            return
    else:
        cv_file_b64 = cv_file_input

    try:
        cv_text = _extract_text_from_base64(cv_file_b64)
    except Exception as e:
        _write_error(str(e))
        return

    if not cv_text.strip():
        _write_error("Could not extract any text from the uploaded CV")
        return

    extract_prompt = """Extract the following fields from this CV text and return ONLY a JSON object with these exact keys:
{
  "name": "Full name",
  "current_title": "Most recent job title",
  "current_company": "Most recent employer",
  "years_experience": "Total years of professional experience as a number (integer)",
  "key_skills": ["skill1", "skill2", ...],
  "languages": ["German", "English", ...],
  "location": "City, Country",
  "contact": "Email or phone if present, else empty string"
}
Return ONLY the JSON. No commentary."""

    try:
        from openai import OpenAI
        client_ai = OpenAI(api_key=os.environ.get("OPENAI_API_KEY") or _secrets_fb.get("OPENAI_API_KEY"))

        extract_resp = client_ai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": extract_prompt},
                {"role": "user", "content": f"CV text:\n{cv_text[:6000]}"},
            ],
            temperature=0.1,
            max_tokens=800,
        )
        profile_raw = extract_resp.choices[0].message.content.strip()
        if profile_raw.startswith("```"):
            lines = profile_raw.splitlines()
            lines = [l for l in lines if not l.startswith("```")]
            profile_raw = "\n".join(lines).strip()
        extracted_profile = json.loads(profile_raw)
    except json.JSONDecodeError:
        extracted_profile = {
            "name": "", "current_title": "", "current_company": "",
            "years_experience": 0, "key_skills": [], "languages": [],
            "location": "", "contact": "",
        }
    except Exception as e:
        _write_error(f"OpenAI profile extraction failed: {e}")
        return

    format_instruction = FORMAT_INSTRUCTIONS[target_format]

    writeup_system = f"""You are a senior recruiter at NovaSearch, a DACH tech recruiting boutique specialising in Java/Backend/FinTech.
You write precise, client-ready candidate writeups. No fluff. No filler phrases. No marketing language.
BANNED phrases: "ideal candidate", "accomplished", "exceptional talent", "uniquely positioned", "extensive expertise", "proven track record".
Write like a colleague briefing a colleague — factual, specific, honest about gaps.
{format_instruction}"""

    writeup_user = f"""Client context:
{client_brief}

Candidate CV text:
{cv_text[:8000]}

Write the candidate writeup now."""

    try:
        writeup_resp = client_ai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": writeup_system},
                {"role": "user", "content": writeup_user},
            ],
            temperature=0.4,
            max_tokens=2000,
        )
        writeup = writeup_resp.choices[0].message.content.strip()
    except Exception as e:
        _write_error(f"OpenAI writeup generation failed: {e}")
        return

    import os as _os
    _os.makedirs("out", exist_ok=True)
    with open("out/writeup.md", "w", encoding="utf-8") as fh:
        fh.write(writeup)
    profile_json = json.dumps(extracted_profile, ensure_ascii=False, indent=2)
    with open("out/extracted_profile.json", "w", encoding="utf-8") as fh:
        fh.write(profile_json)

    result = {
        "status": "success",
        "outputs": {
            "writeup": "out/writeup.md",
            "extracted_profile": "out/extracted_profile.json",
        },
        "artifacts": [
            {"name": "out/writeup.md", "relative_path": "out/writeup.md", "type": "text/markdown"},
            {"name": "out/extracted_profile.json", "relative_path": "out/extracted_profile.json", "type": "application/json"},
        ],
    }
    with open("result.json", "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
