from typing import Dict, Any
import csv
import io


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

    # Output must match the declared output column name: enriched_csv
    # We always output the original columns plus an 'enriched' column.
    output_fieldnames = original_fieldnames + ["enriched"]
    output_fieldnames_str = ", ".join(output_fieldnames)

    try:
        from openai import OpenAI
        client = OpenAI(api_key=context["secrets"].get("OPENAI_API_KEY"))

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

        # Validate returned header matches expected columns; repair if needed
        first_line = enriched.splitlines()[0] if enriched else ""
        returned_cols = [c.strip() for c in first_line.split(",")]
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
                    if "enriched" not in row:
                        row["enriched"] = ""
                    writer.writerow({k: row.get(k, "") for k in output_fieldnames})
                enriched = out.getvalue().strip()
            except Exception:
                pass  # keep LLM output as-is if repair fails

        context["log"]("AI enrichment complete")
    except Exception as e:
        context["log"](f"OpenAI failed: {str(e)}", level="error")
        # Fallback: add enriched column with template value
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
