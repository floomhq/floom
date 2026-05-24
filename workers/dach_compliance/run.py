from typing import Dict, Any
import json


# DACH market rate data (agency-estimate, based on Gulp/Freelancermap/Figures data 2024-2025)
RATE_BENCHMARKS = {
    "java": {
        "junior": (400, 550),
        "mid": (550, 750),
        "senior": (700, 950),
        "lead": (900, 1200),
    },
    "sap": {
        "junior": (500, 650),
        "mid": (650, 850),
        "senior": (800, 1050),
        "lead": (950, 1300),
    },
    "devops": {
        "junior": (450, 600),
        "mid": (600, 800),
        "senior": (750, 1000),
        "lead": (900, 1150),
    },
    "python": {
        "junior": (400, 550),
        "mid": (550, 750),
        "senior": (680, 920),
        "lead": (850, 1150),
    },
    "default": {
        "junior": (380, 520),
        "mid": (520, 700),
        "senior": (680, 900),
        "lead": (850, 1100),
    },
}


def _detect_stack(role_summary: str) -> str:
    role_lower = role_summary.lower()
    if any(x in role_lower for x in ["java", "spring", "kotlin", "jvm"]):
        return "java"
    if any(x in role_lower for x in ["sap", "abap", "hcm", "fi/co", "s/4"]):
        return "sap"
    if any(x in role_lower for x in ["devops", "kubernetes", "terraform", "ansible", "ci/cd", "platform"]):
        return "devops"
    if any(x in role_lower for x in ["python", "django", "fastapi", "flask"]):
        return "python"
    return "default"


def _detect_seniority(years: int) -> str:
    if years <= 2:
        return "junior"
    if years <= 5:
        return "mid"
    if years <= 10:
        return "senior"
    return "lead"


def run(inputs: Dict[str, Any], context) -> Dict[str, Any]:
    context.log("DACH Compliance + Rate Benchmark started")

    engagement_type = inputs.get("engagement_type", "AÜG").strip()
    role_summary = inputs.get("role_summary", "").strip()
    location = inputs.get("location", "Remote DACH").strip() or "Remote DACH"

    try:
        experience_years = int(inputs.get("experience_years") or 0)
    except (ValueError, TypeError):
        experience_years = 0

    try:
        proposed_rate = float(inputs.get("proposed_daily_rate_eur") or 0)
    except (ValueError, TypeError):
        proposed_rate = 0.0

    if not role_summary:
        return {"status": "error", "error": "Missing required input: role_summary"}

    # --- Rate benchmark (deterministic) ---
    stack = _detect_stack(role_summary)
    seniority = _detect_seniority(experience_years)
    rate_range = RATE_BENCHMARKS[stack][seniority]
    low, high = rate_range

    rate_source = "agency-estimate (Gulp/Freelancermap/Figures DACH market data 2024-2025)"
    rate_note = ""
    if proposed_rate:
        if proposed_rate < low:
            rate_note = f"\n> **Warning:** Proposed rate €{proposed_rate:.0f}/day is **below** the typical range. Candidate may reject or have lower market standing."
        elif proposed_rate > high:
            rate_note = f"\n> **Note:** Proposed rate €{proposed_rate:.0f}/day is **above** the typical range. Budget premium justified for exceptional fit."
        else:
            rate_note = f"\n> Proposed rate €{proposed_rate:.0f}/day is within the typical range."

    rate_benchmark_md = f"""## DACH Rate Benchmark

**Role profile:** {seniority.title()} {stack.upper()} contractor, {experience_years} years experience
**Location:** {location}
**Engagement type:** {engagement_type}

| Seniority band | Daily rate range (EUR) |
|---|---|
| Junior (0-2 yrs) | €{RATE_BENCHMARKS[stack]['junior'][0]}–{RATE_BENCHMARKS[stack]['junior'][1]} |
| Mid (3-5 yrs) | €{RATE_BENCHMARKS[stack]['mid'][0]}–{RATE_BENCHMARKS[stack]['mid'][1]} |
| Senior (6-10 yrs) | €{RATE_BENCHMARKS[stack]['senior'][0]}–{RATE_BENCHMARKS[stack]['senior'][1]} |
| Lead (10+ yrs) | €{RATE_BENCHMARKS[stack]['lead'][0]}–{RATE_BENCHMARKS[stack]['lead'][1]} |

**Recommended range for this engagement:** €{low}–€{high}/day{rate_note}

**Market notes:**
- FinTech/banking clients in Berlin/Frankfurt typically pay 5-10% premium over median
- SAP engagements carry a 10-15% premium due to specialist scarcity in DACH
- Fully remote roles can reduce rate expectations by 5-8%
- AÜG equal-pay obligations may require uplift after 9 months if perm equivalents earn more

*Source: {rate_source}*
"""

    context.log("Rate benchmark computed, generating compliance analysis with AI")

    # --- Compliance report (LLM) — branched by engagement type ---
    # AÜG: leased employee by definition — NOT self-employed. Scheinselbständigkeit does NOT apply.
    # Werkvertrag/Dienstvertrag: freelancer/self-employed context — Scheinselbständigkeit applies.
    # Festanstellung: standard employment — compliance is routine, no AÜG/Scheinselbständigkeit.
    system_prompt = """You are a DACH employment law specialist with deep knowledge of:
- AÜG (Arbeitnehmerüberlassungsgesetz) — the German temporary work agency act
- Scheinselbständigkeit (false self-employment) criteria under German law (applies to Freiberufler/Werkvertrag ONLY)
- Equal-pay obligations under AÜG §8
- Betriebsrat co-determination rights (BetrVG)
- EU AI Act recruiting compliance obligations (high-risk system classification)

CRITICAL DISTINCTION:
- AÜG engagement = the worker IS a leased employee. By legal definition they are NOT self-employed.
  Do NOT mention Scheinselbständigkeit for AÜG engagements. It is legally incorrect and will confuse recruiters.
  For AÜG: focus exclusively on 18-month cap (§ 1 Abs. 1b AÜG), equal-pay trigger (§8 AÜG after 9 months),
  Betriebsrat notification rights, and written disclosure (§11 AÜG).
- Werkvertrag/Dienstvertrag = the worker is a freelancer/contractor. Scheinselbständigkeit IS relevant here.
  Apply the 5-criteria test: personal dependency, no own business risk, exclusively one client,
  integrated into client operations, no freedom to delegate.
- Festanstellung = standard employment. No AÜG or Scheinselbständigkeit concerns.

Write concise, actionable analysis. No generic disclaimers. Reference: https://www.bmas.de/DE/Arbeit/Arbeitnehmerrechte/Arbeitnehmerueberlassung/arbeitnehmerueberlassung.html
"""

    # Build engagement-specific prompt instructions
    if engagement_type == "AÜG":
        compliance_focus = """Produce a compliance report covering ONLY AÜG-specific topics:
1. 18-month maximum deployment period (§ 1 Abs. 1b AÜG) — track from contract start
2. Equal-pay trigger after 9 months (§8 AÜG) — compare agency rate vs. comparable permanent employee
3. Written disclosure obligation (§11 AÜG) — is the leasing arrangement explicitly documented?
4. Betriebsrat co-determination rights at client site (BetrVG §99 for >20 employees)
5. Recommended mitigation steps

DO NOT mention Scheinselbständigkeit or Werkvertrag concerns — they are legally inapplicable for AÜG.
Reference: https://www.bmas.de/DE/Arbeit/Arbeitnehmerrechte/Arbeitnehmerueberlassung/arbeitnehmerueberlassung.html (agency-estimate interpretation)"""
    elif engagement_type in ("Werkvertrag", "Dienstvertrag"):
        compliance_focus = f"""Produce a compliance report covering {engagement_type}-specific topics:
1. Scheinselbständigkeit risk assessment using the 5 German criteria:
   - Personal dependency (weisungsgebunden)
   - No own business risk (kein Unternehmerrisiko)
   - Exclusively/primarily one client (Hauptauftraggeber)
   - Integrated into client operations (eingegliedert)
   - No freedom to delegate (persönliche Leistungspflicht)
2. Contract documentation requirements (Leistungsgegenstand clearly defined, no "time-and-materials" billing)
3. Social security reclassification risk (DRV audit triggers)
4. Recommended mitigation steps

AÜG-specific topics (18-month cap, equal-pay) do NOT apply to {engagement_type}.
Reference: https://www.bmas.de/DE/Soziale-Sicherung/Scheinselbstaendigkeit/scheinselbstaendigkeit.html (agency-estimate interpretation)"""
    elif engagement_type == "Festanstellung":
        compliance_focus = """This is a standard employment engagement. Produce a brief compliance note:
1. Confirm no AÜG or Scheinselbständigkeit concerns apply
2. Note any relevant probationary period requirements (Probezeit, max 6 months)
3. Note notice period obligations under KSchG
4. Recommended documentation checklist for onboarding

Keep this brief — Festanstellung is the lowest-risk engagement type."""
    else:
        compliance_focus = """Produce a general DACH compliance overview covering relevant engagement risks."""

    user_prompt = f"""Analyse this contractor engagement for DACH compliance risks:

Engagement type: {engagement_type}
Role summary: {role_summary}
Location: {location}
Years of experience: {experience_years}
Proposed daily rate: {f"€{proposed_rate:.0f}" if proposed_rate else "not specified"}

{compliance_focus}

Format as Markdown with clear section headers.
End with a one-line overall risk verdict: LOW / MEDIUM / HIGH.

After the risk verdict, add a ## References section with links to the authoritative sources used.
For AÜG engagements, always include:
- https://www.bmas.de/DE/Arbeit/Arbeitnehmerrechte/Arbeitnehmerueberlassung/arbeitnehmerueberlassung.html
For Werkvertrag/Dienstvertrag/Scheinselbständigkeit, always include:
- https://www.bmas.de/DE/Soziale-Sicherung/Scheinselbstaendigkeit/scheinselbstaendigkeit.html
For BetrVG references, include:
- https://www.gesetze-im-internet.de/betrvg/
Mark any rate figures as "(agency-estimate)" since they are based on market surveys rather than official sources.
Do NOT invent URLs — only use the canonical bmas.de and gesetze-im-internet.de domains listed above.

Also return a separate JSON object (after the markdown, separated by <<<JSON>>>) with:
{{"risk_level": "LOW|MEDIUM|HIGH", "items": ["brief flag 1", "brief flag 2", ...]}}
"""

    try:
        from openai import OpenAI
        ai_client = OpenAI(api_key=context.secrets.get("OPENAI_API_KEY"))
        response = ai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=2000,
        )
        full_response = response.choices[0].message.content.strip()
    except Exception as e:
        return {"status": "error", "error": f"OpenAI compliance analysis failed: {e}"}

    # Split out JSON from markdown
    if "<<<JSON>>>" in full_response:
        parts = full_response.split("<<<JSON>>>", 1)
        compliance_report = parts[0].strip()
        json_part = parts[1].strip()
        # Strip code fences
        if json_part.startswith("```"):
            lines = json_part.splitlines()
            lines = [l for l in lines if not l.startswith("```")]
            json_part = "\n".join(lines).strip()
        try:
            red_flags = json.loads(json_part)
        except json.JSONDecodeError:
            red_flags = {"risk_level": "UNKNOWN", "items": ["Could not parse red flags from LLM response"]}
    else:
        compliance_report = full_response
        red_flags = {"risk_level": "UNKNOWN", "items": ["Red flags JSON not returned by model"]}

    context.log(f"Compliance analysis complete. Risk level: {red_flags.get('risk_level', '?')}")

    return {
        "status": "success",
        "outputs": {
            "compliance_report": compliance_report,
            "rate_benchmark": rate_benchmark_md,
            "red_flags": json.dumps(red_flags, ensure_ascii=False, indent=2),
        },
    }
