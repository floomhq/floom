"""
Stage 4: URL Verification - Data Models

Pydantic models for input/output JSON schemas.
Clean, standalone - no dependencies on other stages.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
from enum import Enum


# =============================================================================
# URL Status
# =============================================================================

class URLStatus(str, Enum):
    """Status of a verified URL."""
    VALID = "valid"              # 2xx/3xx response, content relevant
    DEAD = "dead"                # 4xx/5xx or timeout
    IRRELEVANT = "irrelevant"    # Alive but content doesn't match context
    REPLACED = "replaced"        # Was dead/irrelevant, now has replacement
    REMOVED = "removed"          # Dead URL removed (no replacement found)


# =============================================================================
# URL Verification Result
# =============================================================================

class URLVerificationResult(BaseModel):
    """Result of verifying a single URL."""
    url: str = Field(..., description="The original URL")
    status: URLStatus = Field(..., description="Verification status")
    http_code: Optional[int] = Field(default=None, description="HTTP response code")
    final_url: Optional[str] = Field(default=None, description="Final URL after redirects")
    error: Optional[str] = Field(default=None, description="Error message if failed")

    # Content verification (from url_context)
    content_relevant: Optional[bool] = Field(default=None, description="Whether content matches expected context")
    content_summary: Optional[str] = Field(default=None, description="Brief summary of page content")

    # Replacement (if needed)
    replacement_url: Optional[str] = Field(default=None, description="Suggested replacement URL")
    replacement_source: Optional[str] = Field(default=None, description="Source name for replacement")
    replacement_reason: Optional[str] = Field(default=None, description="Why replacement was suggested")


class URLReplacement(BaseModel):
    """A surgical URL replacement in article content."""
    field_name: str = Field(..., description="Article field containing the URL (e.g., 'section_01_content')")
    old_url: str = Field(..., description="Original URL to replace")
    new_url: str = Field(..., description="Replacement URL")
    source_name: Optional[str] = Field(default=None, description="Name of the replacement source")
    reason: str = Field(..., description="Reason for replacement")


# =============================================================================
# Stage 4 Input/Output
# =============================================================================

class Stage4Input(BaseModel):
    """
    Input for Stage 4: URL Verification.

    Takes the article content from Stage 2/3 and verifies all external URLs.
    """
    # Article content (the full structured data from Stage 2/3)
    article: Dict[str, Any] = Field(..., description="ArticleOutput dict from Stage 2/3")

    # Context for relevance checking
    keyword: str = Field(..., description="Primary keyword for content relevance check")

    # Options
    skip_domains: List[str] = Field(
        default_factory=lambda: ["unsplash.com", "images.unsplash.com"],
        description="Domains to skip verification (e.g., image hosts)"
    )
    timeout_seconds: float = Field(default=5.0, description="HTTP request timeout")
    verify_content: bool = Field(default=True, description="Whether to verify content relevance with url_context")
    find_replacements: bool = Field(default=True, description="Whether to find replacements for dead URLs")
    replace_irrelevant: bool = Field(default=True, description="Whether to also replace irrelevant URLs (requires verify_content)")
    verify_replacement_urls: bool = Field(default=True, description="Whether to HTTP-check replacement URLs before using")
    remove_dead_urls: bool = Field(default=True, description="Whether to remove dead URLs when no replacement found")
    max_urls_per_batch: int = Field(default=10, description="Max URLs to process per AI batch call")
    max_content_verify: int = Field(default=10, description="Max URLs to verify content relevance")
    max_concurrent_http: int = Field(default=10, description="Max concurrent HTTP checks")


class Stage4Output(BaseModel):
    """
    Output from Stage 4: URL Verification.

    Contains verified article and detailed URL report.
    """
    # Updated article (with replacements applied)
    article: Dict[str, Any] = Field(..., description="ArticleOutput dict with URLs replaced")

    # URL verification report
    total_urls: int = Field(default=0, description="Total URLs found")
    valid_urls: int = Field(default=0, description="URLs that passed verification")
    dead_urls: int = Field(default=0, description="URLs that failed (4xx/5xx/timeout)")
    replaced_urls: int = Field(default=0, description="URLs that were replaced")
    removed_urls: int = Field(default=0, description="Dead URLs removed (no replacement found)")
    skipped_urls: int = Field(default=0, description="URLs skipped (e.g., image hosts)")

    # Detailed results
    url_results: List[URLVerificationResult] = Field(
        default_factory=list,
        description="Detailed result for each URL"
    )
    replacements: List[URLReplacement] = Field(
        default_factory=list,
        description="All URL replacements made"
    )

    # Metadata
    ai_calls: int = Field(default=0, description="Number of Gemini API calls made")
    created_at: str = Field(
        default_factory=lambda: datetime.now().isoformat(),
        description="Timestamp"
    )
