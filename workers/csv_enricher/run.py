from typing import Dict, Any
import csv
import io


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
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
    except Exception as e:
        return {"status": "error", "error": f"Invalid CSV: {str(e)}"}

    if not rows:
        return {"status": "error", "error": "CSV has no data rows"}

    context["log"](f"Loaded {len(rows)} rows")

    # Try OpenAI enrichment
    try:
        from openai import OpenAI
        client = OpenAI(api_key=context["secrets"].get("OPENAI_API_KEY"))

        context["log"]("Enriching with AI")

        system_prompt = f"""You are a data enrichment assistant.
The user will provide CSV rows and an instruction.
Return ONLY the enriched CSV rows (same columns plus an 'enriched' column) with no extra commentary.
Instruction: {instruction}"""

        user_prompt = f"CSV rows:\n{csv_text}\n\nInstruction: {instruction}\n\nReturn enriched CSV with same columns plus 'enriched' column:"

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
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

        context["log"]("AI enrichment complete")
    except Exception as e:
        context["log"](f"OpenAI failed: {str(e)}", level="error")
        # Fallback: add instruction as enrichment
        enriched_rows = []
        fieldnames = list(rows[0].keys()) + ["enriched"]
        for row in rows:
            new_row = dict(row)
            new_row["enriched"] = f"Processed with: {instruction}"
            enriched_rows.append(new_row)
        out = io.StringIO()
        writer = csv.DictWriter(out, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(enriched_rows)
        enriched = out.getvalue()
        context["log"]("Fell back to template enrichment")

    return {
        "status": "success",
        "outputs": {
            "enriched_csv": enriched
        },
        "artifacts": []
    }
