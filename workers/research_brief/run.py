from typing import Dict, Any


def run(inputs: Dict[str, Any], context: Dict[str, Any]) -> Dict[str, Any]:
    context["log"]("Run started")
    context["log"]("Validating inputs")

    topic = inputs.get("topic", "").strip()
    audience = inputs.get("audience", "executive")
    depth = inputs.get("depth", "overview")

    if not topic:
        return {
            "status": "error",
            "error": "Missing required input: topic"
        }

    context["log"]("Generating research brief with AI")

    try:
        from openai import OpenAI
        client = OpenAI(api_key=context["secrets"].get("OPENAI_API_KEY"))

        depth_instruction = {
            "overview": "Provide a concise 3-paragraph overview with key takeaways.",
            "detailed": "Provide a structured brief with sections: Summary, Key Findings, Implications, Recommendations.",
            "deep_dive": "Provide a comprehensive brief with executive summary, detailed analysis, data points, risks, opportunities, and actionable recommendations."
        }.get(depth, "Provide a concise overview.")

        system_prompt = f"""You are a senior research analyst.
Write a research brief on the topic provided.
Audience: {audience}
Depth: {depth_instruction}
Use markdown formatting. Be factual, structured, and actionable."""

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Topic: {topic}"}
            ],
            temperature=0.5,
            max_tokens=2500,
        )

        output = response.choices[0].message.content
        context["log"]("AI research brief generated")
    except Exception as e:
        context["log"](f"OpenAI call failed: {str(e)}", level="error")
        output = f"""# Research Brief: {topic}

Audience: {audience} | Depth: {depth}

## Overview

This is a placeholder research brief. Connect your OpenAI API key to generate real AI-powered research.

## Key Points

- Topic: {topic}
- Depth: {depth}
- Audience: {audience}
"""
        context["log"]("Fell back to template output")

    # Write artifact
    artifact_path = ""
    artifact_size = 0
    relative_path = "out/brief.md"
    try:
        import os
        artifact_dir = context["artifact_dir"]
        output_dir = os.path.join(artifact_dir, "out")
        os.makedirs(output_dir, exist_ok=True)
        artifact_path = os.path.join(output_dir, "brief.md")
        with open(artifact_path, "w", encoding="utf-8") as f:
            f.write(output)
        artifact_size = os.path.getsize(artifact_path)
        context["log"]("Artifact written: out/brief.md")
    except Exception as e:
        context["log"](f"Failed to write artifact: {e}", level="warning")

    return {
        "status": "success",
        "outputs": {
            "brief": relative_path
        },
        "artifacts": [
            {
                "name": relative_path,
                "relative_path": relative_path,
                "type": "text/markdown",
                "path": artifact_path,
                "size_bytes": artifact_size
            }
        ] if artifact_path else []
    }
