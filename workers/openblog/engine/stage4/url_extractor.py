"""
URL Extractor - Extract all URLs from article content.

Dynamically scans all string fields in the article for external URLs.
Uses shared.field_utils for field discovery (single source of truth).
"""

import re
import logging
import sys
from pathlib import Path
from typing import Dict, Any, Set, List
from urllib.parse import urlparse

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

try:
    from shared.field_utils import iter_url_fields
except ImportError:
    iter_url_fields = None

logger = logging.getLogger(__name__)

# URL extraction regex - matches http:// and https:// URLs
URL_PATTERN = re.compile(
    r'https?://[^\s<>"\')\]]+',
    re.IGNORECASE
)

# Pattern to detect URLs inside img src attributes (to skip them)
IMG_SRC_PATTERN = re.compile(
    r'<img\s+[^>]*src=["\']([^"\']+)["\']',
    re.IGNORECASE
)

# Characters that commonly trail URLs but aren't part of them
TRAILING_CHARS = ".,;:!?)]}"


class URLExtractor:
    """
    Extracts URLs from article content.

    Features:
    - Scans all content fields
    - Cleans trailing punctuation
    - Deduplicates URLs
    - Maps URLs to their source fields
    """

    def __init__(self, skip_domains: List[str] = None):
        """
        Initialize extractor.

        Args:
            skip_domains: Domains to exclude (e.g., image hosts)
        """
        self.skip_domains = set(skip_domains or [])

    def _iter_content_fields(self, article: Dict[str, Any]):
        """Iterate over all string fields that may contain URLs."""
        if iter_url_fields is not None:
            yield from iter_url_fields(article)
        else:
            # Fallback: iterate all string fields
            for field, content in article.items():
                if isinstance(content, str) and content:
                    yield field, content

    def _get_img_src_urls(self, content: str) -> Set[str]:
        """Extract URLs from img src attributes (to exclude from verification)."""
        return set(IMG_SRC_PATTERN.findall(content))

    def extract_urls(self, article: Dict[str, Any]) -> Set[str]:
        """
        Extract all unique URLs from article content.

        Skips img src URLs (images are verified separately).

        Args:
            article: ArticleOutput dict

        Returns:
            Set of unique URLs (cleaned)
        """
        urls = set()

        for field, content in self._iter_content_fields(article):
            img_urls = self._get_img_src_urls(content)

            for url in URL_PATTERN.findall(content):
                cleaned = self._clean_url(url)
                if cleaned and not self._should_skip(cleaned) and cleaned not in img_urls:
                    urls.add(cleaned)

        # Extract from Sources field (list of {title, url} dicts)
        sources = article.get("Sources", [])
        if isinstance(sources, list):
            for source in sources:
                if isinstance(source, dict):
                    url = source.get("url")
                    if url and not self._should_skip(url):
                        urls.add(url)

        logger.info(f"Extracted {len(urls)} unique URLs from article")
        return urls

    def extract_urls_with_fields(self, article: Dict[str, Any]) -> Dict[str, List[str]]:
        """
        Extract URLs and map them to their source fields.

        Skips img src URLs (images are verified separately).

        Args:
            article: ArticleOutput dict

        Returns:
            Dict mapping field_name -> list of URLs in that field
        """
        field_urls = {}

        for field, content in self._iter_content_fields(article):
            img_urls = self._get_img_src_urls(content)

            cleaned_urls = []
            for url in URL_PATTERN.findall(content):
                cleaned = self._clean_url(url)
                if cleaned and not self._should_skip(cleaned) and cleaned not in img_urls:
                    cleaned_urls.append(cleaned)

            if cleaned_urls:
                field_urls[field] = cleaned_urls

        # Extract from Sources field (list of {title, url} dicts)
        sources = article.get("Sources", [])
        if isinstance(sources, list):
            source_urls = []
            for source in sources:
                if isinstance(source, dict):
                    url = source.get("url")
                    if url and not self._should_skip(url):
                        source_urls.append(url)
            if source_urls:
                field_urls["Sources"] = source_urls

        total = sum(len(urls) for urls in field_urls.values())
        logger.info(f"Extracted {total} URLs from {len(field_urls)} fields")
        return field_urls

    def get_url_field_map(self, article: Dict[str, Any]) -> Dict[str, List[str]]:
        """
        Create reverse mapping: URL -> list of fields containing it.

        Useful for knowing which fields to update when replacing a URL.
        Skips img src URLs (images are verified separately).

        Args:
            article: ArticleOutput dict

        Returns:
            Dict mapping url -> list of field names
        """
        url_fields = {}

        for field, content in self._iter_content_fields(article):
            img_urls = self._get_img_src_urls(content)

            for url in URL_PATTERN.findall(content):
                cleaned = self._clean_url(url)
                if cleaned and not self._should_skip(cleaned) and cleaned not in img_urls:
                    if cleaned not in url_fields:
                        url_fields[cleaned] = []
                    if field not in url_fields[cleaned]:
                        url_fields[cleaned].append(field)

        # Extract from Sources field (list of {title, url} dicts)
        sources = article.get("Sources", [])
        if isinstance(sources, list):
            for source in sources:
                if isinstance(source, dict):
                    url = source.get("url")
                    if url and not self._should_skip(url):
                        if url not in url_fields:
                            url_fields[url] = []
                        if "Sources" not in url_fields[url]:
                            url_fields[url].append("Sources")

        return url_fields

    def _clean_url(self, url: str) -> str:
        """Clean trailing punctuation from URL."""
        cleaned = url.rstrip(TRAILING_CHARS)

        # Handle markdown-style links: [text](url)
        if cleaned.endswith(")") and "(" not in cleaned:
            cleaned = cleaned[:-1]

        return cleaned

    def _should_skip(self, url: str) -> bool:
        """Check if URL should be skipped based on domain."""
        if not self.skip_domains:
            return False

        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower()

            # Check exact match and subdomain match
            for skip_domain in self.skip_domains:
                skip_domain = skip_domain.lower()
                if domain == skip_domain or domain.endswith("." + skip_domain):
                    return True

            return False
        except Exception:
            return False


def extract_urls(article: Dict[str, Any], skip_domains: List[str] = None) -> Set[str]:
    """
    Convenience function to extract URLs.

    Args:
        article: ArticleOutput dict
        skip_domains: Domains to exclude

    Returns:
        Set of unique URLs
    """
    extractor = URLExtractor(skip_domains)
    return extractor.extract_urls(article)
