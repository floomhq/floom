"""
Stage Refresh: Content Freshener

Uses deep research (Gemini + Google Search) to find and fix outdated content.
Important for AEO - keeping content fresh and accurate.

Micro-API Design:
- Input: JSON with existing blog article
- Output: JSON with refreshed article + list of updates made
- Can run as CLI or be imported as a module

AI Calls: 1 (Gemini with Google Search grounding)
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
    from .refresh_models import RefreshInput, RefreshOutput, RefreshFix
except ImportError:
    from refresh_models import RefreshInput, RefreshOutput, RefreshFix

try:
    from google.genai import types as genai_types
except ImportError:
    genai_types = None

try:
    from shared.gemini_client import GeminiClient
    from shared.field_utils import iter_content_fields
except ImportError as e:
    import warnings
    warnings.warn(f"Could not import shared modules: {e}")
    GeminiClient = None
    iter_content_fields = None

logger = logging.getLogger(__name__)


# =============================================================================
# Prompt Loader
# =============================================================================

try:
    from shared.prompt_loader import load_prompt
    _PROMPT_LOADER_AVAILABLE = True
except ImportError:
    _PROMPT_LOADER_AVAILABLE = False


def _get_refresh_prompt(content: str) -> str:
    """Load refresh prompt from file or use fallback."""
    from datetime import date
    today = date.today().strftime("%Y-%m-%d")

    if _PROMPT_LOADER_AVAILABLE:
        try:
            return load_prompt("stage refresh", "content_refresh",
                               content=content, date=today)
        except FileNotFoundError:
            logger.warning("Prompt file not found, using fallback")

    # Fallback prompt
    return f'''You are a content freshness expert. Today is {today}. Identify outdated facts in this content using web research.

Content: {content}

Only update if you found VERIFIED newer data. Do NOT speculatively update years. Cite sources.
Return JSON with "fixes" array. Each fix needs: field, find (exact text), replace (updated text), reason with source.'''


class ContentRefresher:
    """
    Refreshes article content using deep research.
    Uses Gemini with Google Search to find current information.
    """

    MAX_CONTENT_CHARS = 50000
    DEFAULT_TIMEOUT = 180  # Longer timeout for research
    MAX_FIXES = 10  # Matches prompt limit

    _response_schema = None

    def __init__(self, api_key: Optional[str] = None):
        """Initialize with shared GeminiClient."""
        if GeminiClient is None:
            raise ImportError("shared.gemini_client not available")

        self._client = GeminiClient(api_key=api_key)
        logger.debug("ContentRefresher initialized")

    @classmethod
    def _get_response_schema(cls) -> Any:
        """Get or build the response schema."""
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
                "reason": genai_types.Schema(type=genai_types.Type.STRING, description="Why this was outdated"),
            },
            required=["field", "find", "replace"],
        )

        cls._response_schema = genai_types.Schema(
            type=genai_types.Type.OBJECT,
            properties={
                "fixes": genai_types.Schema(
                    type=genai_types.Type.ARRAY,
                    items=fix_schema,
                    description="List of content refresh fixes",
                ),
            },
            required=["fixes"],
        )

        return cls._response_schema

    async def run(self, input_data: RefreshInput, timeout: Optional[int] = None) -> RefreshOutput:
        """
        Main entry point - refresh article content with current information.

        Args:
            input_data: RefreshInput with article and options
            timeout: Optional timeout for Gemini API call

        Returns:
            RefreshOutput with updated article and report
        """
        logger.info("Stage Refresh: Content Freshener")

        if timeout is not None and timeout < 0:
            raise ValueError(f"Timeout cannot be negative, got {timeout}")
        effective_timeout = timeout if timeout is not None else self.DEFAULT_TIMEOUT

        # Check if stage is disabled
        if not input_data.enabled:
            logger.info("  Stage disabled, skipping")
            return RefreshOutput(
                article=copy.deepcopy(input_data.article),
                fixes_applied=0,
                fixes=[],
                ai_calls=0,
                skipped=True,
            )

        article = copy.deepcopy(input_data.article)

        # Extract content for review
        content_text = self._extract_content(article)
        if not content_text:
            logger.warning("  No content to refresh")
            return RefreshOutput(
                article=article,
                fixes_applied=0,
                fixes=[],
                ai_calls=0,
            )

        # Call Gemini with Google Search for research
        fixes = await self._get_fixes(
            content_text,
            timeout=effective_timeout,
        )

        if not fixes:
            logger.info("  No updates needed - content is current")
            return RefreshOutput(
                article=article,
                fixes_applied=0,
                fixes=[],
                ai_calls=1,
            )

        # Apply fixes
        applied_fixes = self._apply_fixes(article, fixes)
        logger.info(f"  Applied {len(applied_fixes)} refresh updates")

        return RefreshOutput(
            article=article,
            fixes_applied=len(applied_fixes),
            fixes=applied_fixes,
            ai_calls=1,
        )

    def _extract_content(self, article: Dict[str, Any]) -> str:
        """Extract content fields for Gemini review."""
        if iter_content_fields is None:
            logger.warning("iter_content_fields not available")
            return ""
        sections = []
        for field, content in iter_content_fields(article):
            sections.append(f"[{field}]\n{content}")
        result = "\n\n".join(sections)

        if len(result) > self.MAX_CONTENT_CHARS:
            logger.warning(f"  Content very long ({len(result)} chars)")

        return result

    async def _get_fixes(
        self,
        content_text: str,
        timeout: int = 180,
    ) -> List[Dict[str, Any]]:
        """Call Gemini with Google Search to find outdated content."""
        prompt = _get_refresh_prompt(content=content_text)

        try:
            response_schema = self._get_response_schema()

            # Use Google Search for deep research
            result = await self._client.generate_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                use_url_context=False,
                use_google_search=True,  # Enable Google Search for research
                temperature=0.3,
                timeout=timeout,
            )

            if isinstance(result, dict):
                fixes = result.get("fixes", [])
                logger.info(f"  Research found {len(fixes)} potential updates")
                return fixes

            return []

        except (json.JSONDecodeError, ValueError, KeyError) as e:
            logger.warning(f"Stage Refresh response issue: {e}")
            return []
        except ImportError:
            raise
        except Exception as e:
            logger.error(f"Stage Refresh unexpected error: {e}")
            logger.debug("Full traceback:", exc_info=True)
            return []

    def _apply_fixes(
        self,
        article: Dict[str, Any],
        fixes: List[Dict[str, Any]],
    ) -> List[RefreshFix]:
        """Apply refresh fixes to article content."""
        applied = []

        for i, fix_data in enumerate(fixes):
            if len(applied) >= self.MAX_FIXES:
                remaining = len(fixes) - i
                logger.warning(f"  Reached max fixes limit ({self.MAX_FIXES}), {remaining} not applied")
                break

            field = fix_data.get("field") or ""
            find_text = fix_data.get("find") or ""
            replace_text = fix_data.get("replace") or ""
            reason = fix_data.get("reason") or ""

            if not field or not find_text:
                continue

            if find_text == replace_text:
                continue

            if field not in article:
                logger.debug(f"  Field not found: {field}")
                continue

            content = article.get(field, "")
            if not content:
                continue

            content_str = str(content)

            if find_text not in content_str:
                preview = find_text[:50] + ('...' if len(find_text) > 50 else '')
                logger.debug(f"  Text not found in {field}: {preview}")
                continue

            # Apply replacement
            article[field] = content_str.replace(find_text, replace_text, 1)

            applied.append(RefreshFix(
                field=field,
                find=find_text,
                replace=replace_text,
                reason=reason,
            ))

            preview = find_text[:30] + ('...' if len(find_text) > 30 else '')
            logger.debug(f"  Refreshed in {field}: '{preview}'")

        return applied


# =============================================================================
# JSON Interface (Micro-API)
# =============================================================================

async def run_refresh(
    input_data: Dict[str, Any],
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Run Stage Refresh from dict input, return dict output.

    Args:
        input_data: Dictionary with RefreshInput fields
        timeout: Optional timeout for Gemini API call

    Returns:
        Dictionary with RefreshOutput fields
    """
    stage_input = RefreshInput(**input_data)
    refresher = ContentRefresher()
    output = await refresher.run(stage_input, timeout=timeout)
    return output.model_dump()


async def run_from_file(
    input_path: str,
    output_path: Optional[str] = None,
    disabled: bool = False,
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Run Stage Refresh from JSON file.

    Args:
        input_path: Path to input JSON file
        output_path: Optional path to save output JSON
        disabled: If True, skip refresh
        timeout: Optional timeout for Gemini API call

    Returns:
        Dictionary with RefreshOutput fields
    """
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    try:
        with open(input_path, "r", encoding="utf-8") as f:
            input_json = json.load(f)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON in {input_path}: {e}") from e

    # Handle different input formats
    if "article" in input_json:
        refresh_input = copy.deepcopy(input_json)
    else:
        # Wrap raw content as article
        refresh_input = {"article": copy.deepcopy(input_json)}

    if disabled:
        refresh_input["enabled"] = False

    result = await run_refresh(refresh_input, timeout=timeout)

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
# Sync wrapper
# =============================================================================

def run_refresh_sync(
    input_data: Dict[str, Any],
    timeout: Optional[int] = None,
) -> Dict[str, Any]:
    """Synchronous wrapper for run_refresh."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop is not None:
        try:
            import nest_asyncio
            nest_asyncio.apply()
            return asyncio.run(run_refresh(input_data, timeout=timeout))
        except ImportError:
            raise RuntimeError(
                "Cannot run sync wrapper in async context. "
                "Either use 'await run_refresh()' or install nest_asyncio."
            )
    return asyncio.run(run_refresh(input_data, timeout=timeout))


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI entry point."""
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="Stage Refresh: Content Freshener - Update outdated content with current data"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        required=True,
        help="Input JSON file path (article to refresh)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output JSON file path"
    )
    parser.add_argument(
        "--timeout", "-t",
        type=int,
        default=180,
        help="Timeout for Gemini API call in seconds (default: 180)"
    )
    parser.add_argument(
        "--disabled",
        action="store_true",
        help="Skip refresh (passthrough)"
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable debug logging"
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger(__name__).setLevel(logging.DEBUG)
        logging.getLogger().setLevel(logging.DEBUG)

    async def run():
        result = await run_from_file(
            input_path=args.input,
            output_path=args.output,
            disabled=args.disabled,
            timeout=args.timeout,
        )

        print(f"\n=== Stage Refresh Results ===")
        print(f"Updates Applied: {result['fixes_applied']}")
        print(f"AI Calls: {result['ai_calls']}")
        print(f"Skipped: {result['skipped']}")

        if result['fixes']:
            print(f"\nRefresh Updates:")
            for fix in result['fixes']:
                find_preview = fix['find'][:40] + ('...' if len(fix['find']) > 40 else '')
                replace_preview = fix['replace'][:40] + ('...' if len(fix['replace']) > 40 else '')
                reason = fix.get('reason', '')
                reason_suffix = f" ({reason})" if reason else ""
                print(f"  [{fix['field']}]")
                print(f"    OLD: '{find_preview}'")
                print(f"    NEW: '{replace_preview}'{reason_suffix}")

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
        logger.error(f"Stage Refresh failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
