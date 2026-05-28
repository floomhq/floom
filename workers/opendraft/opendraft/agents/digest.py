"""Digest agent: Generate 60-second audio briefing from any document."""

import re
from pathlib import Path
from typing import Optional

from opendraft.agents.base import BaseCodeAgent, ToolConfig
from opendraft.utils.document_reader import read_document


class DigestAgent(BaseCodeAgent):
    """
    Agent that generates a 60-second narration script from any paper.

    The script is designed for text-to-speech (ElevenLabs) and follows
    a specific structure optimized for audio comprehension.

    Output: 150-180 word narration script
    """

    def __init__(self, model_name: str = "gemini-3-flash-preview"):
        tool_config = ToolConfig(function_declarations=[])

        system_prompt = BaseCodeAgent.load_prompt("digest")

        super().__init__(
            name="digest",
            system_prompt=system_prompt,
            tool_config=tool_config,
            function_handlers={},
            model_name=model_name,
            max_iterations=3,
        )

    def generate_script(self, document_path: Path, max_chars: int = 100000) -> str:
        """
        Generate narration script for a document.

        Args:
            document_path: Path to PDF, markdown, or text file
            max_chars: Max characters to read from document

        Returns:
            Narration script (150-180 words)
        """
        document_path = Path(document_path)

        content = read_document(document_path, max_chars=max_chars)

        task = f"""Generate a 60-second digest script for this document:

---
DOCUMENT: {document_path.name}
---

{content}

---

Remember:
- Exactly 150-180 words
- Write for text-to-speech (spoken language)
- No citations, no brackets, no visual formatting
- Hook first, then thesis, evidence, implications, caveat, closer
- Spell out numbers ("forty percent" not "40%")
"""

        result = self.run(task)
        return self._extract_script(result.output)

    def _extract_script(self, output: str) -> str:
        """Extract the narration script from agent output."""
        lines = output.split("\n")
        script_lines = []
        in_script = False

        for line in lines:
            if line.strip().lower().startswith("## digest script"):
                in_script = True
                continue

            if in_script:
                if line.strip().upper().startswith("SIGNAL:"):
                    break
                if line.startswith("## ") and "digest" not in line.lower():
                    break
                if line.strip().startswith("```"):
                    continue
                script_lines.append(line)

        if script_lines:
            script = "\n".join(script_lines).strip()
            return self._clean_script(script)

        # Fallback: find the longest paragraph
        paragraphs = [p.strip() for p in output.split("\n\n") if p.strip()]
        paragraphs = [p for p in paragraphs if not p.startswith("SIGNAL:")]
        paragraphs = [p for p in paragraphs if not p.startswith("##")]

        if paragraphs:
            # Find paragraph closest to 150-180 words
            best = max(paragraphs, key=lambda p: len(p.split()))
            return self._clean_script(best)

        return self._clean_script(output.replace("SIGNAL: DONE", "").strip())

    def _clean_script(self, script: str) -> str:
        """Clean script for TTS - remove any remaining formatting."""
        # Remove markdown formatting
        script = re.sub(r'\*\*([^*]+)\*\*', r'\1', script)  # bold
        script = re.sub(r'\*([^*]+)\*', r'\1', script)  # italic
        script = re.sub(r'`([^`]+)`', r'\1', script)  # code

        # Remove citations
        script = re.sub(r'\([^)]*\d{4}[^)]*\)', '', script)  # (Author, 2023)
        script = re.sub(r'\[[^\]]+\]', '', script)  # [1] or [citation]

        # Clean up whitespace
        script = re.sub(r'\s+', ' ', script)
        script = script.strip()

        return script


def generate_digest(
    document_path: Path,
    output_dir: Optional[Path] = None,
    voice: str = "rachel",
    model_name: str = "gemini-3-flash-preview",
    generate_audio: bool = True,
) -> dict:
    """
    Generate a complete digest: script + audio.

    Args:
        document_path: Path to document
        output_dir: Directory for output files (default: same as document)
        voice: ElevenLabs voice name
        model_name: Gemini model for script generation
        generate_audio: Whether to generate audio (requires ELEVENLABS_API_KEY)

    Returns:
        Dict with script, script_path, and optionally audio_path
    """
    document_path = Path(document_path)

    if output_dir is None:
        output_dir = document_path.parent

    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Generate script
    agent = DigestAgent(model_name=model_name)
    script = agent.generate_script(document_path)

    # Save script
    base_name = document_path.stem
    script_path = output_dir / f"{base_name}_digest.md"
    script_path.write_text(f"## Digest Script\n\n{script}\n", encoding="utf-8")

    result = {
        "script": script,
        "script_path": script_path,
        "word_count": len(script.split()),
        "cost": agent.get_cost(),
    }

    # Generate audio if requested
    if generate_audio:
        try:
            from opendraft.audio.elevenlabs import generate_audio as gen_audio

            audio_path = output_dir / f"{base_name}_digest.mp3"
            gen_audio(script, audio_path, voice=voice)
            result["audio_path"] = audio_path
        except ValueError as e:
            # No API key
            result["audio_error"] = str(e)
        except Exception as e:
            result["audio_error"] = f"Audio generation failed: {e}"

    return result
