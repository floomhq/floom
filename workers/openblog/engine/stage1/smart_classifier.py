"""
Smart URL Classifier - Hybrid approach for accurate blog detection.

Combines multiple signals for URL classification:
1. URL structure analysis (path depth, tool keywords)
2. Sitemap metadata (priority, changefreq, clusters)
3. Page title/meta sampling (keyword matching)
4. AI-assisted pattern discovery (optional fallback)

Designed for sites without standard /blog/ URL patterns (e.g., Hypofriend).
"""

import asyncio
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

import httpx
from httpx import Timeout, Limits

logger = logging.getLogger(__name__)


# =============================================================================
# Constants
# =============================================================================

# Tool/app keywords that indicate non-blog pages
TOOL_KEYWORDS = {
    # German
    "rechner", "kalkulator", "berechnen", "berechnung", "tool", "tools",
    "app", "dashboard", "simulator", "planer", "planner", "konfigurator",
    # English
    "calculator", "calculate", "calculation", "estimator", "estimate",
    "builder", "generator", "wizard", "configurator", "analyzer",
    # Product/service indicators
    "login", "signin", "sign-in", "register", "signup", "sign-up",
    "account", "profile", "settings", "preferences", "checkout", "cart",
    "pricing", "demo", "trial", "download", "install",
}

# Legal/static page keywords that should not be classified as blog
LEGAL_KEYWORDS = {
    # German
    "agb", "impressum", "datenschutz", "dsgvo", "nutzungsbedingungen",
    "widerruf", "widerrufsrecht", "haftungsausschluss",
    # English
    "terms", "privacy", "legal", "disclaimer", "imprint", "gdpr", "cookies",
    "policy", "tos", "eula", "copyright",
    # French
    "mentions-legales", "conditions", "confidentialite",
    # Common
    "contact", "kontakt", "about", "ueber-uns", "karriere", "career", "jobs",
}

# Blog-like title patterns (case-insensitive)
BLOG_TITLE_PATTERNS = [
    r"^(wie|was|warum|wann|wo|wer|welche|ob)\s",  # German question starters
    r"^(how|what|why|when|where|who|which|can|should|do|does|is|are)\s",  # English questions
    r"\d{4}",  # Year in title (common in blog posts)
    r"(tipps?|tips?|guide|leitfaden|ratgeber|erklärt|explained)",  # Guide words
    r"(vorteile|nachteile|vergleich|vs\.?|versus|comparison)",  # Comparison words
    r"(schritt|step|anleitung|tutorial|howto|how-to)",  # Tutorial words
]

# Tool/app title patterns
TOOL_TITLE_PATTERNS = [
    r"(rechner|calculator|kalkulator|estimator)\s*[-–:]?\s*$",
    r"^(online\s+)?(rechner|calculator|tool)",
    r"(berechnen|calculate|compute)\s+(sie|your|the)",
    r"(simulator|konfigurator|configurator|builder|generator)",
]

# Language prefixes that might be before the slug
LANGUAGE_PREFIXES = {"de", "en", "fr", "es", "it", "nl", "pl", "pt", "ru", "ja", "zh"}

# Location page patterns (city/region landing pages, NOT blog posts)
# These are typically /de/service/region/city patterns
LOCATION_PAGE_PATTERNS = [
    # German regions
    r"\/baden-wuerttemberg\/",
    r"\/bayern\/",
    r"\/berlin\/",
    r"\/brandenburg\/",
    r"\/bremen\/",
    r"\/hamburg\/",
    r"\/hessen\/",
    r"\/mecklenburg-vorpommern\/",
    r"\/niedersachsen\/",
    r"\/nordrhein-westfalen\/",
    r"\/rheinland-pfalz\/",
    r"\/saarland\/",
    r"\/sachsen\/",
    r"\/sachsen-anhalt\/",
    r"\/schleswig-holstein\/",
    r"\/thueringen\/",
    # Generic location patterns
    r"\/standort[e]?\/",  # German "locations"
    r"\/locations?\/",
    r"\/cities\/",
    r"\/regions?\/",
]

# Minimum slug length (characters) to be considered a blog post
# Short slugs like "stuttgart" or "berlin" are usually location pages
# Long slugs like "can-i-get-a-credit-loan-to-increase-my-affordability" are blog posts
# NOTE: This only applies to URLs WITHOUT explicit blog patterns (/blog/, /magazine/, etc.)
MIN_BLOG_SLUG_LENGTH = 25

# Blog URL patterns - URLs matching these are ALWAYS blogs regardless of slug length
BLOG_PATH_PATTERNS = [
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
]


# =============================================================================
# Data Classes
# =============================================================================

@dataclass
class SitemapEntry:
    """Enhanced sitemap entry with metadata."""
    url: str
    priority: Optional[float] = None
    changefreq: Optional[str] = None
    lastmod: Optional[str] = None
    path_depth: int = 0
    path_segments: List[str] = field(default_factory=list)

    def __post_init__(self):
        parsed = urlparse(self.url)
        path = parsed.path.strip("/")
        self.path_segments = path.split("/") if path else []
        self.path_depth = len(self.path_segments)


@dataclass
class ClassificationResult:
    """Result of smart classification."""
    blog_urls: List[str] = field(default_factory=list)
    tool_urls: List[str] = field(default_factory=list)
    other_urls: List[str] = field(default_factory=list)
    detected_patterns: Dict[str, str] = field(default_factory=dict)
    confidence: float = 0.0
    method_used: str = "unknown"
    samples_checked: int = 0
    ai_calls: int = 0


@dataclass
class URLScore:
    """Weighted score for URL classification."""
    url: str
    blog_score: float = 0.0
    tool_score: float = 0.0
    signals: Dict[str, float] = field(default_factory=dict)

    @property
    def classification(self) -> str:
        if self.blog_score > self.tool_score + 0.3:
            return "blog"
        elif self.tool_score > self.blog_score + 0.3:
            return "tool"
        return "other"


# =============================================================================
# Smart Classifier
# =============================================================================

class SmartClassifier:
    """
    Hybrid URL classifier combining multiple signals.

    Classification flow:
    1. Fast path: Standard /blog/ patterns → immediate classification
    2. URL analysis: Path structure, depth, tool keywords
    3. Sitemap metadata: Priority, changefreq clustering
    4. Page sampling: Fetch titles/meta for uncertain URLs
    5. AI fallback: Pattern discovery for complex cases (optional)
    """

    def __init__(
        self,
        sample_size: int = 20,
        fetch_timeout: float = 5.0,
        enable_ai_fallback: bool = True,
        gemini_client = None,
    ):
        """
        Initialize smart classifier.

        Args:
            sample_size: Number of URLs to sample for title fetching
            fetch_timeout: Timeout for HTTP requests
            enable_ai_fallback: Whether to use AI for pattern discovery
            gemini_client: Optional GeminiClient for AI fallback
        """
        self.sample_size = sample_size
        self.fetch_timeout = fetch_timeout
        self.enable_ai_fallback = enable_ai_fallback
        self.gemini_client = gemini_client

    async def classify(
        self,
        entries: List[SitemapEntry],
        known_blog_urls: Optional[List[str]] = None,
    ) -> ClassificationResult:
        """
        Classify URLs using hybrid approach.

        Args:
            entries: List of SitemapEntry with metadata
            known_blog_urls: URLs already classified as blog (from patterns)

        Returns:
            ClassificationResult with classified URLs
        """
        known_blog_urls = known_blog_urls or []
        known_blog_set = set(known_blog_urls)

        # Separate already-classified from unknown
        unknown_entries = [e for e in entries if e.url not in known_blog_set]

        if not unknown_entries:
            return ClassificationResult(
                blog_urls=known_blog_urls,
                method_used="pattern_only",
                confidence=1.0,
            )

        logger.info(f"Smart classifier: {len(unknown_entries)} URLs to analyze "
                   f"({len(known_blog_urls)} already classified as blog)")

        # Step 1: URL structure analysis
        url_scores = self._analyze_url_structure(unknown_entries)

        # Step 2: Sitemap metadata analysis (if available)
        self._apply_sitemap_signals(url_scores, entries)

        # Step 3: Cluster analysis (path patterns)
        self._apply_cluster_signals(url_scores, known_blog_urls)

        # Preliminary classification
        high_confidence = [s for s in url_scores.values()
                          if abs(s.blog_score - s.tool_score) > 0.5]
        low_confidence = [s for s in url_scores.values()
                         if abs(s.blog_score - s.tool_score) <= 0.5]

        logger.info(f"After URL/cluster analysis: {len(high_confidence)} high confidence, "
                   f"{len(low_confidence)} need sampling")

        # Step 4: Sample uncertain URLs for title/meta
        samples_checked = 0
        ai_calls = 0

        if low_confidence:
            samples = await self._sample_page_metadata(
                [s.url for s in low_confidence[:self.sample_size]]
            )
            samples_checked = len(samples)

            # Apply title-based signals
            self._apply_title_signals(url_scores, samples)

            # Re-check confidence
            still_uncertain = [s for s in url_scores.values()
                              if abs(s.blog_score - s.tool_score) <= 0.3]

            # Step 5: AI pattern discovery (if enabled and needed)
            if self.enable_ai_fallback and self.gemini_client and len(still_uncertain) > 10:
                logger.info(f"Using AI for {len(still_uncertain)} uncertain URLs")
                patterns = await self._ai_pattern_discovery(url_scores, samples)
                ai_calls = 1
                self._apply_discovered_patterns(url_scores, patterns)

        # Build final result
        result = ClassificationResult(
            blog_urls=list(known_blog_urls),
            tool_urls=[],
            other_urls=[],
            detected_patterns={},
            samples_checked=samples_checked,
            ai_calls=ai_calls,
        )

        for score in url_scores.values():
            classification = score.classification
            if classification == "blog":
                result.blog_urls.append(score.url)
            elif classification == "tool":
                result.tool_urls.append(score.url)
            else:
                result.other_urls.append(score.url)

        # Calculate confidence
        total = len(url_scores)
        high_conf = sum(1 for s in url_scores.values()
                       if abs(s.blog_score - s.tool_score) > 0.3)
        result.confidence = high_conf / total if total > 0 else 1.0
        result.method_used = self._determine_method(samples_checked, ai_calls)

        logger.info(f"Classification complete: {len(result.blog_urls)} blog, "
                   f"{len(result.tool_urls)} tool, {len(result.other_urls)} other "
                   f"(confidence: {result.confidence:.2f})")

        return result

    def _analyze_url_structure(self, entries: List[SitemapEntry]) -> Dict[str, URLScore]:
        """Analyze URL structure for classification signals."""
        scores = {}

        for entry in entries:
            score = URLScore(url=entry.url)
            path = "/" + "/".join(entry.path_segments) + ("/" if entry.path_segments else "")
            path_lower = path.lower()

            # Check for explicit blog path patterns FIRST - these are ALWAYS blogs
            has_blog_pattern = False
            for pattern in BLOG_PATH_PATTERNS:
                if re.search(pattern, path_lower, re.IGNORECASE):
                    score.blog_score += 2.0  # Strong override - always a blog
                    score.signals["blog_path_pattern"] = 2.0
                    has_blog_pattern = True
                    break

            # If has blog pattern, skip other checks - it's definitely a blog
            if has_blog_pattern:
                scores[entry.url] = score
                continue

            # Check for location page patterns (these are NOT blog posts)
            is_location_page = False
            for pattern in LOCATION_PAGE_PATTERNS:
                if re.search(pattern, path_lower, re.IGNORECASE):
                    score.tool_score += 0.6  # Strong signal - push to "other"
                    score.signals["location_page"] = 0.6
                    is_location_page = True
                    break

            # Check for legal/static page keywords (these should never be blogs)
            is_legal = False
            if not is_location_page:
                for segment in entry.path_segments:
                    segment_lower = segment.lower()
                    if segment_lower in LEGAL_KEYWORDS:
                        score.tool_score += 0.5  # Use tool_score to push to "other"
                        score.signals["legal_keyword"] = 0.5
                        is_legal = True
                        break

            # Check for tool keywords in path
            if not is_legal and not is_location_page:
                for segment in entry.path_segments:
                    segment_lower = segment.lower()
                    if segment_lower in TOOL_KEYWORDS:
                        score.tool_score += 0.5
                        score.signals["tool_keyword"] = 0.5
                        break
                    # Partial match for compound words - stronger if at end (suffix)
                    for kw in TOOL_KEYWORDS:
                        if kw in segment_lower:
                            # Suffix match (e.g., "baufinanzierungsrechner" ends with "rechner")
                            if segment_lower.endswith(kw):
                                score.tool_score += 0.5
                                score.signals["tool_keyword_suffix"] = 0.5
                            else:
                                score.tool_score += 0.25
                                score.signals["tool_keyword_partial"] = 0.25
                            break

            # Slug length analysis - HARD REQUIREMENT for blog detection (when no blog pattern)
            # Long slugs like "can-i-get-a-credit-loan-to-increase-my-affordability" are blogs
            # Short slugs like "stuttgart" or "monheim-am-rhein" are location/category pages
            # This is a hard filter - short slugs CANNOT be blogs unless they have /blog/ etc.
            if entry.path_segments:
                last_segment = entry.path_segments[-1]
                # Remove file extension if present
                slug = re.sub(r'\.[a-z]{2,4}$', '', last_segment, flags=re.IGNORECASE)
                slug_length = len(slug)

                if slug_length >= MIN_BLOG_SLUG_LENGTH:
                    # Long descriptive slug - strong blog signal
                    score.blog_score += 0.4
                    score.signals["long_slug"] = 0.4
                else:
                    # Short slug - HARD DISQUALIFIER from being a blog
                    # Add strong penalty to ensure it goes to "other" not "blog"
                    score.tool_score += 1.0
                    score.signals["short_slug_disqualifier"] = 1.0

            # Language prefix at depth 1 suggests content page (weak signal)
            if entry.path_depth >= 2 and entry.path_segments[0].lower() in LANGUAGE_PREFIXES:
                score.blog_score += 0.05
                score.signals["lang_prefix"] = 0.05

            # Slug-like last segment (hyphens, no numbers-only)
            if entry.path_segments:
                last_segment = entry.path_segments[-1]
                if "-" in last_segment and not last_segment.replace("-", "").isdigit():
                    score.blog_score += 0.1
                    score.signals["slug_format"] = 0.1

            # Very short paths (1 segment) are usually category/landing pages
            if entry.path_depth == 1:
                score.signals["short_path"] = -0.1

            scores[entry.url] = score

        return scores

    def _apply_sitemap_signals(
        self,
        scores: Dict[str, URLScore],
        entries: List[SitemapEntry]
    ):
        """Apply signals from sitemap metadata."""
        # Analyze priority distribution
        priorities = [e.priority for e in entries if e.priority is not None]
        if not priorities:
            return

        avg_priority = sum(priorities) / len(priorities)

        # Analyze changefreq distribution
        changefreq_counts = Counter(e.changefreq for e in entries if e.changefreq)

        entry_map = {e.url: e for e in entries}

        for url, score in scores.items():
            entry = entry_map.get(url)
            if not entry:
                continue

            # High priority + frequent updates → likely blog
            if entry.priority is not None:
                if entry.priority >= 0.7:
                    score.blog_score += 0.15
                    score.signals["high_priority"] = 0.15
                elif entry.priority <= 0.3:
                    score.tool_score += 0.1
                    score.signals["low_priority"] = 0.1

            if entry.changefreq in ("daily", "weekly"):
                score.blog_score += 0.1
                score.signals["frequent_update"] = 0.1
            elif entry.changefreq in ("never", "yearly"):
                score.tool_score += 0.05
                score.signals["rare_update"] = 0.05

    def _apply_cluster_signals(
        self,
        scores: Dict[str, URLScore],
        known_blog_urls: List[str]
    ):
        """Apply signals from URL clustering patterns."""
        if not known_blog_urls:
            return

        # Analyze path patterns of known blogs
        known_patterns = set()
        known_depths = Counter()

        for url in known_blog_urls:
            parsed = urlparse(url)
            segments = parsed.path.strip("/").split("/")
            depth = len(segments)
            known_depths[depth] += 1

            # Extract pattern (first N-1 segments as prefix)
            if len(segments) >= 2:
                prefix = "/".join(segments[:-1])
                known_patterns.add(prefix.lower())

        # Find dominant depth for blogs
        if known_depths:
            dominant_depth = known_depths.most_common(1)[0][0]

            for url, score in scores.items():
                parsed = urlparse(url)
                segments = parsed.path.strip("/").split("/")
                depth = len(segments)

                # Same depth as known blogs
                if depth == dominant_depth:
                    score.blog_score += 0.2
                    score.signals["matching_depth"] = 0.2

                # Matching prefix pattern
                if len(segments) >= 2:
                    prefix = "/".join(segments[:-1]).lower()
                    if prefix in known_patterns:
                        score.blog_score += 0.3
                        score.signals["matching_prefix"] = 0.3

    async def _sample_page_metadata(
        self,
        urls: List[str]
    ) -> Dict[str, Dict[str, str]]:
        """Fetch title and meta description from sample URLs."""
        results = {}
        semaphore = asyncio.Semaphore(5)

        async def fetch_meta(url: str) -> Optional[Tuple[str, Dict[str, str]]]:
            async with semaphore:
                try:
                    async with httpx.AsyncClient(
                        timeout=Timeout(connect=3.0, read=self.fetch_timeout),
                        follow_redirects=True,
                        limits=Limits(max_connections=10)
                    ) as client:
                        response = await client.get(url)
                        if response.status_code != 200:
                            return None

                        html = response.text[:50000]  # Limit to first 50KB

                        # Extract title
                        title_match = re.search(
                            r'<title[^>]*>([^<]+)</title>',
                            html, re.IGNORECASE
                        )
                        title = title_match.group(1).strip() if title_match else ""

                        # Extract meta description
                        desc_match = re.search(
                            r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)["\']',
                            html, re.IGNORECASE
                        )
                        if not desc_match:
                            desc_match = re.search(
                                r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']description["\']',
                                html, re.IGNORECASE
                            )
                        description = desc_match.group(1).strip() if desc_match else ""

                        # Extract h1
                        h1_match = re.search(r'<h1[^>]*>([^<]+)</h1>', html, re.IGNORECASE)
                        h1 = h1_match.group(1).strip() if h1_match else ""

                        return url, {
                            "title": title,
                            "description": description,
                            "h1": h1,
                        }

                except Exception as e:
                    logger.debug(f"Failed to fetch metadata for {url}: {e}")
                    return None

        logger.info(f"Sampling metadata from {len(urls)} URLs...")
        tasks = [fetch_meta(url) for url in urls]
        fetched = await asyncio.gather(*tasks)

        for result in fetched:
            if result:
                url, meta = result
                results[url] = meta

        logger.info(f"Successfully fetched metadata from {len(results)} URLs")
        return results

    def _apply_title_signals(
        self,
        scores: Dict[str, URLScore],
        samples: Dict[str, Dict[str, str]]
    ):
        """Apply signals based on page titles and descriptions."""
        for url, meta in samples.items():
            if url not in scores:
                continue

            score = scores[url]
            title = meta.get("title", "").lower()
            h1 = meta.get("h1", "").lower()
            description = meta.get("description", "").lower()
            combined = f"{title} {h1} {description}"

            # Check for blog-like patterns
            for pattern in BLOG_TITLE_PATTERNS:
                if re.search(pattern, combined, re.IGNORECASE):
                    score.blog_score += 0.3
                    score.signals["blog_title_pattern"] = 0.3
                    break

            # Check for tool-like patterns
            for pattern in TOOL_TITLE_PATTERNS:
                if re.search(pattern, combined, re.IGNORECASE):
                    score.tool_score += 0.4
                    score.signals["tool_title_pattern"] = 0.4
                    break

            # Question-style title → likely blog
            if title.endswith("?"):
                score.blog_score += 0.2
                score.signals["question_title"] = 0.2

    async def _ai_pattern_discovery(
        self,
        scores: Dict[str, URLScore],
        samples: Dict[str, Dict[str, str]]
    ) -> Dict[str, str]:
        """Use AI to discover classification patterns."""
        if not self.gemini_client:
            return {}

        # Prepare sample data for AI
        sample_data = []
        for url, meta in list(samples.items())[:15]:
            parsed = urlparse(url)
            sample_data.append({
                "path": parsed.path,
                "title": meta.get("title", "")[:100],
                "description": meta.get("description", "")[:200],
            })

        prompt = f"""Analyze these URLs from a website and classify each as "blog", "tool", or "other".
Then describe the URL pattern for each category so we can classify remaining URLs.

Sample pages:
{sample_data}

Respond in JSON format:
{{
    "classifications": [
        {{"path": "/de/example", "category": "blog"}}
    ],
    "patterns": {{
        "blog": "Description of URL pattern for blog posts",
        "tool": "Description of URL pattern for tools/calculators",
        "other": "Description of other page patterns"
    }}
}}
"""

        try:
            result = await self.gemini_client.generate(
                prompt=prompt,
                use_google_search=False,
                use_url_context=False,
                json_output=True,
                temperature=0.2,
            )

            patterns = result.get("patterns", {})
            classifications = result.get("classifications", [])

            # Apply AI classifications to sampled URLs
            for item in classifications:
                path = item.get("path", "")
                category = item.get("category", "")

                # Find matching URL
                for url, score in scores.items():
                    if urlparse(url).path == path:
                        if category == "blog":
                            score.blog_score += 0.4
                            score.signals["ai_classification"] = 0.4
                        elif category == "tool":
                            score.tool_score += 0.4
                            score.signals["ai_classification"] = 0.4
                        break

            return patterns

        except Exception as e:
            logger.warning(f"AI pattern discovery failed: {e}")
            return {}

    def _apply_discovered_patterns(
        self,
        scores: Dict[str, URLScore],
        patterns: Dict[str, str]
    ):
        """Apply AI-discovered patterns to remaining URLs."""
        # This is a placeholder for pattern-based extrapolation
        # The actual implementation would parse the pattern descriptions
        # and apply them to remaining URLs
        pass

    def _determine_method(self, samples_checked: int, ai_calls: int) -> str:
        """Determine which method was primarily used."""
        if ai_calls > 0:
            return "ai_assisted"
        elif samples_checked > 0:
            return "title_sampling"
        else:
            return "url_analysis"


# =============================================================================
# Convenience Function
# =============================================================================

async def smart_classify(
    urls: List[str],
    metadata: Optional[Dict[str, Dict]] = None,
    known_blog_urls: Optional[List[str]] = None,
    sample_size: int = 20,
    enable_ai: bool = False,
    gemini_client = None,
) -> ClassificationResult:
    """
    Smart classify URLs using hybrid approach.

    Args:
        urls: List of URLs to classify
        metadata: Optional dict mapping URL to {priority, changefreq, lastmod}
        known_blog_urls: URLs already classified as blog
        sample_size: Number of URLs to sample for metadata
        enable_ai: Enable AI-assisted pattern discovery
        gemini_client: GeminiClient for AI (required if enable_ai=True)

    Returns:
        ClassificationResult with classified URLs
    """
    metadata = metadata or {}

    # Build entries
    entries = []
    for url in urls:
        meta = metadata.get(url, {})
        entries.append(SitemapEntry(
            url=url,
            priority=meta.get("priority"),
            changefreq=meta.get("changefreq"),
            lastmod=meta.get("lastmod"),
        ))

    classifier = SmartClassifier(
        sample_size=sample_size,
        enable_ai_fallback=enable_ai,
        gemini_client=gemini_client,
    )

    return await classifier.classify(entries, known_blog_urls)


# =============================================================================
# CLI for Testing
# =============================================================================

if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python smart_classifier.py <urls_json_file>")
        print("       python smart_classifier.py --test")
        sys.exit(1)

    if sys.argv[1] == "--test":
        # Test with sample Hypofriend-like URLs
        test_urls = [
            "https://example.com/de/baufinanzierung-rechner",
            "https://example.com/de/wie-viel-haus-kann-ich-mir-leisten",
            "https://example.com/de/tilgungsrechner",
            "https://example.com/de/immobilienkredit-tipps",
            "https://example.com/de/was-kostet-ein-haus-in-berlin",
            "https://example.com/en/mortgage-calculator",
            "https://example.com/en/how-to-buy-a-house-in-germany",
        ]

        async def test():
            result = await smart_classify(test_urls)
            print(f"Blog: {result.blog_urls}")
            print(f"Tool: {result.tool_urls}")
            print(f"Other: {result.other_urls}")
            print(f"Confidence: {result.confidence:.2f}")
            print(f"Method: {result.method_used}")

        asyncio.run(test())
    else:
        with open(sys.argv[1]) as f:
            urls = json.load(f)

        async def main():
            result = await smart_classify(urls)
            print(json.dumps({
                "blog_urls": result.blog_urls,
                "tool_urls": result.tool_urls,
                "other_urls": result.other_urls,
                "confidence": result.confidence,
                "method_used": result.method_used,
            }, indent=2))

        asyncio.run(main())
