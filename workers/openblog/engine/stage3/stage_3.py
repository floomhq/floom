"""
Stage 3: Quality Check

Reviews Stage 2 article output and makes surgical find/replace fixes
to transform AI-generated content into human-written copywriter quality.

Micro-API Design:
- Input: JSON with article content from Stage 2
- Output: JSON with improved article + list of fixes made
- Can run as CLI or be imported as a module

AI Calls: 1 (Gemini with structured schema, no grounding needed)
"""

import asyncio
import copy
import json
import logging
import sys
from pathlib import Path
from typing import Dict, Any, List, Optional

# Add parent to path for shared imports
_parent = Path(__file__).resolve().parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

try:
    from .stage3_models import Stage3Input, Stage3Output, QualityFix, VoiceContext
except ImportError:
    from stage3_models import Stage3Input, Stage3Output, QualityFix, VoiceContext

try:
    from google.genai import types as genai_types
except ImportError:
    genai_types = None

try:
    from shared.gemini_client import GeminiClient
    from shared.field_utils import iter_content_fields
except ImportError as e:
    # Can't use logger here as it's not configured yet
    import warnings
    warnings.warn(f"Could not import shared modules: {e}")
    GeminiClient = None
    iter_content_fields = None

# Get logger (configuration done in main() for CLI usage)
logger = logging.getLogger(__name__)


# =============================================================================
# Quality Improvement Prompt - loaded from prompts/quality_check.txt
# =============================================================================

try:
    from shared.prompt_loader import load_prompt
    _PROMPT_LOADER_AVAILABLE = True
except ImportError:
    _PROMPT_LOADER_AVAILABLE = False


def _format_voice_context_section(voice_context: Optional[VoiceContext]) -> str:
    """Format voice context into prompt section."""
    if not voice_context:
        return ""

    lines = ["\nBRAND VOICE GUIDELINES:"]

    if voice_context.tone:
        lines.append(f"- Tone: {voice_context.tone}")

    if voice_context.formality:
        lines.append(f"- Formality: {voice_context.formality}")

    if voice_context.first_person_usage:
        lines.append(f"- First Person: {voice_context.first_person_usage}")

    if voice_context.banned_words:
        words = ', '.join(voice_context.banned_words[:10])
        lines.append(f"- BANNED WORDS (flag if found): {words}")

    if voice_context.do_list:
        dos = '; '.join(voice_context.do_list[:5])
        lines.append(f"- Writing Style DO: {dos}")

    if voice_context.dont_list:
        donts = '; '.join(voice_context.dont_list[:5])
        lines.append(f"- Writing Style DON'T: {donts}")

    if voice_context.example_phrases:
        examples = '"; "'.join(voice_context.example_phrases[:3])
        lines.append(f"- Example Phrases (for tone reference): \"{examples}\"")

    lines.append("")  # Blank line before next section
    return "\n".join(lines)


def _get_quality_prompt(content: str, keyword: str, language: str, voice_context: Optional[VoiceContext] = None) -> str:
    """Load quality check prompt from file or use fallback."""
    voice_section = _format_voice_context_section(voice_context)

    if _PROMPT_LOADER_AVAILABLE:
        try:
            return load_prompt("stage3", "quality_check",
                               content=content, keyword=keyword, language=language,
                               voice_context_section=voice_section)
        except FileNotFoundError:
            logger.warning("Prompt file not found, using fallback")

    # Fallback prompt (minimal version - schema handles output format)
    return f'''Review this content and fix AI-generated phrases.
Content: {content}
Keyword: {keyword}
Language: {language}
{voice_section}
Find phrases that sound robotic or AI-generated and suggest surgical replacements.'''


class QualityFixer:
    """
    Makes surgical quality fixes to article content using Gemini.
    """

    # Max characters for content in prompt (approximate token limit safety)
    MAX_CONTENT_CHARS = 50000

    # Default timeout for Gemini API calls
    DEFAULT_TIMEOUT = 120

    # Maximum number of fixes to apply (matches prompt instruction)
    MAX_FIXES = 20

    # Cached schema (built lazily)
    _response_schema = None

    def __init__(self, api_key: Optional[str] = None):
        """Initialize with shared GeminiClient."""
        if GeminiClient is None:
            raise ImportError("shared.gemini_client not available")

        self._client = GeminiClient(api_key=api_key)
        logger.debug("QualityFixer initialized (using shared GeminiClient)")

    @classmethod
    def _get_response_schema(cls) -> Any:
        """Get or build the response schema (cached at class level)."""
        if cls._response_schema is not None:
            return cls._response_schema

        if genai_types is None:
            raise ImportError("google-genai not installed")

        fix_schema = genai_types.Schema(
            type=genai_types.Type.OBJECT,
            properties={
                "field": genai_types.Schema(type=genai_types.Type.STRING, description="Field name to fix"),
                "find": genai_types.Schema(type=genai_types.Type.STRING, description="Exact text to find"),
                "replace": genai_types.Schema(type=genai_types.Type.STRING, description="Replacement text"),
                "reason": genai_types.Schema(type=genai_types.Type.STRING, description="Reason for fix"),
            },
            required=["field", "find", "replace"],
        )

        cls._response_schema = genai_types.Schema(
            type=genai_types.Type.OBJECT,
            properties={
                "fixes": genai_types.Schema(
                    type=genai_types.Type.ARRAY,
                    items=fix_schema,
                    description="List of quality fixes",
                ),
            },
            required=["fixes"],
        )

        return cls._response_schema

    async def run(self, input_data: Stage3Input, timeout: Optional[int] = None) -> Stage3Output:
        """
        Main entry point - review and fix article quality.

        Args:
            input_data: Stage3Input with article and options
            timeout: Optional timeout for Gemini API call (default: DEFAULT_TIMEOUT)

        Returns:
            Stage3Output with fixed article and report
        """
        logger.info("Stage 3: Quality Check")

        # Validate and set timeout
        if timeout is not None and timeout < 0:
            raise ValueError(f"Timeout cannot be negative, got {timeout}")
        effective_timeout = timeout if timeout is not None else self.DEFAULT_TIMEOUT

        # Check if stage is disabled
        if not input_data.enabled:
            logger.info("  Stage disabled, skipping")
            return Stage3Output(
                article=copy.deepcopy(input_data.article),
                fixes_applied=0,
                fixes=[],
                ai_calls=0,
                skipped=True,
            )

        article = copy.deepcopy(input_data.article)

        # Build content for Gemini review
        content_text = self._extract_content(article)
        if not content_text:
            logger.warning("  No content to check")
            return Stage3Output(
                article=article,
                fixes_applied=0,
                fixes=[],
                ai_calls=0,
            )

        # Call Gemini for quality review
        fixes = await self._get_fixes(
            content_text,
            input_data.keyword,
            input_data.language,
            voice_context=input_data.voice_context,
            timeout=effective_timeout,
        )

        if not fixes:
            logger.info("  No fixes needed - content looks good")
            return Stage3Output(
                article=article,
                fixes_applied=0,
                fixes=[],
                ai_calls=1,
            )

        # Apply fixes
        applied_fixes = self._apply_fixes(article, fixes)
        logger.info(f"  Applied {len(applied_fixes)} fixes")

        return Stage3Output(
            article=article,
            fixes_applied=len(applied_fixes),
            fixes=applied_fixes,
            ai_calls=1,
        )

    def _extract_content(self, article: Dict[str, Any]) -> str:
        """Extract checkable content fields for Gemini prompt."""
        if iter_content_fields is None:
            logger.warning("iter_content_fields not available")
            return ""
        sections = []
        for field, content in iter_content_fields(article):
            sections.append(f"[{field}]\n{content}")
        result = "\n\n".join(sections)

        # Warn if content is very long
        if len(result) > self.MAX_CONTENT_CHARS:
            logger.warning(f"  Content very long ({len(result)} chars), may hit token limits")

        return result

    async def _get_fixes(
        self,
        content_text: str,
        keyword: str,
        language: str,
        voice_context: Optional[VoiceContext] = None,
        timeout: int = 120,
    ) -> List[Dict[str, Any]]:
        """Call Gemini to get quality fix suggestions using structured schema."""
        prompt = _get_quality_prompt(
            content=content_text,
            keyword=keyword or "(not specified)",
            language=language or "en",
            voice_context=voice_context,
        )

        try:
            # Get cached schema (raises ImportError if google-genai not installed)
            response_schema = self._get_response_schema()

            # Use shared GeminiClient with structured schema (no grounding needed)
            result = await self._client.generate_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                use_url_context=False,
                use_google_search=False,
                temperature=0.3,
                timeout=timeout,
            )

            if isinstance(result, dict):
                fixes = result.get("fixes", [])
                logger.info(f"  Gemini suggested {len(fixes)} fixes")
                return fixes

            return []

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            # JSON parse errors can happen even with schema - Gemini sometimes returns malformed JSON
            logger.warning(f"Stage 3 Gemini response issue (handled gracefully): {e}")
            return []
        except ImportError:
            # google-genai not installed - re-raise
            raise
        except Exception as e:
            # Unexpected errors - log and return empty (don't crash pipeline)
            logger.error(f"Stage 3 unexpected error: {e}")
            logger.debug("Full traceback:", exc_info=True)
            return []

    def _apply_fixes(
        self,
        article: Dict[str, Any],
        fixes: List[Dict[str, Any]],
    ) -> List[QualityFix]:
        """Apply fixes to article content."""
        applied = []

        for i, fix_data in enumerate(fixes):
            # Enforce max fixes limit
            if len(applied) >= self.MAX_FIXES:
                remaining = len(fixes) - i
                logger.warning(f"  Reached max fixes limit ({self.MAX_FIXES}), {remaining} fixes not evaluated")
                break

            field = fix_data.get("field") or ""
            find_text = fix_data.get("find") or ""
            replace_text = fix_data.get("replace") or ""
            reason = fix_data.get("reason") or ""

            # Skip invalid fixes
            if not field or not find_text:
                continue

            # Skip no-op fixes (find == replace)
            if find_text == replace_text:
                continue

            # Skip if field doesn't exist
            if field not in article:
                logger.debug(f"  Field not found: {field}")
                continue

            content = article.get(field, "")
            if not content:
                continue

            # Convert to string once for consistency
            content_str = str(content)

            # Check if find text exists
            if find_text not in content_str:
                preview = find_text[:50] + ('...' if len(find_text) > 50 else '')
                logger.debug(f"  Text not found in {field}: {preview}")
                continue

            # Apply replacement
            article[field] = content_str.replace(find_text, replace_text, 1)

            applied.append(QualityFix(
                field=field,
                find=find_text,
                replace=replace_text,
                reason=reason,
            ))

            preview = find_text[:30] + ('...' if len(find_text) > 30 else '')
            logger.debug(f"  Fixed in {field}: '{preview}'")

        return applied


# =============================================================================
# JSON Interface (Micro-API)
# =============================================================================

async def run_stage_3(
    input_data: Dict[str, Any],
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Run Stage 3 from dict input, return dict output.

    Micro-API interface for integration with other stages or services.

    Args:
        input_data: Dictionary with Stage3Input fields
        timeout: Optional timeout for Gemini API call

    Returns:
        Dictionary with Stage3Output fields
    """
    stage_input = Stage3Input(**input_data)
    fixer = QualityFixer()
    output = await fixer.run(stage_input, timeout=timeout)
    return output.model_dump()


async def run_from_file(
    input_path: str,
    output_path: Optional[str] = None,
    keyword: Optional[str] = None,
    language: Optional[str] = None,
    disabled: bool = False,
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Run Stage 3 from JSON file, optionally save output to file.

    Args:
        input_path: Path to input JSON file
        output_path: Optional path to save output JSON
        keyword: Optional keyword override
        language: Optional language override
        disabled: If True, skip quality check
        timeout: Optional timeout for Gemini API call

    Returns:
        Dictionary with Stage3Output fields
    """
    # Check file exists
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    # Read input
    try:
        with open(input_path, "r", encoding="utf-8") as f:
            input_json = json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {input_path}: {e}") from e

    # Handle different input formats (copy to avoid mutating caller's dict)
    if "article" in input_json:
        stage3_input = copy.deepcopy(input_json)
    else:
        # Wrap raw article output
        stage3_input = {
            "article": copy.deepcopy(input_json),
            "keyword": input_json.get("primary_keyword", ""),
        }

    # Apply overrides (always apply if provided)
    if keyword is not None:
        stage3_input["keyword"] = keyword
    if language is not None:
        stage3_input["language"] = language
    if disabled:
        stage3_input["enabled"] = False

    # Run
    result = await run_stage_3(stage3_input, timeout=timeout)

    # Save output if path provided
    if output_path:
        output_file = Path(output_path)
        if not output_file.parent.exists():
            output_file.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2)
            logger.info(f"Output saved to {output_path}")
        except OSError as e:
            raise OSError(f"Failed to write {output_path}: {e}") from e

    return result


# =============================================================================
# Sync wrapper for non-async usage
# =============================================================================

def run_stage_3_sync(
    input_data: Dict[str, Any],
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Synchronous wrapper for run_stage_3.

    Args:
        input_data: Dictionary with Stage3Input fields
        timeout: Optional timeout for Gemini API call

    Returns:
        Dictionary with Stage3Output fields
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        # Already in async context (e.g., Jupyter) - use nest_asyncio if available
        try:
            import nest_asyncio
            nest_asyncio.apply()
            return asyncio.run(run_stage_3(input_data, timeout=timeout))
        except ImportError:
            raise RuntimeError(
                "Cannot run sync wrapper in async context. "
                "Either use 'await run_stage_3()' or install nest_asyncio."
            )
    return asyncio.run(run_stage_3(input_data, timeout=timeout))


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI entry point."""
    import argparse

    # Configure logging for CLI usage
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Stage 3: Quality Check - Surgical fixes for human-quality copy"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        required=True,
        help="Input JSON file path (Stage 2 output with article)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output JSON file path"
    )
    parser.add_argument(
        "--keyword", "-k",
        type=str,
        help="Primary keyword (overrides input file)"
    )
    parser.add_argument(
        "--language", "-l",
        type=str,
        help="Target language (overrides input file)"
    )
    parser.add_argument(
        "--timeout", "-t",
        type=int,
        default=120,
        help="Timeout for Gemini API call in seconds (default: 120)"
    )
    parser.add_argument(
        "--disabled",
        action="store_true",
        help="Skip quality check (passthrough)"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    # Configure logging level based on --verbose flag
    if args.verbose:
        logging.getLogger(__name__).setLevel(logging.DEBUG)
        logging.getLogger().setLevel(logging.DEBUG)

    async def run():
        result = await run_from_file(
            input_path=args.input,
            output_path=args.output,
            keyword=args.keyword,
            language=args.language,
            disabled=args.disabled,
            timeout=args.timeout,
        )

        # Print summary
        print(f"\n=== Stage 3 Results ===")
        print(f"Fixes Applied: {result['fixes_applied']}")
        print(f"AI Calls: {result['ai_calls']}")
        print(f"Skipped: {result['skipped']}")

        if result['fixes']:
            print(f"\nFixes:")
            for fix in result['fixes']:
                find_text = fix['find']
                replace_text = fix['replace']
                reason = fix['reason']
                find_preview = find_text[:40] + ('...' if len(find_text) > 40 else '')
                replace_preview = replace_text[:40] + ('...' if len(replace_text) > 40 else '') if replace_text else '(deleted)'
                reason_suffix = f" ({reason})" if reason else ""
                print(f"  [{fix['field']}] '{find_preview}'")
                print(f"    -> '{replace_preview}'{reason_suffix}")

        return result

    try:
        asyncio.run(run())
        sys.exit(0)
    except KeyboardInterrupt:
        print("\nInterrupted by user")
        sys.exit(130)
    except FileNotFoundError as e:
        logger.error(str(e))
        sys.exit(1)
    except ValueError as e:
        logger.error(str(e))
        sys.exit(1)
    except OSError as e:
        logger.error(str(e))
        sys.exit(1)
    except Exception as e:
        logger.error(f"Stage 3 failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
