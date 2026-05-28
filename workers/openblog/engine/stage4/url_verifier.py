"""
URL Verifier - AI-powered URL verification and replacement.

Uses shared GeminiClient with:
- google_search: Find replacement sources for dead URLs
- url_context: Verify URL content relevance

Requires: GEMINI_API_KEY environment variable
"""

import logging
import sys
from pathlib import Path
from typing import List, Dict, Any, Optional

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

try:
    from shared.gemini_client import GeminiClient
    from google.genai import types
except ImportError:
    GeminiClient = None
    types = None

try:
    from shared.prompt_loader import load_prompt
    _PROMPT_LOADER_AVAILABLE = True
except ImportError:
    _PROMPT_LOADER_AVAILABLE = False

logger = logging.getLogger(__name__)


def _get_url_verify_prompt(urls_list: str, keyword: str) -> str:
    """Load URL verify prompt from file or use fallback."""
    if _PROMPT_LOADER_AVAILABLE:
        try:
            return load_prompt("stage4", "url_verify",
                               urls_list=urls_list, keyword=keyword)
        except FileNotFoundError:
            logger.warning("Prompt file not found, using fallback")

    # Fallback prompt
    return f"""Use the url_context tool to check each of these URLs:

{urls_list}

Expected topic: {keyword}

For each URL, assess whether the page content is relevant to the expected topic."""


def _get_find_replacements_prompt(urls_list: str, keyword: str) -> str:
    """Load find replacements prompt from file or use fallback."""
    if _PROMPT_LOADER_AVAILABLE:
        try:
            return load_prompt("stage4", "find_replacements",
                               urls_list=urls_list, keyword=keyword)
        except FileNotFoundError:
            logger.warning("Prompt file not found, using fallback")

    # Fallback prompt (minimal)
    return f"""These URLs are dead/broken and need replacements:

{urls_list}

Topic: {keyword}

Use Google Search to find working replacement URLs for each."""


class URLVerifier:
    """
    AI-powered URL verification using shared GeminiClient.

    Features:
    - google_search: Find replacement URLs when sources are dead
    - url_context: Verify content relevance for live URLs
    - Structured output: Schema-validated responses
    """

    TIMEOUT = 60

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize URL verifier.

        Args:
            api_key: Gemini API key (default: GEMINI_API_KEY env var)
        """
        if GeminiClient is None:
            raise ImportError("shared.gemini_client not available")

        self._client = GeminiClient(api_key=api_key)
        logger.info("URLVerifier initialized (using shared GeminiClient)")

    async def verify_urls_batch(
        self,
        urls: List[str],
        keyword: str,
        max_urls: int = 10
    ) -> Dict[str, Dict[str, Any]]:
        """
        Verify multiple URLs' content relevance in one call.

        Gemini will use url_context tool multiple times to check each URL.

        Args:
            urls: List of URLs to verify
            keyword: Expected topic/keyword
            max_urls: Maximum URLs to process in one call

        Returns:
            Dict mapping url -> {content_relevant, content_summary, relevance_reason}
        """
        if not urls:
            return {}

        if len(urls) > max_urls:
            logger.warning(f"Truncating {len(urls)} URLs to {max_urls} for batch verification")
        urls_to_process = urls[:max_urls]
        urls_list = "\n".join(f"- {url}" for url in urls_to_process)

        prompt = _get_url_verify_prompt(urls_list, keyword)

        try:
            # Build structured output schema
            result_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "url": types.Schema(type=types.Type.STRING, description="The URL checked"),
                    "content_relevant": types.Schema(type=types.Type.BOOLEAN, description="Whether content is relevant to topic"),
                    "content_summary": types.Schema(type=types.Type.STRING, description="Brief 1-sentence summary"),
                    "relevance_reason": types.Schema(type=types.Type.STRING, description="Why it is or isn't relevant"),
                },
                required=["url", "content_relevant", "content_summary", "relevance_reason"],
            )

            response_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "results": types.Schema(
                        type=types.Type.ARRAY,
                        items=result_schema,
                        description="List of URL verification results",
                    ),
                },
                required=["results"],
            )

            result = await self._client.generate_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                use_url_context=True,
                use_google_search=False,
                temperature=0.1,
                timeout=self.TIMEOUT * 2,
            )

            verification_results = {}

            for item in result.get("results", []):
                url = item.get("url", "")
                if url:
                    verification_results[url] = {
                        "content_relevant": item.get("content_relevant", True),
                        "content_summary": item.get("content_summary", ""),
                        "relevance_reason": item.get("relevance_reason", "")
                    }

            return verification_results

        except Exception as e:
            logger.warning(f"Batch content verification failed: {e}")
            return {}

    async def find_replacements_batch(
        self,
        dead_urls: List[str],
        keyword: str,
        url_contexts: Optional[Dict[str, str]] = None,
        max_urls: int = 10
    ) -> Dict[str, Dict[str, str]]:
        """
        Find replacements for multiple dead URLs in one call.

        Args:
            dead_urls: List of dead URLs
            keyword: Primary keyword for context
            url_contexts: Dict mapping url -> surrounding sentence context
            max_urls: Maximum URLs to process in one call

        Returns:
            Dict mapping old_url -> {new_url, source_name, anchor_text, reason}
        """
        if not dead_urls:
            return {}

        if len(dead_urls) > max_urls:
            logger.warning(f"Truncating {len(dead_urls)} dead URLs to {max_urls} for replacement search")
        urls_to_process = dead_urls[:max_urls]
        url_contexts = url_contexts or {}

        # Build URL list with context
        urls_with_context = []
        for url in urls_to_process:
            ctx = url_contexts.get(url, "")
            if ctx:
                urls_with_context.append(f"- URL: {url}\n  Context: {ctx}")
            else:
                urls_with_context.append(f"- URL: {url}")
        urls_list = "\n".join(urls_with_context)

        prompt = _get_find_replacements_prompt(urls_list, keyword)

        try:
            # Build structured output schema
            replacement_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "old_url": types.Schema(type=types.Type.STRING, description="Original dead URL"),
                    "new_url": types.Schema(type=types.Type.STRING, description="Replacement URL"),
                    "source_name": types.Schema(type=types.Type.STRING, description="Source name (e.g., GitHub Blog)"),
                    "anchor_text": types.Schema(type=types.Type.STRING, description="Natural anchor text that flows in sentence"),
                    "reason": types.Schema(type=types.Type.STRING, description="Why this replacement works"),
                },
                required=["old_url", "new_url", "source_name", "anchor_text", "reason"],
            )

            response_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "replacements": types.Schema(
                        type=types.Type.ARRAY,
                        items=replacement_schema,
                        description="List of URL replacements",
                    ),
                },
                required=["replacements"],
            )

            result = await self._client.generate_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                use_url_context=False,
                use_google_search=True,
                extract_sources=True,  # Get real URLs from grounding metadata
                temperature=0.1,
                timeout=self.TIMEOUT * 2,
            )

            # Get real URLs from grounding metadata
            grounding_urls = set()
            for source in result.get("_grounding_sources", []):
                if source.get("url"):
                    grounding_urls.add(source["url"])

            if grounding_urls:
                logger.info(f"Found {len(grounding_urls)} real URLs from Google Search grounding")

            replacements = {}

            for item in result.get("replacements", []):
                old_url = item.get("old_url", "")
                new_url = item.get("new_url", "")

                if old_url and new_url:
                    # Validate: only accept URLs that appear in grounding sources
                    # (or if no grounding sources found, accept all - fallback)
                    if grounding_urls and new_url not in grounding_urls:
                        logger.warning(f"Skipping hallucinated URL (not in grounding): {new_url[:60]}...")
                        continue

                    replacements[old_url] = {
                        "new_url": new_url,
                        "source_name": item.get("source_name", ""),
                        "anchor_text": item.get("anchor_text", ""),
                        "reason": item.get("reason", "")
                    }

            return replacements

        except Exception as e:
            logger.warning(f"Batch replacement search failed: {e}")
            return {}

    async def rewrite_for_removals_batch(
        self,
        removals: List[Dict[str, str]],
        keyword: str,
    ) -> Dict[str, Dict[str, str]]:
        """
        Ask AI to rewrite text around dead links that couldn't be replaced.

        Instead of just stripping the anchor tag (leaving awkward text),
        AI rewrites the sentence to flow naturally without the link.

        Args:
            removals: List of dicts with:
                - field: Field name containing the link
                - url: The dead URL
                - sentence: The sentence containing the link
                - anchor_text: The text inside the anchor tag
            keyword: Primary keyword for context

        Returns:
            Dict mapping url -> {original_sentence, rewritten_sentence}
        """
        if not removals:
            return {}

        # Build list of sentences to rewrite
        items_list = []
        for i, item in enumerate(removals[:10], 1):  # Max 10
            items_list.append(
                f"{i}. Sentence: \"{item.get('sentence', '')}\"\n"
                f"   Dead link anchor text: \"{item.get('anchor_text', '')}\"\n"
                f"   URL being removed: {item.get('url', '')}"
            )
        items_str = "\n\n".join(items_list)

        prompt = f"""These sentences contain links to dead URLs that must be removed.
Rewrite each sentence to flow naturally WITHOUT the link reference.

Topic context: {keyword}

Sentences to rewrite:

{items_str}

Rules:
- Remove the link reference entirely, don't just strip the anchor tag
- Keep the sentence meaning intact
- Make it flow naturally without referencing the now-dead source
- If the sentence was citing a stat/fact from the dead link, generalize it (e.g., "industry research shows" instead of "Forbes 2024 report shows")
- Keep the same tone and style
- Return the EXACT original sentence and the rewritten version"""

        try:
            rewrite_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "url": types.Schema(type=types.Type.STRING, description="The dead URL"),
                    "original_sentence": types.Schema(type=types.Type.STRING, description="Original sentence with link"),
                    "rewritten_sentence": types.Schema(type=types.Type.STRING, description="Rewritten sentence without link reference"),
                },
                required=["url", "original_sentence", "rewritten_sentence"],
            )

            response_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "rewrites": types.Schema(
                        type=types.Type.ARRAY,
                        items=rewrite_schema,
                        description="List of sentence rewrites",
                    ),
                },
                required=["rewrites"],
            )

            result = await self._client.generate_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                use_url_context=False,
                use_google_search=False,
                temperature=0.3,
                timeout=self.TIMEOUT,
            )

            rewrites = {}
            for item in result.get("rewrites", []):
                url = item.get("url", "")
                if url:
                    rewrites[url] = {
                        "original_sentence": item.get("original_sentence", ""),
                        "rewritten_sentence": item.get("rewritten_sentence", ""),
                    }

            return rewrites

        except Exception as e:
            logger.warning(f"Batch rewrite for removals failed: {e}")
            return {}
