"""Reverse Match CRM — E2B-native worker.

Reads inputs.json and secrets from .env.local (python-dotenv). Writes result.json.
Falls back to secrets.json for backward-compat during transition period.
"""
import csv
import io
import json
import os
from datetime import datetime, timezone

try:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
except ImportError:
    pass  # dotenv optional; secrets.json fallback covers transition


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

    crm_csv_input = inputs.get("crm_csv", "").strip()
    job_brief = inputs.get("job_brief", "").strip()
    required_modules_raw = inputs.get("required_modules", "").strip()
    try:
        min_score = float(inputs.get("min_score") or 0.55)
    except (ValueError, TypeError):
        min_score = 0.55
    try:
        top_n = int(inputs.get("top_n") or 10)
    except (ValueError, TypeError):
        top_n = 10

    if not crm_csv_input:
        _write_error("Missing required input: crm_csv")
        return
    if not job_brief:
        _write_error("Missing required input: job_brief")
        return

    required_modules = [m.strip() for m in required_modules_raw.split(",") if m.strip()] if required_modules_raw else []

    # crm_csv_input may be a file path (from E2B file upload) or inline CSV content
    import os as _os
    if _os.path.isfile(crm_csv_input):
        try:
            with open(crm_csv_input, "r", encoding="utf-8", errors="replace") as fh:
                crm_csv = fh.read().strip()
        except Exception as e:
            _write_error(f"Could not read CRM CSV file: {e}")
            return
    else:
        crm_csv = crm_csv_input

    if not crm_csv:
        _write_error("CRM CSV is empty")
        return

    try:
        reader = csv.DictReader(io.StringIO(crm_csv))
        rows = list(reader)
    except Exception as e:
        _write_error(f"Invalid CSV: {str(e)}")
        return

    if not rows:
        _write_error("CSV has no data rows")
        return

    # Build freshness warnings and source row index lookup
    now_utc = datetime.now(timezone.utc)
    email_by_name = {r.get("name", "").strip(): r.get("email", "").strip() for r in rows}
    for idx, row in enumerate(rows):
        last_active = row.get("last_active_iso", "").strip()
        warning = ""
        if last_active:
            try:
                dt = datetime.fromisoformat(last_active.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                days_inactive = (now_utc - dt).days
                if days_inactive > 365:
                    warning = f"Last active {days_inactive}d ago — stale"
                elif days_inactive > 180:
                    warning = f"Last active {days_inactive}d ago — warm up first"
            except Exception:
                warning = "Unknown last-active date"
        row["_profile_age_risk"] = warning
        row["_source_row_index"] = idx + 2  # 1-indexed + header row = row 2 for first data row

    rows_json = json.dumps(
        [
            {
                "row_index": r["_source_row_index"],
                "name": r.get("name", ""),
                "email": r.get("email", ""),
                "current_company": r.get("current_company", ""),
                "current_title": r.get("current_title", ""),
                "headline": r.get("headline", ""),
                "skills": r.get("skills", ""),
                "notes": r.get("notes", ""),
                "profile_age_risk": r.get("_profile_age_risk", ""),
            }
            for r in rows
        ],
        ensure_ascii=False,
    )

    required_modules_text = (
        f"\nRequired modules that MUST appear in skills or notes: {', '.join(required_modules)}"
        if required_modules
        else ""
    )

    system_prompt = f"""You are a DACH tech recruiting specialist at NovaSearch. You score CRM candidates against a job brief.

For each candidate return a JSON array where every element has EXACTLY these keys (no others):
  name, fit_score, reasoning, dach_fit, contractor_or_perm, profile_age_risk, outreach_next_step, source_row_index

Rules:
- fit_score: float 0.000–1.000, 3 decimal places. Higher is better. Tie-break: prefer more years of experience.
  Calibrate scores: 1.0 means perfect match on every dimension — reserve it. Use 0.85–0.95 for strong fits.
- reasoning: 1-2 sentences in English explaining the score, referencing specific skills/companies.
- dach_fit: exactly one of "Yes", "No", "Maybe" — based on DACH location signals, language, DACH companies in history.
- contractor_or_perm: exactly one of "Festanstellung", "Freiberufler", "Beides", "Unbekannt".
- profile_age_risk: use the provided profile_age_risk string, or empty string "" if none.
- outreach_next_step: 1 actionable outreach suggestion for this candidate (e.g., "Send DM mentioning Kafka role at FinTech", "Follow up on last role transition to Freelancer", "Check availability before outreach — last active 14 months ago").
- source_row_index: copy the row_index integer from the candidate data (for recruiter traceability).{required_modules_text}

Return ONLY the raw JSON array. No markdown, no commentary, no code fences.
"""

    user_prompt = f"""Job brief:
{job_brief}

CRM candidates:
{rows_json}

Score all {len(rows)} candidates and return the JSON array."""

    try:
        from openai import OpenAI
        client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY") or _secrets_fb.get("OPENAI_API_KEY"))
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=4000,
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            lines = raw.splitlines()
            lines = [l for l in lines if not l.startswith("```")]
            raw = "\n".join(lines).strip()
        scored = json.loads(raw)
    except json.JSONDecodeError as e:
        _write_error(f"LLM returned malformed JSON: {e}")
        return
    except Exception as e:
        _write_error(f"OpenAI call failed: {e}")
        return

    if not isinstance(scored, list):
        _write_error("LLM did not return a JSON array")
        return

    # Validate schema
    required_keys = {"name", "fit_score", "reasoning", "dach_fit", "contractor_or_perm", "profile_age_risk", "outreach_next_step", "source_row_index"}
    for idx, item in enumerate(scored):
        missing = required_keys - set(item.keys())
        if missing:
            _write_error(f"Row {idx} missing keys: {missing}")
            return

    # Filter and sort
    above_threshold = [s for s in scored if float(s["fit_score"]) >= min_score]
    above_threshold.sort(key=lambda x: float(x["fit_score"]), reverse=True)
    top = above_threshold[:top_n]

    # Build output CSV
    out = io.StringIO()
    fieldnames = ["name", "fit_score", "reasoning", "dach_fit", "contractor_or_perm", "profile_age_risk", "outreach_next_step", "source_row_index", "contact_email"]
    writer = csv.DictWriter(out, fieldnames=fieldnames)
    writer.writeheader()
    for item in top:
        row_out = {k: item.get(k, "") for k in fieldnames}
        row_out["contact_email"] = email_by_name.get(str(item.get("name", "")).strip(), "")
        writer.writerow(row_out)
    top_csv = out.getvalue().strip()

    dach_yes = sum(1 for s in above_threshold if s.get("dach_fit") == "Yes")
    freelancer_count = sum(1 for s in above_threshold if s.get("contractor_or_perm") in ("Freiberufler", "Beides"))
    top_names = ", ".join(s["name"] for s in top[:3]) if top else "none"

    analysis_summary = f"""## Reverse Match Summary

**Job brief:** {job_brief[:200]}{'...' if len(job_brief) > 200 else ''}

**Total CRM contacts scored:** {len(scored)}
**Above threshold ({min_score}):** {len(above_threshold)}
**Showing top {len(top)}**

### Key signals
- DACH-located candidates above threshold: **{dach_yes}**
- Freelancer/contractor-eligible above threshold: **{freelancer_count}**
- Top 3 candidates: **{top_names}**

### Recommendation
{"No candidates above threshold — consider lowering min_score or broadening the job brief." if not above_threshold else f"Prioritise outreach to {top_names}. Review freshness warnings before contact."}
"""

    import os as _os
    _os.makedirs("out", exist_ok=True)
    with open("out/top_candidates.csv", "w", encoding="utf-8") as fh:
        fh.write(top_csv)
    with open("out/analysis_summary.md", "w", encoding="utf-8") as fh:
        fh.write(analysis_summary)

    result = {
        "status": "success",
        "outputs": {
            "top_candidates": "out/top_candidates.csv",
            "all_above_threshold_count": str(len(above_threshold)),
            "analysis_summary": "out/analysis_summary.md",
        },
        "artifacts": [
            {"name": "out/top_candidates.csv", "relative_path": "out/top_candidates.csv", "type": "text/csv"},
            {"name": "out/analysis_summary.md", "relative_path": "out/analysis_summary.md", "type": "text/markdown"},
        ],
    }
    with open("result.json", "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
