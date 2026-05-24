from typing import Dict, Any
import base64
import io
import json
import re


def _extract_text_from_base64(data_uri: str) -> str:
    """Extract text from a base64-encoded file (PDF, DOCX, or plain text)."""
    # Parse data URI: data:<mime>;base64,<data>
    if "," in data_uri:
        header, b64data = data_uri.split(",", 1)
    else:
        header = ""
        b64data = data_uri

    raw_bytes = base64.b64decode(b64data)

    # Detect type from header
    mime = ""
    if "application/pdf" in header or header == "":
        # Try PDF first (magic bytes)
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
        # Fallback: check magic bytes
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

    # Plain text
    try:
        return raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return raw_bytes.decode("latin-1", errors="replace")


FORMAT_INSTRUCTIONS = {
    "branded_markdown": """Write a professional Search Assistant-branded candidate writeup in Markdown for a recruiter to review and edit before sending.
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
*Prepared by Search Assistant | DACH Tech Recruiting Specialists*""",

    "plain_summary": """Write a concise 1-page plain-English summary (no markdown headers, flowing prose).
3 paragraphs: background, relevant skills, logistics. End with a one-sentence assessment of fit and main caveat.""",

    "two_pager": """Write a detailed two-page Markdown writeup for client submission. Structure:
# [Candidate Name] — Executive Summary
## Professional Overview (full career narrative, 3-4 paragraphs)
## Technical Competencies (detailed skill breakdown by category)
## Selected Projects & Achievements (3-5 detailed bullet points)
## Education & Certifications
## Languages & Location
## Search Assistant Assessment
Strengths: bullet list. Risks: bullet list. Overall fit verdict (1 sentence).
---
*Search Assistant GmbH · DACH Tech Recruiting · sample-search.de*""",
}


def run(inputs: Dict[str, Any], context) -> Dict[str, Any]:
    context.log("CV Writeup worker started")

    cv_file = inputs.get("cv_file", "").strip()
    client_brief = inputs.get("client_brief", "").strip()
    target_format = inputs.get("target_format", "branded_markdown").strip()

    if not cv_file:
        return {"status": "error", "error": "Missing required input: cv_file"}
    if not client_brief:
        return {"status": "error", "error": "Missing required input: client_brief"}
    if target_format not in FORMAT_INSTRUCTIONS:
        target_format = "branded_markdown"

    context.log("Extracting text from CV file")
    try:
        cv_text = _extract_text_from_base64(cv_file)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    if not cv_text.strip():
        return {"status": "error", "error": "Could not extract any text from the uploaded CV"}

    context.log(f"Extracted {len(cv_text)} characters from CV")

    # Step 1: Extract structured profile
    context.log("Extracting structured profile")
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
        client_ai = OpenAI(api_key=context.secrets.get("OPENAI_API_KEY"))

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
    except json.JSONDecodeError as e:
        context.log(f"Profile extraction JSON error: {e}", level="warning")
        extracted_profile = {"name": "", "current_title": "", "current_company": "", "years_experience": 0, "key_skills": [], "languages": [], "location": "", "contact": ""}
    except Exception as e:
        return {"status": "error", "error": f"OpenAI profile extraction failed: {e}"}

    context.log(f"Profile extracted: {extracted_profile.get('name', '?')} @ {extracted_profile.get('current_company', '?')}")

    # Step 2: Generate writeup
    context.log(f"Generating {target_format} writeup")
    format_instruction = FORMAT_INSTRUCTIONS[target_format]

    writeup_system = f"""You are a senior recruiter at Search Assistant, a DACH tech recruiting boutique specialising in Java/Backend/FinTech.
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
        return {"status": "error", "error": f"OpenAI writeup generation failed: {e}"}

    context.log("Writeup generated successfully")

    return {
        "status": "success",
        "outputs": {
            "writeup": writeup,
            "extracted_profile": json.dumps(extracted_profile, ensure_ascii=False, indent=2),
        },
    }
