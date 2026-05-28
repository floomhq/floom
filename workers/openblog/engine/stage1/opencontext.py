"""
OpenContext - Company Context Extraction via Gemini

Extracts comprehensive company context from a URL using Google Gemini AI
with Google Search grounding.

Uses shared GeminiClient for consistency across all stages.
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Dict, Any, Optional, Tuple, List

import httpx

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

from stage1_models import CompanyContext

try:
    from shared.gemini_client import GeminiClient
except ImportError:
    GeminiClient = None  # Fallback mode

logger = logging.getLogger(__name__)


# =============================================================================
# OpenContext Prompt - loaded from prompts/opencontext.txt
# =============================================================================

try:
    from shared.prompt_loader import load_prompt
    _PROMPT_LOADER_AVAILABLE = True
except ImportError:
    _PROMPT_LOADER_AVAILABLE = False


def _get_opencontext_prompt(url: str) -> str:
    """Load OpenContext prompt from file or use fallback."""
    if _PROMPT_LOADER_AVAILABLE:
        try:
            return load_prompt("stage1", "opencontext", url=url)
        except FileNotFoundError:
            logger.warning("Prompt file not found, using fallback")

    # Fallback prompt (minimal version)
    return f'''Analyze the company website at {url} and extract company context.
Return JSON with: company_name, company_url, industry, description, products,
target_audience, competitors, tone, voice_persona, visual_identity.
Analyze: {url}'''


# =============================================================================
# Image URL Validation
# =============================================================================

# Common image content types
IMAGE_CONTENT_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/gif",
    "image/webp", "image/svg+xml", "image/avif", "image/heic"
}


async def validate_image_url(url: str, timeout: float = 5.0) -> bool:
    """
    Validate that a URL points to an actual image.

    Args:
        url: Image URL to validate
        timeout: Request timeout in seconds

    Returns:
        True if URL returns 200 with image content-type, False otherwise
    """
    if not url or not url.startswith("http"):
        return False

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            # Use HEAD request first (faster, less bandwidth)
            response = await client.head(url)

            # Check status code
            if response.status_code < 200 or response.status_code >= 300:
                logger.debug(f"Image URL validation failed (HTTP {response.status_code}): {url[:60]}...")
                return False

            # Check content type
            content_type = response.headers.get("content-type", "").lower().split(";")[0].strip()
            if content_type in IMAGE_CONTENT_TYPES:
                return True

            # Some servers don't return content-type on HEAD, try GET with range
            if not content_type or content_type == "application/octet-stream":
                response = await client.get(url, headers={"Range": "bytes=0-0"})
                content_type = response.headers.get("content-type", "").lower().split(";")[0].strip()
                if content_type in IMAGE_CONTENT_TYPES:
                    return True

            logger.debug(f"Image URL has non-image content-type ({content_type}): {url[:60]}...")
            return False

    except Exception as e:
        logger.debug(f"Image URL validation error: {url[:60]}... - {e}")
        return False


async def validate_blog_image_examples(context: CompanyContext) -> CompanyContext:
    """
    Validate blog_image_examples URLs and clear invalid ones.

    Keeps the description (useful for style reference) but clears URL if invalid.

    Args:
        context: CompanyContext with potentially invalid image URLs

    Returns:
        CompanyContext with validated image URLs (invalid URLs cleared)
    """
    if not context.visual_identity or not context.visual_identity.blog_image_examples:
        return context

    examples = context.visual_identity.blog_image_examples
    validated_count = 0
    cleared_count = 0

    # Validate all URLs in parallel
    tasks = [validate_image_url(ex.url) for ex in examples]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    for i, (example, is_valid) in enumerate(zip(examples, results)):
        if isinstance(is_valid, Exception):
            is_valid = False

        if is_valid:
            example.validated = True
            validated_count += 1
        else:
            # Clear invalid URL but keep description (still useful for style)
            if example.url:
                logger.info(f"Clearing invalid image URL: {example.url[:60]}...")
                example.url = ""
                cleared_count += 1
            example.validated = False

    if cleared_count > 0:
        logger.warning(
            f"Blog image URL validation: {validated_count} valid, {cleared_count} cleared (hallucinated/broken)"
        )
    elif validated_count > 0:
        logger.info(f"Blog image URL validation: {validated_count} valid URLs")

    return context


# =============================================================================
# Gemini Client
# =============================================================================

async def run_opencontext(url: str, api_key: Optional[str] = None) -> CompanyContext:
    """
    Run OpenContext analysis on a company URL.

    Uses shared GeminiClient with URL Context + Google Search grounding.

    Args:
        url: Company website URL
        api_key: Gemini API key (falls back to GEMINI_API_KEY env var)

    Returns:
        CompanyContext with extracted company information

    Raises:
        ValueError: If no API key provided
        Exception: If Gemini call fails
    """
    # Normalize URL
    if not url.startswith("http"):
        url = f"https://{url}"

    logger.info(f"Running OpenContext for {url}")

    try:
        # Use shared GeminiClient
        if GeminiClient is None:
            raise ImportError("shared.gemini_client not available")

        client = GeminiClient(api_key=api_key)

        # Build prompt (loaded from prompts/opencontext.txt)
        prompt = _get_opencontext_prompt(url)

        # Call with URL Context + Google Search grounding
        result = await client.generate(
            prompt=prompt,
            use_url_context=True,
            use_google_search=True,
            json_output=True,
            temperature=0.3,
        )

        logger.info(f"OpenContext complete: {result.get('company_name', 'Unknown')}")

        # Convert to CompanyContext
        context = CompanyContext.from_dict(result)

        # Validate blog image URLs (clears hallucinated/broken URLs)
        context = await validate_blog_image_examples(context)

        return context

    except Exception as e:
        logger.error(f"OpenContext failed for {url}: {e}")
        raise


# =============================================================================
# Fallback: Basic Detection (no AI)
# =============================================================================

def basic_company_detection(url: str) -> CompanyContext:
    """
    Basic company detection from URL when no API key available.

    Extracts company name from domain. No AI call.

    Args:
        url: Company website URL

    Returns:
        CompanyContext with basic info from URL
    """
    from urllib.parse import urlparse

    # Normalize URL
    if not url.startswith("http"):
        url = f"https://{url}"

    # Extract domain
    domain = urlparse(url).netloc.replace("www.", "")
    company_name = domain.split(".")[0].replace("-", " ").title()

    logger.warning(f"Using basic detection for {url} (no API key)")

    return CompanyContext(
        company_name=company_name,
        company_url=url,
        industry="",
        description="",
        products=[],
        target_audience="",
        competitors=[],
        tone="professional",
        pain_points=[],
        value_propositions=[],
        use_cases=[],
        content_themes=[],
    )


# =============================================================================
# Main Entry Point
# =============================================================================

async def get_company_context(
    url: str,
    api_key: Optional[str] = None,
    fallback_on_error: bool = True
) -> Tuple[CompanyContext, bool]:
    """
    Get company context, with optional fallback to basic detection.

    Args:
        url: Company website URL
        api_key: Gemini API key (optional, uses env var)
        fallback_on_error: If True, returns basic detection on error

    Returns:
        Tuple of (CompanyContext, ai_called: bool)
    """
    # Check if API key available
    api_key = api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")

    if not api_key:
        if fallback_on_error:
            logger.warning("No API key, using basic detection")
            return basic_company_detection(url), False
        else:
            raise ValueError("No Gemini API key available")

    try:
        context = await run_opencontext(url, api_key)
        return context, True
    except Exception as e:
        if fallback_on_error:
            logger.warning(f"OpenContext failed, using basic detection: {e}")
            return basic_company_detection(url), False
        else:
            raise


# =============================================================================
# CLI for standalone testing
# =============================================================================

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python opencontext.py <company_url>")
        sys.exit(1)

    url = sys.argv[1]

    async def main():
        context, ai_called = await get_company_context(url)
        print(json.dumps(context.model_dump(), indent=2))
        print(f"\nAI called: {ai_called}")

    asyncio.run(main())
