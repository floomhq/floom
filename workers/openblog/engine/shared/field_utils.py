"""
Field Utilities - Derive field categories from ArticleOutput model.

Single source of truth: All stages use these helpers instead of hardcoded lists.
Stage 2 defines the schema, Stages 3-5 derive their field lists from it.
"""

from typing import List, Set, Iterator, Tuple, Any, Dict
import logging

logger = logging.getLogger(__name__)

# Import ArticleOutput - the master schema
try:
    from shared.models import ArticleOutput
    _MODEL_AVAILABLE = True
except ImportError:
    try:
        from models import ArticleOutput
        _MODEL_AVAILABLE = True
    except ImportError:
        ArticleOutput = None
        _MODEL_AVAILABLE = False


# =============================================================================
# Field Categories (derived from ArticleOutput.model_fields)
# =============================================================================

# Fields to exclude from content processing (not text content)
_EXCLUDE_PATTERNS = (
    'url',           # image_XX_url - URLs, not text
    'credit',        # image_XX_credit - attribution
    'Sources',       # Contains URLs, handled separately
    'Search_Queries',# Metadata, not content
    'quality_',      # quality_score, quality_failed - metrics
    'tables',        # List[ComparisonTable], not string
    'Meta_',         # Meta_Title, Meta_Description - SEO, not body
    'Lead_',         # Lead_Survey_Title/Button - optional lead gen
)

# Fields that typically contain HTML (for internal linking)
_HTML_FIELD_PATTERNS = (
    'Intro',
    'Direct_Answer',
    '_content',      # section_XX_content
)

# Fields to skip for URL extraction (unlikely to have URLs)
_SKIP_URL_EXTRACTION = {
    'Headline',
    'Meta_Title',
    'Meta_Description',
    'Search_Queries',
    'created_at',
}


def get_all_text_fields() -> List[str]:
    """
    Get all string fields from ArticleOutput model.

    Returns:
        List of field names that are string type
    """
    if not _MODEL_AVAILABLE:
        logger.warning("ArticleOutput not available, returning empty list")
        return []

    text_fields = []
    for field_name, field_info in ArticleOutput.model_fields.items():
        field_type = str(field_info.annotation)
        if 'str' in field_type:
            text_fields.append(field_name)

    return text_fields


def get_content_fields() -> List[str]:
    """
    Get text fields suitable for quality checking (Stage 3).

    Excludes: URLs, credits, Sources, metadata, quality metrics.

    Returns:
        List of field names for content review
    """
    if not _MODEL_AVAILABLE:
        return []

    content_fields = []
    for field_name, field_info in ArticleOutput.model_fields.items():
        # Skip non-text fields
        if any(p in field_name for p in _EXCLUDE_PATTERNS):
            continue
        # Only include str fields
        field_type = str(field_info.annotation)
        if 'str' in field_type:
            content_fields.append(field_name)

    return content_fields


def get_html_content_fields() -> List[str]:
    """
    Get fields that contain HTML content (Stage 5 internal linking).

    These fields have <p>, <ul>, <ol> tags and are suitable for link insertion.

    Returns:
        List of field names: Intro, Direct_Answer, section_XX_content
    """
    if not _MODEL_AVAILABLE:
        return []

    html_fields = []
    for field_name, field_info in ArticleOutput.model_fields.items():
        field_type = str(field_info.annotation)
        if 'str' not in field_type:
            continue
        # Check if field matches HTML patterns
        if any(p in field_name for p in _HTML_FIELD_PATTERNS):
            html_fields.append(field_name)

    return html_fields


def get_url_extraction_fields() -> List[str]:
    """
    Get fields suitable for URL extraction (Stage 4).

    Excludes Headline, Meta fields, etc. that won't contain URLs.

    Returns:
        List of field names that may contain URLs
    """
    if not _MODEL_AVAILABLE:
        return []

    url_fields = []
    for field_name, field_info in ArticleOutput.model_fields.items():
        if field_name in _SKIP_URL_EXTRACTION:
            continue
        field_type = str(field_info.annotation)
        if 'str' in field_type:
            url_fields.append(field_name)

    return url_fields


# =============================================================================
# Field Iterators (for use with article dicts)
# =============================================================================

def iter_content_fields(article: Dict[str, Any]) -> Iterator[Tuple[str, str]]:
    """
    Iterate over content fields in an article dict (Stage 3).

    Yields:
        (field_name, content) tuples for non-empty text fields
    """
    for field in get_content_fields():
        content = article.get(field, "")
        # Check stripped length to reject whitespace-only strings
        if content and isinstance(content, str) and len(content.strip()) > 10:
            yield field, content


def iter_html_fields(article: Dict[str, Any]) -> Iterator[Tuple[str, str]]:
    """
    Iterate over HTML content fields in an article dict (Stage 5).

    Only yields fields with actual HTML content (<p>, <ul>, <ol>).

    Yields:
        (field_name, content) tuples for HTML content fields
    """
    for field in get_html_content_fields():
        content = article.get(field, "")
        if not content or not isinstance(content, str):
            continue
        # Verify it has HTML tags
        if '<p>' in content or '<ul>' in content or '<ol>' in content:
            yield field, content


def iter_url_fields(article: Dict[str, Any]) -> Iterator[Tuple[str, str]]:
    """
    Iterate over fields that may contain URLs (Stage 4).

    Yields:
        (field_name, content) tuples for URL-bearing fields
    """
    for field in get_url_extraction_fields():
        content = article.get(field, "")
        if content and isinstance(content, str):
            yield field, content


# =============================================================================
# Field Sets (cached for performance - thread-safe using functools.lru_cache)
# =============================================================================

from functools import lru_cache


@lru_cache(maxsize=1)
def _get_content_fields_set() -> frozenset:
    """Get content fields as a frozen set (cached, thread-safe)."""
    return frozenset(get_content_fields())


@lru_cache(maxsize=1)
def _get_html_fields_set() -> frozenset:
    """Get HTML fields as a frozen set (cached, thread-safe)."""
    return frozenset(get_html_content_fields())


@lru_cache(maxsize=1)
def _get_url_fields_set() -> frozenset:
    """Get URL fields as a frozen set (cached, thread-safe)."""
    return frozenset(get_url_extraction_fields())


def is_content_field(field_name: str) -> bool:
    """Check if a field is a content field (for quality checking)."""
    return field_name in _get_content_fields_set()


def is_html_field(field_name: str) -> bool:
    """Check if a field is an HTML content field (for internal linking)."""
    return field_name in _get_html_fields_set()


def is_url_field(field_name: str) -> bool:
    """Check if a field may contain URLs (for URL extraction)."""
    return field_name in _get_url_fields_set()
