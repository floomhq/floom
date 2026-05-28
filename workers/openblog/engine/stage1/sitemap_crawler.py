"""
Sitemap Crawler - Fetch and Label URLs from Company Sitemap

Fetches all URLs from a company's sitemap and auto-labels them by type:
- blog, product, service, docs, resource, company, legal, contact, landing, tool, other

Uses hybrid smart classifier for sites without standard /blog/ patterns:
1. Fast path: Standard /blog/ patterns → immediate classification
2. Smart classifier: URL structure + sitemap metadata + title sampling + AI fallback
"""

import asyncio
import logging
import re
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

import httpx
from httpx import Timeout, Limits

try:
    import defusedxml.ElementTree as ET
except ImportError:
    import xml.etree.ElementTree as ET

from stage1_models import SitemapData
from constants import MAX_SITEMAP_URLS

logger = logging.getLogger(__name__)


# =============================================================================
# URL Entry with Metadata
# =============================================================================

@dataclass
class URLEntry:
    """URL entry with sitemap metadata."""
    url: str
    priority: Optional[float] = None
    changefreq: Optional[str] = None
    lastmod: Optional[str] = None


# =============================================================================
# URL Pattern Matching
# =============================================================================

# Default URL patterns for page type classification
URL_PATTERNS: Dict[str, List[str]] = {
    "blog": [
        r"\/blog\/?",
        r"\/magazine\/?",
        r"\/magazin\/?",  # German spelling
        r"\/news\/?",
        r"\/articles?\/?",
        r"\/posts?\/?",
        r"\/insights?\/?",
        r"\/stories\/?",
        r"\/updates?\/?",
        r"\/press\/?",
    ],
    "product": [
        r"\/products?\/?",
        r"\/solutions?\/?",
        r"\/pricing\/?",
        r"\/features?\/?",
        r"\/plans?\/?",
        r"\/offerings?\/?",
        r"\/store\/?",
        r"\/shop\/?",
        r"\/catalog\/?",
    ],
    "service": [
        r"\/services?\/?",
        r"\/consulting\/?",
        r"\/agency\/?",
        r"\/professional-services\/?",
    ],
    "docs": [
        r"\/docs?\/?",
        r"\/documentation\/?",
        r"\/guides?\/?",
        r"\/tutorials?\/?",
        r"\/help\/?",
        r"\/kb\/?",
        r"\/knowledge-base\/?",
        r"\/faq\/?",
    ],
    "resource": [
        r"\/whitepapers?\/?",
        r"\/case-studies?\/?",
        r"\/case_studies?\/?",
        r"\/templates?\/?",
        r"\/tools?\/?",
        r"\/calculators?\/?",
        r"\/webinars?\/?",
        r"\/videos?\/?",
        r"\/ebooks?\/?",
        r"\/reports?\/?",
        r"\/resources?\/?",
    ],
    "company": [
        r"\/about\/?",
        r"\/about-us\/?",
        r"\/team\/?",
        r"\/careers?\/?",
        r"\/jobs?\/?",
        r"\/culture\/?",
        r"\/company\/?",
        r"\/who-we-are\/?",
    ],
    "legal": [
        r"\/imprint\/?",
        r"\/impressum\/?",
        r"\/privacy\/?",
        r"\/privacy-policy\/?",
        r"\/datenschutz\/?",  # German for privacy
        r"\/terms\/?",
        r"\/agb\/?",  # German for terms (Allgemeine Geschäftsbedingungen)
        r"\/legal\/?",
        r"\/disclaimer\/?",
        r"\/cookies?\/?",
        r"\/gdpr\/?",
        r"\/dsgvo\/?",  # German for GDPR
    ],
    "contact": [
        r"\/contact\/?",
        r"\/contact-us\/?",
        r"\/get-in-touch\/?",
        r"\/support\/?",
    ],
    "landing": [
        r"\/campaigns?\/?",
        r"\/lp\/?",
        r"\/landing\/?",
        r"\/offers?\/?",
        r"\/promotions?\/?",
    ],
}


def classify_url(url: str) -> str:
    """
    Classify a URL based on path patterns.

    Args:
        url: URL to classify

    Returns:
        Label string: blog, product, service, docs, resource, company, legal, contact, landing, other
    """
    path = urlparse(url).path.lower()

    for label, patterns in URL_PATTERNS.items():
        for pattern in patterns:
            if re.search(pattern, path):
                return label

    return "other"


# =============================================================================
# Sitemap Crawler
# =============================================================================

class SitemapCrawler:
    """
    Crawls company sitemap and returns labeled URLs.

    Features:
    - Handles sitemap.xml and sitemap_index.xml
    - Auto-labels URLs by type (blog, product, service, tool, etc.)
    - Smart classifier for sites without standard /blog/ patterns
    - Optional HTTP validation to filter broken links
    - Caching with TTL
    - Configurable URL limit
    """

    # Dangerous URL protocols to reject
    DANGEROUS_PROTOCOLS = [
        'javascript:', 'file:', 'data:', 'vbscript:',
        'about:', 'chrome:', 'chrome-extension:'
    ]

    # Maximum number of cache entries to prevent memory leaks in long-running processes
    MAX_CACHE_ENTRIES = 100

    # Threshold for triggering smart classifier (ratio of other_urls to total)
    SMART_CLASSIFIER_THRESHOLD = 0.7

    # Minimum "other" URLs to trigger smart classifier
    SMART_CLASSIFIER_MIN_OTHER = 50

    def __init__(
        self,
        max_urls: int = MAX_SITEMAP_URLS,
        timeout: float = 10.0,
        cache_ttl: int = 3600,
        validate_urls: bool = False,
        validation_sample_size: int = 50,
        validation_concurrency: int = 10,
        max_cache_entries: int = None,
        enable_smart_classifier: bool = True,
        smart_classifier_sample_size: int = 20,
        enable_ai_fallback: bool = False,
        gemini_client = None,
    ):
        """
        Initialize crawler.

        Args:
            max_urls: Maximum URLs to return
            timeout: HTTP timeout in seconds (default 10)
            cache_ttl: Cache TTL in seconds (default 3600 = 1 hour)
            validate_urls: If True, validate URLs with HEAD requests
            validation_sample_size: Max URLs to validate (for performance)
            validation_concurrency: Max concurrent validation requests
            max_cache_entries: Maximum cache entries (default: 100)
            enable_smart_classifier: Enable smart classifier for non-standard sites
            smart_classifier_sample_size: URLs to sample for title fetching
            enable_ai_fallback: Enable AI for pattern discovery (requires gemini_client)
            gemini_client: GeminiClient for AI fallback
        """
        self.max_urls = max_urls
        self.timeout = Timeout(connect=5.0, read=timeout, write=5.0, pool=5.0)
        self.cache_ttl = cache_ttl
        self.validate_urls = validate_urls
        self.validation_sample_size = validation_sample_size
        self.validation_concurrency = validation_concurrency
        self.max_cache_entries = max_cache_entries or self.MAX_CACHE_ENTRIES
        self.enable_smart_classifier = enable_smart_classifier
        self.smart_classifier_sample_size = smart_classifier_sample_size
        self.enable_ai_fallback = enable_ai_fallback
        self.gemini_client = gemini_client
        self._cache: OrderedDict[str, Tuple[SitemapData, float]] = OrderedDict()
        self._url_metadata: Dict[str, URLEntry] = {}  # Store metadata for smart classifier

    async def crawl(self, company_url: str, validate: Optional[bool] = None) -> SitemapData:
        """
        Crawl company's sitemap and return labeled URLs.

        Args:
            company_url: Company website URL (e.g., "https://example.com")
            validate: Override validate_urls setting for this call

        Returns:
            SitemapData with categorized URLs
        """
        start_time = time.time()
        should_validate = validate if validate is not None else self.validate_urls

        # Normalize URL
        company_url = company_url.rstrip('/')
        if not company_url.startswith("http"):
            company_url = f"https://{company_url}"

        logger.info(f"Crawling sitemap for {company_url}")

        # Check cache - include all parameters that affect output
        cache_key = f"{company_url}:{self.max_urls}:{should_validate}:{self.validation_sample_size}:{self.enable_smart_classifier}"
        if cache_key in self._cache:
            data, timestamp = self._cache[cache_key]
            if time.time() - timestamp < self.cache_ttl:
                logger.info(f"Returning cached sitemap ({data.total_pages} URLs)")
                return data

        try:
            # Fetch all URLs with metadata for smart classifier
            entries = await self._fetch_all_urls_with_metadata(company_url)

            if not entries:
                logger.warning(f"No URLs found in sitemap for {company_url}")
                return SitemapData()

            # Store metadata for smart classifier
            self._url_metadata = {e.url: e for e in entries}
            urls = [e.url for e in entries]

            # Limit URLs
            if len(urls) > self.max_urls:
                logger.info(f"Limiting {len(urls)} URLs to {self.max_urls}")
                urls = urls[:self.max_urls]

            # Optional: Validate URLs with HEAD requests
            if should_validate:
                urls = await self._validate_urls(urls)
                logger.info(f"After validation: {len(urls)} valid URLs")

            # Classify and group URLs (with smart classifier if enabled)
            if self.enable_smart_classifier:
                result = await self._classify_urls_smart(urls)
            else:
                result = self._classify_urls(urls)

            # Cache result with LRU eviction
            self._cache[cache_key] = (result, time.time())
            # Evict oldest entries if cache exceeds max size
            while len(self._cache) > self.max_cache_entries:
                oldest_key = next(iter(self._cache))
                self._cache.pop(oldest_key)
                logger.debug(f"Cache evicted: {oldest_key[:50]}...")

            duration = time.time() - start_time
            logger.info(f"Sitemap crawl complete: {result.total_pages} URLs in {duration:.2f}s")
            if result.smart_classifier_used:
                logger.info(f"Smart classifier: method={result.classification_method}, "
                           f"confidence={result.classification_confidence:.2f}")

            return result

        except Exception as e:
            logger.error(f"Sitemap crawl failed for {company_url}: {e}")
            return SitemapData()

    async def _validate_urls(self, urls: List[str]) -> List[str]:
        """
        Validate URLs with HEAD requests, filter out broken ones.

        Args:
            urls: List of URLs to validate

        Returns:
            List of valid URLs (status 2xx or 3xx)
        """
        # Sample if too many URLs
        if len(urls) > self.validation_sample_size:
            logger.info(f"Sampling {self.validation_sample_size} URLs for validation")
            # Keep first N for validation, assume rest are valid
            urls_to_check = urls[:self.validation_sample_size]
            urls_to_keep = urls[self.validation_sample_size:]
        else:
            urls_to_check = urls
            urls_to_keep = []

        valid_urls = []
        semaphore = asyncio.Semaphore(self.validation_concurrency)

        async def check_url(url: str) -> Optional[str]:
            async with semaphore:
                try:
                    async with httpx.AsyncClient(
                        timeout=Timeout(connect=3.0, read=5.0, write=3.0, pool=3.0),
                        follow_redirects=True,
                        limits=Limits(max_connections=20)
                    ) as client:
                        response = await client.head(url)
                        if response.status_code < 400:
                            return url
                        else:
                            logger.debug(f"Invalid URL ({response.status_code}): {url}")
                            return None
                except Exception as e:
                    logger.debug(f"URL validation failed: {url} - {e}")
                    return None

        # Run validation in parallel
        logger.info(f"Validating {len(urls_to_check)} URLs...")
        tasks = [check_url(url) for url in urls_to_check]
        results = await asyncio.gather(*tasks)

        # Collect valid URLs
        valid_urls = [url for url in results if url is not None]

        # Add back the unchecked URLs (assumed valid)
        valid_urls.extend(urls_to_keep)

        invalid_count = len(urls_to_check) - len([u for u in results if u])
        if invalid_count > 0:
            logger.info(f"Filtered out {invalid_count} broken URLs")

        return valid_urls

    async def _fetch_all_urls(self, company_url: str) -> List[str]:
        """
        Fetch all URLs from sitemap(s).

        Tries multiple sitemap locations and handles sitemap_index.xml.
        """
        entries = await self._fetch_all_urls_with_metadata(company_url)
        return [e.url for e in entries]

    async def _fetch_all_urls_with_metadata(self, company_url: str) -> List[URLEntry]:
        """
        Fetch all URLs with metadata from sitemap(s).

        Tries multiple sitemap locations and handles sitemap_index.xml.
        Returns URLEntry objects with priority, changefreq, lastmod.
        """
        all_entries: List[URLEntry] = []

        # Standard sitemap locations
        sitemap_locations = [
            f"{company_url}/sitemap.xml",
            f"{company_url}/sitemap_index.xml",
            f"{company_url}/sitemap/sitemap.xml",
        ]

        # Also try www version if not present
        parsed = urlparse(company_url)
        if not parsed.netloc.startswith("www."):
            www_base = f"{parsed.scheme}://www.{parsed.netloc}"
            sitemap_locations.extend([
                f"{www_base}/sitemap.xml",
                f"{www_base}/sitemap_index.xml",
            ])

        async with httpx.AsyncClient(
            timeout=self.timeout,
            follow_redirects=True,
            limits=Limits(max_connections=5, max_keepalive_connections=2)
        ) as client:
            for sitemap_url in sitemap_locations:
                try:
                    await asyncio.sleep(0.3)  # Rate limiting

                    response = await client.get(sitemap_url)

                    if response.status_code != 200:
                        continue

                    root = ET.fromstring(response.content)
                    ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

                    # Check if this is a sitemap_index
                    sitemaps = root.findall(".//sm:sitemap/sm:loc", ns)
                    if sitemaps:
                        logger.info(f"Found sitemap_index with {len(sitemaps)} sitemaps")
                        # Fetch all sub-sitemaps concurrently
                        tasks = [
                            self._fetch_sub_sitemap_with_metadata(client, elem.text.strip())
                            for elem in sitemaps if elem.text and elem.text.strip()
                        ]
                        results = await asyncio.gather(*tasks, return_exceptions=True)
                        for result in results:
                            if isinstance(result, list):
                                all_entries.extend(result)
                        break
                    else:
                        # Regular sitemap
                        entries = self._extract_urls_with_metadata(response.content)
                        all_entries.extend(entries)
                        logger.info(f"Found {len(entries)} URLs in {sitemap_url}")
                        break

                except Exception as e:
                    logger.debug(f"Failed to fetch {sitemap_url}: {e}")
                    continue

        # Deduplicate by URL
        seen = set()
        unique_entries = []
        for entry in all_entries:
            if entry.url not in seen:
                seen.add(entry.url)
                unique_entries.append(entry)

        return unique_entries

    async def _fetch_sub_sitemap(self, client: httpx.AsyncClient, url: str) -> List[str]:
        """Fetch URLs from a sub-sitemap."""
        try:
            await asyncio.sleep(0.2)  # Rate limiting
            response = await client.get(url)
            if response.status_code == 200:
                return self._extract_urls(response.content)
        except Exception as e:
            logger.debug(f"Failed to fetch sub-sitemap {url}: {e}")
        return []

    async def _fetch_sub_sitemap_with_metadata(self, client: httpx.AsyncClient, url: str) -> List[URLEntry]:
        """Fetch URLs with metadata from a sub-sitemap."""
        try:
            await asyncio.sleep(0.2)  # Rate limiting
            response = await client.get(url)
            if response.status_code == 200:
                return self._extract_urls_with_metadata(response.content)
        except Exception as e:
            logger.debug(f"Failed to fetch sub-sitemap {url}: {e}")
        return []

    def _extract_urls(self, content: bytes) -> List[str]:
        """Extract URLs from sitemap XML content."""
        urls = []
        try:
            root = ET.fromstring(content)
            ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
            for elem in root.findall(".//sm:url/sm:loc", ns):
                # Check both that text exists and is not just whitespace
                if elem.text and elem.text.strip() and self._is_valid_url(elem.text.strip()):
                    urls.append(elem.text.strip())
        except ET.ParseError as e:
            logger.warning(f"Failed to parse XML: {e}")
        return urls

    def _extract_urls_with_metadata(self, content: bytes) -> List[URLEntry]:
        """Extract URLs with full metadata from sitemap XML content."""
        entries = []
        try:
            root = ET.fromstring(content)
            ns = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

            for url_elem in root.findall(".//sm:url", ns):
                loc_elem = url_elem.find("sm:loc", ns)
                # Use 'is None' check - Element with no children evaluates to falsy
                if loc_elem is None or not loc_elem.text or not loc_elem.text.strip():
                    continue

                url = loc_elem.text.strip()
                if not self._is_valid_url(url):
                    continue

                # Extract optional metadata
                priority = None
                priority_elem = url_elem.find("sm:priority", ns)
                if priority_elem is not None and priority_elem.text:
                    try:
                        priority = float(priority_elem.text.strip())
                    except ValueError:
                        pass

                changefreq = None
                changefreq_elem = url_elem.find("sm:changefreq", ns)
                if changefreq_elem is not None and changefreq_elem.text:
                    changefreq = changefreq_elem.text.strip().lower()

                lastmod = None
                lastmod_elem = url_elem.find("sm:lastmod", ns)
                if lastmod_elem is not None and lastmod_elem.text:
                    lastmod = lastmod_elem.text.strip()

                entries.append(URLEntry(
                    url=url,
                    priority=priority,
                    changefreq=changefreq,
                    lastmod=lastmod,
                ))

        except ET.ParseError as e:
            logger.warning(f"Failed to parse XML: {e}")

        return entries

    def _is_valid_url(self, url: str) -> bool:
        """Validate URL - reject dangerous protocols."""
        if not url or not isinstance(url, str):
            return False
        url_lower = url.lower().strip()
        if any(url_lower.startswith(proto) for proto in self.DANGEROUS_PROTOCOLS):
            return False
        try:
            parsed = urlparse(url)
            return parsed.scheme in ['http', 'https'] and bool(parsed.netloc)
        except Exception:
            return False

    def _classify_urls(self, urls: List[str]) -> SitemapData:
        """Classify all URLs and return SitemapData (sync version)."""
        blog_urls = []
        product_urls = []
        service_urls = []
        resource_urls = []
        docs_urls = []
        tool_urls = []
        other_urls = []

        for url in urls:
            label = classify_url(url)
            if label == "blog":
                blog_urls.append(url)
            elif label == "product":
                product_urls.append(url)
            elif label == "service":
                service_urls.append(url)
            elif label == "resource":
                resource_urls.append(url)
            elif label == "docs":
                docs_urls.append(url)
            else:
                other_urls.append(url)

        return SitemapData(
            total_pages=len(urls),
            blog_urls=blog_urls,
            product_urls=product_urls,
            service_urls=service_urls,
            resource_urls=resource_urls,
            docs_urls=docs_urls,
            tool_urls=tool_urls,
            other_urls=other_urls,
        )

    async def _classify_urls_smart(self, urls: List[str]) -> SitemapData:
        """
        Classify URLs with smart classifier fallback.

        Uses pattern matching first, then smart classifier if too many URLs
        end up in "other" category.
        """
        # First pass: pattern-based classification
        blog_urls = []
        product_urls = []
        service_urls = []
        resource_urls = []
        docs_urls = []
        tool_urls = []
        other_urls = []

        for url in urls:
            label = classify_url(url)
            if label == "blog":
                blog_urls.append(url)
            elif label == "product":
                product_urls.append(url)
            elif label == "service":
                service_urls.append(url)
            elif label == "resource":
                resource_urls.append(url)
            elif label == "docs":
                docs_urls.append(url)
            else:
                other_urls.append(url)

        total = len(urls)
        other_ratio = len(other_urls) / total if total > 0 else 0

        # Check if smart classifier should be triggered
        should_use_smart = (
            self.enable_smart_classifier and
            len(other_urls) >= self.SMART_CLASSIFIER_MIN_OTHER and
            other_ratio >= self.SMART_CLASSIFIER_THRESHOLD
        )

        classification_method = "pattern"
        classification_confidence = 1.0
        smart_classifier_used = False

        if should_use_smart:
            logger.info(f"Triggering smart classifier: {len(other_urls)} other URLs "
                       f"({other_ratio:.1%} of total)")

            try:
                from smart_classifier import SmartClassifier, SitemapEntry

                # Build entries with metadata
                entries = []
                for url in other_urls:
                    meta = self._url_metadata.get(url)
                    if meta:
                        entries.append(SitemapEntry(
                            url=url,
                            priority=meta.priority,
                            changefreq=meta.changefreq,
                            lastmod=meta.lastmod,
                        ))
                    else:
                        entries.append(SitemapEntry(url=url))

                classifier = SmartClassifier(
                    sample_size=self.smart_classifier_sample_size,
                    enable_ai_fallback=self.enable_ai_fallback,
                    gemini_client=self.gemini_client,
                )

                result = await classifier.classify(
                    entries=entries,
                    known_blog_urls=blog_urls,
                )

                # Update classification with smart results
                # Keep existing blog_urls and add newly discovered ones
                new_blogs = [u for u in result.blog_urls if u not in blog_urls]
                blog_urls.extend(new_blogs)
                tool_urls.extend(result.tool_urls)
                other_urls = result.other_urls

                classification_method = result.method_used
                classification_confidence = result.confidence
                smart_classifier_used = True

                logger.info(f"Smart classifier found {len(new_blogs)} additional blogs, "
                           f"{len(tool_urls)} tools")

            except ImportError as e:
                logger.warning(f"Smart classifier not available: {e}")
            except Exception as e:
                logger.warning(f"Smart classifier failed: {e}")

        return SitemapData(
            total_pages=len(urls),
            blog_urls=blog_urls,
            product_urls=product_urls,
            service_urls=service_urls,
            resource_urls=resource_urls,
            docs_urls=docs_urls,
            tool_urls=tool_urls,
            other_urls=other_urls,
            classification_method=classification_method,
            classification_confidence=classification_confidence,
            smart_classifier_used=smart_classifier_used,
        )


# =============================================================================
# Convenience Function
# =============================================================================

async def crawl_sitemap(
    company_url: str,
    max_urls: int = MAX_SITEMAP_URLS,
    validate_urls: bool = False,
    validation_sample_size: int = 50,
    enable_smart_classifier: bool = True,
    smart_classifier_sample_size: int = 20,
    enable_ai_fallback: bool = False,
    gemini_client = None,
) -> SitemapData:
    """
    Crawl company sitemap and return labeled URLs.

    Args:
        company_url: Company website URL
        max_urls: Maximum URLs to return
        validate_urls: If True, validate URLs with HEAD requests (filters broken links)
        validation_sample_size: Max URLs to validate when validate_urls=True
        enable_smart_classifier: Enable smart classifier for non-standard sites
        smart_classifier_sample_size: URLs to sample for title fetching
        enable_ai_fallback: Enable AI for pattern discovery
        gemini_client: GeminiClient for AI fallback

    Returns:
        SitemapData with categorized URLs
    """
    crawler = SitemapCrawler(
        max_urls=max_urls,
        validate_urls=validate_urls,
        validation_sample_size=validation_sample_size,
        enable_smart_classifier=enable_smart_classifier,
        smart_classifier_sample_size=smart_classifier_sample_size,
        enable_ai_fallback=enable_ai_fallback,
        gemini_client=gemini_client,
    )
    return await crawler.crawl(company_url)


# =============================================================================
# CLI for standalone testing
# =============================================================================

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python sitemap_crawler.py <company_url>")
        sys.exit(1)

    url = sys.argv[1]

    async def main():
        data = await crawl_sitemap(url)
        print(json.dumps(data.model_dump(), indent=2))

    asyncio.run(main())
