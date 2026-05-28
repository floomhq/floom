"""
Stage 5: Internal Links

Uses sitemap data to embed internal links naturally in blog content.
Gemini finds optimal anchor text and placement.

Uses shared GeminiClient for consistency across all stages.

AI Calls: 1 (link embedding)

Input:
  - Sitemap URLs from Stage 1
  - Article content from Stage 4

Output:
  - Article with internal links embedded
"""

import asyncio
import copy
import json
import logging
import re
import sys
import threading
from pathlib import Path
from typing import Dict, Any, List, Optional, Set
from urllib.parse import urlparse

# Configure logger FIRST before any code that uses it
logger = logging.getLogger(__name__)

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

from stage5_models import Stage5Input, Stage5Output, LinkCandidate, LinkEmbedding

try:
    from shared.gemini_client import GeminiClient
    from shared.field_utils import iter_html_fields
except ImportError as e:
    GeminiClient = None
    iter_html_fields = None
    logger.warning(f"Stage 5 imports failed: {e}")

# Lazy import for google.genai.types (thread-safe singleton)
_types = None
_types_lock = threading.Lock()

def _get_types():
    """Get google.genai.types module (thread-safe lazy import)."""
    global _types
    if _types is None:
        with _types_lock:
            # Double-check locking pattern
            if _types is None:
                from google.genai import types
                _types = types
    return _types

try:
    from shared.prompt_loader import load_prompt
    _PROMPT_LOADER_AVAILABLE = True
except ImportError:
    _PROMPT_LOADER_AVAILABLE = False


def _get_internal_links_prompt(links_text: str, sections_text: str) -> str:
    """Load internal links prompt from file or use fallback."""
    if _PROMPT_LOADER_AVAILABLE:
        try:
            return load_prompt("stage5", "internal_links",
                               links_text=links_text, sections_text=sections_text)
        except FileNotFoundError:
            # Prompt file doesn't exist - expected, use fallback
            logger.debug("Prompt file not found, using fallback")
        except KeyError as e:
            # Missing template variable - bug in prompt file, log warning
            logger.warning(f"Prompt template missing variable: {e}")

    # Fallback prompt
    return f"""You are an SEO expert. Embed these internal links naturally into the article sections.

AVAILABLE LINKS:
{links_text}

ARTICLE SECTIONS:
{sections_text}

RULES:
- Add 3-5 links total across all sections
- Use natural anchor text (NOT "click here", NOT the full URL)
- Spread links across DIFFERENT sections
- Don't link the same URL twice
- The "find" text must be an EXACT, COMPLETE phrase from the section (copy-paste exactly)
- Keep anchor text concise (2-5 words) but COMPLETE (no partial words!)
- Only link phrases that naturally relate to the target page topic
- IMPORTANT: Double-check that your "find" text exists EXACTLY in the section content
- Do NOT truncate words - use complete phrases only"""


class InternalLinker:
    """
    Embeds internal links into article content using shared GeminiClient.
    """

    def __init__(self, api_key: Optional[str] = None):
        """Initialize with shared GeminiClient."""
        if GeminiClient is None:
            raise ImportError("shared.gemini_client not available")

        self._client = GeminiClient(api_key=api_key)
        logger.info("InternalLinker initialized (using shared GeminiClient)")

    async def run(self, input_data: Stage5Input) -> Stage5Output:
        """
        Main entry point - embed internal links in article.

        Args:
            input_data: Validated Stage5Input with article and link sources

        Returns:
            Stage5Output with article containing embedded links

        Raises:
            ValueError: If article data is invalid or missing required structure
        """
        logger.info("Stage 5: Internal Links")

        # Validate article has expected structure
        if not isinstance(input_data.article, dict):
            raise ValueError("article must be a dict")
        if not input_data.article:
            raise ValueError("article cannot be empty")

        article = copy.deepcopy(input_data.article)

        # Build link pool
        link_pool = self._build_link_pool(input_data)
        if not link_pool:
            logger.info("  No links available")
            return Stage5Output(
                article=article,
                links_added=0,
                links_report={"error": "No links available"}
            )

        logger.info(f"  Link pool: {len(link_pool)} candidates")

        # Get content sections for Gemini
        sections_text = self._extract_sections(article)
        if not sections_text:
            logger.warning("  No content sections found")
            return Stage5Output(
                article=article,
                links_added=0,
                links_report={"error": "No content sections"}
            )

        # Call Gemini to get embeddings
        embeddings = await self._get_embeddings(sections_text, link_pool)
        if not embeddings:
            logger.info("  No embeddings suggested")
            return Stage5Output(
                article=article,
                links_added=0,
                links_report={"suggested": 0, "applied": 0}
            )

        # Build valid URL set for validation
        valid_urls = {urlparse(c.url).path for c in link_pool}

        # Apply embeddings
        applied = self._apply_embeddings(article, embeddings, valid_urls)
        logger.info(f"  Applied {applied} internal links")

        return Stage5Output(
            article=article,
            links_added=applied,
            links_report={
                "pool_size": len(link_pool),
                "suggested": len(embeddings),
                "applied": applied
            }
        )

    def _is_current_article(self, url: str, current_href: str) -> bool:
        """Check if URL matches current article (exact segment match)."""
        if not current_href:
            return False
        # Extract path from URL and compare
        url_path = urlparse(url).path.lower().strip("/")
        # Exact match or exact final segment match (not partial)
        if url_path == current_href:
            return True
        # Check if current_href is the exact last segment
        segments = url_path.split("/")
        return segments[-1] == current_href if segments else False

    def _normalize_to_path(self, url: str) -> str:
        """Normalize URL to relative path for consistent deduplication."""
        if not url:
            return ""
        path = urlparse(url).path
        if not path or path == "/":
            return ""
        return path if path.startswith("/") else f"/{path}"

    def _build_link_pool(self, input_data: Stage5Input) -> List[LinkCandidate]:
        """Build pool of candidate links from sitemap and siblings."""
        candidates = []
        seen_paths = set()  # Use paths for consistent dedup

        # Normalize current href for comparison
        current_href = input_data.current_href.lower().strip("/")

        # Add batch siblings first (higher priority) - already relative paths
        for sibling in input_data.batch_siblings[:5]:
            href = sibling.get("href", "")
            if href and not self._is_current_article(href, current_href):
                # Normalize to relative path with leading slash
                rel_path = self._normalize_to_path(href)
                if rel_path and rel_path not in seen_paths:
                    candidates.append(LinkCandidate(
                        url=rel_path,
                        title=sibling.get("keyword", self._url_to_title(href)),
                        source="sibling"
                    ))
                    seen_paths.add(rel_path)

        # Add blog URLs from sitemap (normalize to relative paths for consistency)
        for url in input_data.sitemap_blog_urls[:20]:
            rel_path = self._normalize_to_path(url)
            if rel_path and rel_path not in seen_paths and not self._is_current_article(url, current_href):
                candidates.append(LinkCandidate(
                    url=rel_path,  # Use relative path, not full URL
                    title=self._url_to_title(url),
                    source="sitemap"
                ))
                seen_paths.add(rel_path)

        # Add resource URLs (case studies, etc.)
        for url in input_data.sitemap_resource_urls[:5]:
            rel_path = self._normalize_to_path(url)
            if rel_path and rel_path not in seen_paths and not self._is_current_article(url, current_href):
                candidates.append(LinkCandidate(
                    url=rel_path,  # Use relative path, not full URL
                    title=self._url_to_title(url),
                    source="sitemap"
                ))
                seen_paths.add(rel_path)

        # Add tool/calculator URLs (high value for user engagement)
        for url in input_data.sitemap_tool_urls[:5]:
            rel_path = self._normalize_to_path(url)
            if rel_path and rel_path not in seen_paths and not self._is_current_article(url, current_href):
                candidates.append(LinkCandidate(
                    url=rel_path,
                    title=self._url_to_title(url),
                    source="tool"
                ))
                seen_paths.add(rel_path)

        # Add product URLs
        for url in input_data.sitemap_product_urls[:5]:
            rel_path = self._normalize_to_path(url)
            if rel_path and rel_path not in seen_paths and not self._is_current_article(url, current_href):
                candidates.append(LinkCandidate(
                    url=rel_path,
                    title=self._url_to_title(url),
                    source="product"
                ))
                seen_paths.add(rel_path)

        # Add service URLs
        for url in input_data.sitemap_service_urls[:3]:
            rel_path = self._normalize_to_path(url)
            if rel_path and rel_path not in seen_paths and not self._is_current_article(url, current_href):
                candidates.append(LinkCandidate(
                    url=rel_path,
                    title=self._url_to_title(url),
                    source="service"
                ))
                seen_paths.add(rel_path)

        return candidates

    def _url_to_title(self, url: str) -> str:
        """Extract readable title from URL slug."""
        path = urlparse(url).path
        parts = path.strip("/").split("/")
        slug = parts[-1] if parts else ""
        # Remove file extension if present
        if "." in slug:
            slug = slug.rsplit(".", 1)[0]
        title = slug.replace("-", " ").replace("_", " ").title()
        return title or "Related Article"

    def _extract_sections(self, article: Dict[str, Any], max_chars: int = 50000) -> str:
        """Extract HTML content sections for Gemini prompt.

        Args:
            article: Article dict with content fields
            max_chars: Maximum total characters to prevent context overflow

        Returns:
            Formatted sections text, or empty string if extraction fails
        """
        if iter_html_fields is None:
            logger.error("iter_html_fields not available - shared.field_utils import failed")
            return ""
        sections = []
        total_chars = 0
        for field, content in iter_html_fields(article):
            # Check if adding this section would exceed limit
            section_text = f"[{field}]\n{content}"
            if total_chars + len(section_text) > max_chars:
                logger.warning(f"  Truncating sections at {total_chars} chars (limit: {max_chars})")
                break
            sections.append(section_text)
            total_chars += len(section_text)
        return "\n\n".join(sections)

    async def _get_embeddings(self, sections_text: str, link_pool: List[LinkCandidate]) -> List[LinkEmbedding]:
        """Call Gemini to get link embedding suggestions using structured output."""
        # Format link pool for prompt - use _normalize_to_path for consistency
        links_text = "\n".join(
            f"- {c.title}: {self._normalize_to_path(c.url)}" for c in link_pool[:15]
        )

        prompt = _get_internal_links_prompt(links_text, sections_text)

        try:
            # Build response schema for structured output
            types = _get_types()
            embedding_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "field": types.Schema(type=types.Type.STRING, description="Field name e.g. section_01_content"),
                    "find": types.Schema(type=types.Type.STRING, description="Exact phrase to find"),
                    "replace": types.Schema(type=types.Type.STRING, description="Replacement with <a> tag"),
                },
                required=["field", "find", "replace"],
            )

            response_schema = types.Schema(
                type=types.Type.OBJECT,
                properties={
                    "embeddings": types.Schema(
                        type=types.Type.ARRAY,
                        items=embedding_schema,
                        description="List of link embeddings",
                    ),
                },
                required=["embeddings"],
            )

            # Use shared GeminiClient with schema (no grounding needed)
            result = await self._client.generate_with_schema(
                prompt=prompt,
                response_schema=response_schema,
                use_url_context=False,
                use_google_search=False,
                temperature=0.3,
            )

            embeddings_data = result.get("embeddings", [])

            embeddings = []
            for e in embeddings_data:
                if e.get("field") and e.get("find") and e.get("replace"):
                    embeddings.append(LinkEmbedding(
                        field=e["field"],
                        find=e["find"],
                        replace=e["replace"]
                    ))

            logger.info(f"  Gemini suggested {len(embeddings)} embeddings")
            return embeddings

        except asyncio.TimeoutError:
            # API call timed out - recoverable, return empty
            logger.warning("Gemini API timeout - skipping internal links")
            return []
        except json.JSONDecodeError as e:
            # Schema should prevent this, but handle gracefully if Gemini returns invalid JSON
            logger.warning(f"Gemini returned invalid JSON: {e}")
            return []
        except ValueError as e:
            # GeminiClient raises ValueError if no JSON found in response
            logger.warning(f"Gemini response parsing failed: {e}")
            return []

    # Tags where we should NOT insert links (would create invalid/ugly HTML)
    _NO_LINK_TAGS = ('a', 'button', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre',
                     'script', 'style', 'textarea', 'svg', 'label', 'option')

    # Pre-compiled patterns for efficient tag matching
    # Pattern matches: <tag> or <tag followed by whitespace/attributes
    # This prevents <a from matching <aside, <article, etc.
    _TAG_PATTERNS = {
        tag: (re.compile(rf'<{tag}[>\s]', re.IGNORECASE), f'</{tag}>')
        for tag in _NO_LINK_TAGS
    }

    def _is_position_protected(self, content: str, pos: int) -> bool:
        """Check if a specific position is inside a protected tag.

        Uses pre-compiled regex patterns for efficiency.
        """
        before = content[:pos].lower()

        for open_pattern, close_tag in self._TAG_PATTERNS.values():
            # Find last occurrence of opening tag pattern
            last_open = -1
            for m in open_pattern.finditer(before):
                last_open = m.start()

            if last_open == -1:
                continue  # No opening tag found - skip

            last_close = before.rfind(close_tag)

            if last_open > last_close:
                return True

        return False

    def _strip_html_tags(self, text: str) -> str:
        """Remove HTML tags from text, keeping only content."""
        return re.sub(r'<[^>]+>', '', text)

    def _validate_replacement(self, find_text: str, replace_text: str, valid_urls: Set[str]) -> Optional[str]:
        """
        Validate replacement is a safe <a> tag with URL from our pool.

        Args:
            find_text: Text to find in content
            replace_text: Replacement HTML with <a> tag
            valid_urls: Set of valid URL paths from link pool

        Returns:
            URL path if valid, None if invalid.
        """
        # Check find_text is not empty
        if not find_text or len(find_text.strip()) < 2:
            return None

        # Validate <a> tag format - handle both quotes and href anywhere in tag
        # Pattern: <a ...href="url"... or <a ...href='url'...>content</a>
        match = re.match(
            r'^<a\s+[^>]*href=["\']([^"\']+)["\'][^>]*>(.+)</a>$',
            replace_text,
            re.IGNORECASE | re.DOTALL
        )
        if not match:
            logger.debug(f"  Invalid <a> tag format: {replace_text[:50]}...")
            return None

        url = match.group(1)
        anchor_text = match.group(2)

        # Strip nested HTML tags from anchor for comparison
        anchor_plain = self._strip_html_tags(anchor_text).strip()

        # Normalize URL to relative path for validation
        url_path = urlparse(url).path

        # Validate URL is from our pool
        if url_path not in valid_urls:
            logger.debug(f"  URL not in pool: {url_path}")
            return None

        # Validate anchor text matches find_text (Gemini should use same text)
        # Compare stripped versions
        find_plain = find_text.strip()
        if anchor_plain != find_plain:
            # Check if anchor is substring of find or vice versa
            if find_plain not in anchor_plain and anchor_plain not in find_plain:
                logger.debug(f"  Anchor mismatch: '{anchor_plain}' vs '{find_plain}'")
                # Still allow - Gemini might shorten anchor

        # Return path for consistent deduplication
        return url_path

    def _find_first_unprotected(self, content: str, find_text: str) -> int:
        """Find position of first unprotected occurrence of find_text.

        Returns:
            Position of first safe occurrence, or -1 if none found.
        """
        start = 0
        while True:
            pos = content.find(find_text, start)
            if pos == -1:
                return -1

            if not self._is_position_protected(content, pos):
                return pos

            start = pos + 1

    def _apply_embeddings(self, article: Dict[str, Any], embeddings: List[LinkEmbedding], valid_urls: Set[str]) -> int:
        """Apply embeddings to article content.

        Args:
            article: Article dict to modify in place
            embeddings: List of link embeddings from Gemini
            valid_urls: Set of valid URL paths from link pool
        """
        applied = 0
        used_urls = set()

        for emb in embeddings:
            field = emb.field
            find_text = emb.find
            replace_text = emb.replace

            # Skip if field doesn't exist
            if field not in article:
                continue

            content = article.get(field, "")

            # Type check: ensure content is a string
            if not isinstance(content, str) or not content:
                continue

            # Check if find text exists (cheapest check first)
            if find_text not in content:
                logger.debug(f"  Text not found in {field}: {find_text[:50]}...")
                continue

            # Find first UNPROTECTED occurrence
            safe_pos = self._find_first_unprotected(content, find_text)
            if safe_pos == -1:
                logger.debug(f"  Text inside protected tag in {field}: {find_text[:30]}...")
                continue

            # Validate replacement format and URL (more expensive - do last)
            url = self._validate_replacement(find_text, replace_text, valid_urls)
            if not url:
                continue

            # Check for duplicate URLs
            if url in used_urls:
                continue
            used_urls.add(url)

            # Apply replacement at the safe position
            article[field] = content[:safe_pos] + replace_text + content[safe_pos + len(find_text):]
            applied += 1
            logger.debug(f"  Embedded link in {field}: {url}")

        return applied


async def run_stage_5(input_data: Dict[str, Any], api_key: Optional[str] = None) -> Dict[str, Any]:
    """
    Convenience function to run Stage 5.

    Args:
        input_data: Dict matching Stage5Input schema. Must contain:
            - article: Dict with content fields
            - Optional: sitemap_blog_urls, sitemap_resource_urls, batch_siblings
        api_key: Optional Gemini API key (uses env var if not provided)

    Returns:
        Dict matching Stage5Output schema with:
            - article: Modified article with embedded links
            - links_added: Count of links successfully embedded
            - links_report: Details about link pool and application

    Raises:
        ValueError: If input_data is missing required 'article' key
        pydantic.ValidationError: If input_data doesn't match Stage5Input schema
        ImportError: If shared.gemini_client is not available
    """
    if not isinstance(input_data, dict):
        raise ValueError("input_data must be a dict")
    if "article" not in input_data:
        raise ValueError("input_data must contain 'article' key")

    stage_input = Stage5Input(**input_data)
    linker = InternalLinker(api_key=api_key)
    output = await linker.run(stage_input)
    return output.model_dump()


if __name__ == "__main__":
    # Configure logging for CLI usage
    logging.basicConfig(level=logging.INFO)

    # Test with example data
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
        try:
            with open(input_file, "r") as f:
                test_input = json.load(f)
            result = asyncio.run(run_stage_5(test_input))
            print(json.dumps(result, indent=2))
        except FileNotFoundError:
            print(f"Error: File not found: {input_file}")
            sys.exit(1)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON in {input_file}: {e}")
            sys.exit(1)
    else:
        print("Usage: python stage_5.py <input.json>")
