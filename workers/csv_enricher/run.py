from typing import Dict, Any, List
import csv
import io
import json
import re


def _extract_columns_from_instruction(instruction: str, client) -> List[str]:
    """Use a small LLM call to parse the instruction and extract requested column names.

    Examples:
      "Add fit_score 1-5 + DACH market fit" -> ["fit_score", "dach_fit"]
      "Add seniority level and salary range"  -> ["seniority_level", "salary_range"]
      "Score candidates 1-10"                -> ["score"]
    """
    parse_prompt = (
        "Extract the column names that should be added to a CSV based on this instruction.\n"
        "Return ONLY a JSON array of snake_case column name strings. No commentary. No extra text.\n"
        "Examples:\n"
        '  "Add fit_score 1-5 + DACH market fit" -> ["fit_score", "dach_fit"]\n'
        '  "Add seniority level and salary range" -> ["seniority_level", "salary_range"]\n'
        '  "Score candidates 1-10"               -> ["score"]\n'
        '  "Enrich with company size and HQ location" -> ["company_size", "hq_location"]\n'
        "If you cannot extract clear column names, return [\"enriched\"].\n\n"
        f"Instruction: {instruction}"
    )
    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": parse_prompt}],
            temperature=0.0,
            max_tokens=100,
        )
        raw = resp.choices[0].message.content.strip()
        # Strip code fences
        if raw.startswith("```"):
            lines = raw.splitlines()
            lines = [l for l in lines if not l.startswith("```")]
            raw = "\n".join(lines).strip()
        cols = json.loads(raw)
        if isinstance(cols, list) and all(isinstance(c, str) for c in cols) and cols:
            # Sanitize: snake_case, no spaces
            return [re.sub(r"[^a-z0-9_]", "_", c.lower().strip()).strip("_") or "enriched" for c in cols]
    except Exception:
        pass
    return ["enriched"]


def run(inputs: Dict[str, Any], context) -> Dict[str, Any]:
    context["log"]("Run started")
    context["log"]("Parsing CSV input")

    csv_text = inputs.get("csv_text", "").strip()
    instruction = inputs.get("instruction", "").strip()

    if not csv_text:
        return {"status": "error", "error": "Missing required input: csv_text"}
    if not instruction:
        return {"status": "error", "error": "Missing required input: instruction"}

    try:
        reader = csv.DictReader(io.StringIO(csv_text))
        rows = list(reader)
        original_fieldnames = list(reader.fieldnames or [])
    except Exception as e:
        return {"status": "error", "error": f"Invalid CSV: {str(e)}"}

    if not rows:
        return {"status": "error", "error": "CSV has no data rows"}

    context["log"](f"Loaded {len(rows)} rows")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=context["secrets"].get("OPENAI_API_KEY"))

        # Derive new column names from the instruction
        context["log"]("Deriving output columns from instruction")
        new_columns = _extract_columns_from_instruction(instruction, client)
        context["log"](f"Derived columns: {new_columns}")

        output_fieldnames = original_fieldnames + new_columns
        output_fieldnames_str = ", ".join(output_fieldnames)

        context["log"]("Enriching with AI")

        system_prompt = (
            "You are a data enrichment assistant.\n"
            "The user will provide CSV rows and an instruction.\n"
            f"Return ONLY the enriched CSV with EXACTLY these column headers in this order: {output_fieldnames_str}\n"
            "No extra columns. No markdown code fences. No commentary.\n"
            f"Instruction: {instruction}"
        )

        user_prompt = (
            f"CSV rows:\n{csv_text}\n\n"
            f"Instruction: {instruction}\n\n"
            f"Return CSV with columns: {output_fieldnames_str}"
        )

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.3,
            max_tokens=2000,
        )

        enriched = response.choices[0].message.content.strip()
        # Clean up markdown code blocks if present
        if enriched.startswith("```"):
            lines = enriched.splitlines()
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].startswith("```"):
                lines = lines[:-1]
            enriched = "\n".join(lines).strip()

        # Validate returned header; repair if columns differ
        first_line = enriched.splitlines()[0] if enriched else ""
        returned_cols = [c.strip().strip('"') for c in first_line.split(",")]
        if returned_cols != output_fieldnames:
            context["log"](
                f"Column mismatch: expected {output_fieldnames}, got {returned_cols}. Rebuilding.",
                level="warning",
            )
            try:
                repair_reader = csv.DictReader(io.StringIO(enriched))
                repair_rows = list(repair_reader)
                out = io.StringIO()
                writer = csv.DictWriter(out, fieldnames=output_fieldnames, extrasaction="ignore")
                writer.writeheader()
                for row in repair_rows:
                    for col in new_columns:
                        if col not in row:
                            row[col] = ""
                    writer.writerow({k: row.get(k, "") for k in output_fieldnames})
                enriched = out.getvalue().strip()
            except Exception:
                pass  # keep LLM output as-is if repair fails

        context["log"]("AI enrichment complete")
    except Exception as e:
        context["log"](f"OpenAI failed: {str(e)}", level="error")
        new_columns = ["enriched"]
        output_fieldnames = original_fieldnames + new_columns
        # Fallback: add a single enriched column
        enriched_rows = []
        for row in rows:
            new_row = dict(row)
            new_row["enriched"] = f"Processed with: {instruction}"
            enriched_rows.append(new_row)
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=output_fieldnames)
        writer.writeheader()
        writer.writerows(enriched_rows)
        enriched = out.getvalue().strip()
        context["log"]("Fell back to template enrichment")

    return {
        "status": "success",
        "outputs": {
            "enriched_csv": enriched
        },
        "artifacts": []
    }
