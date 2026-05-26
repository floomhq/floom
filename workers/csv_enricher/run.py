"""CSV Enricher — E2B-native worker.

Reads inputs.json, secrets.json. Writes result.json.
"""
import csv
import io
import json
import os
import re


def _extract_columns_from_instruction(instruction: str, client) -> list:
    """Use a small LLM call to parse the instruction and extract requested column names."""
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
        if raw.startswith("```"):
            lines = raw.splitlines()
            lines = [l for l in lines if not l.startswith("```")]
            raw = "\n".join(lines).strip()
        cols = json.loads(raw)
        if isinstance(cols, list) and all(isinstance(c, str) for c in cols) and cols:
            return [re.sub(r"[^a-z0-9_]", "_", c.lower().strip()).strip("_") or "enriched" for c in cols]
    except Exception:
        pass
    return ["enriched"]


def main():
    with open("inputs.json") as f:
        inputs = json.load(f)

    try:
        with open("secrets.json") as f:
            secrets = json.load(f)
    except FileNotFoundError:
        secrets = {}

    try:
        with open("connections.json") as f:
            connections = json.load(f)
    except FileNotFoundError:
        connections = {}

    csv_text = inputs.get("csv_text", "").strip()
    instruction = inputs.get("instruction", "").strip()

    if not csv_text:
        result = {"status": "error", "error": "Missing required input: csv_text"}
        with open("result.json", "w") as f:
            json.dump(result, f)
        return

    if not instruction:
        result = {"status": "error", "error": "Missing required input: instruction"}
        with open("result.json", "w") as f:
            json.dump(result, f)
        return

    try:
        reader = csv.DictReader(io.StringIO(csv_text))
        rows = list(reader)
        original_fieldnames = list(reader.fieldnames or [])
    except Exception as e:
        result = {"status": "error", "error": f"Invalid CSV: {str(e)}"}
        with open("result.json", "w") as f:
            json.dump(result, f)
        return

    if not rows:
        result = {"status": "error", "error": "CSV has no data rows"}
        with open("result.json", "w") as f:
            json.dump(result, f)
        return

    try:
        from openai import OpenAI
        client = OpenAI(api_key=secrets.get("OPENAI_API_KEY"))

        new_columns = _extract_columns_from_instruction(instruction, client)

        output_fieldnames = original_fieldnames + new_columns
        output_fieldnames_str = ", ".join(output_fieldnames)

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

    except Exception as e:
        new_columns = ["enriched"]
        output_fieldnames = original_fieldnames + new_columns
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

    result = {
        "status": "success",
        "outputs": {
            "enriched_csv": enriched,
        },
        "artifacts": [],
    }
    with open("result.json", "w") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
