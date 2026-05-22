from typing import Dict, Any


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    context["log"]("Run started")
    context["log"]("Validating inputs")

    notes = inputs.get("notes", "").strip()
    audience = inputs.get("audience", "internal")

    if not notes:
        return {
            "status": "error",
            "error": "Missing required input: notes"
        }

    context["log"]("Generating weekly update with AI")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=context["secrets"].get("OPENAI_API_KEY"))

        system_prompt = f"""You are a professional communications writer.
Write a polished weekly company update for a {audience} audience.
Use the raw notes provided and turn them into a well-structured markdown update.
Include highlights, key metrics if mentioned, and a forward-looking summary."""

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": notes}
            ],
            temperature=0.7,
            max_tokens=1500,
        )

        output = response.choices[0].message.content
        context["log"]("AI output generated")
    except Exception as e:
        context["log"](f"OpenAI call failed: {str(e)}", level="error")
        # Fallback to template
        output = f"""# Weekly Update

Audience: {audience}

## Highlights

{notes}

## Summary

This update was generated from the provided notes.
"""
        context["log"]("Fell back to template output")

    return {
        "status": "success",
        "outputs": {
            "update": output
        },
        "artifacts": []
    }
