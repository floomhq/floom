"""
Shared models for openblog-neo pipeline.

ArticleOutput: Complete structured blog article schema (40+ fields).
Created in Stage 2, mutated in Stages 3-5.
"""

from typing import Optional, Dict, List, Any
from pydantic import BaseModel, Field, field_validator, ConfigDict
import logging
import re

logger = logging.getLogger(__name__)


class Source(BaseModel):
    """A citation source with title and URL."""
    title: str = Field(..., description="Source title/description")
    url: str = Field(..., description="Source URL")

    @field_validator('url')
    @classmethod
    def validate_url(cls, v):
        """Validate URL format. Empty URLs are not allowed."""
        if not v or not v.strip():
            raise ValueError("URL cannot be empty")
        if not re.match(r'^https?://', v):
            raise ValueError(f"Invalid URL format: {v}")
        return v


class ComparisonTable(BaseModel):
    """
    Structured comparison table for products, tools, or features.

    Used for content that benefits from side-by-side comparisons.
    Examples: pricing tiers, tool features, before/after scenarios.
    """

    title: str = Field(..., description="Table title (e.g., 'AI Code Tools Comparison')")
    headers: List[str] = Field(..., description="Column headers (e.g., ['Tool', 'Price', 'Speed'])")
    rows: List[List[str]] = Field(..., description="Table rows, each row is a list matching header count")

    @field_validator('headers')
    @classmethod
    def validate_headers(cls, v):
        if not v or len(v) < 2:
            raise ValueError("Table must have at least 2 columns")
        if len(v) > 6:
            raise ValueError("Table should not exceed 6 columns for readability")
        return v

    @field_validator('rows', mode='after')
    @classmethod
    def validate_rows(cls, v, info):
        if not v:
            raise ValueError("Table must have at least one row")

        # Access headers from the validated data (available in mode='after')
        headers = info.data.get('headers') if info.data else None
        if headers is None:
            # Fallback: can't validate column count without headers
            logger.warning("Cannot validate row column count: headers not available")
            header_count = 0
        else:
            header_count = len(headers)

        if header_count > 0:
            for idx, row in enumerate(v):
                if len(row) != header_count:
                    raise ValueError(f"Row {idx} has {len(row)} cells but table has {header_count} columns")

        if len(v) > 10:
            raise ValueError("Table should not exceed 10 rows for readability")

        return v


class ArticleOutput(BaseModel):
    """
    Complete article output schema (30+ fields).

    Created in Stage 2 (Blog Gen), mutated in Stages 3-5.
    Maps to the exact JSON output from Gemini API response.
    """

    # Core content
    Headline: str = Field(..., description="Main article headline with primary keyword")
    Subtitle: Optional[str] = Field(default="", description="Optional sub-headline for context or angle")
    Teaser: str = Field(..., description="2-3 sentence hook highlighting pain point or benefit")
    Direct_Answer: str = Field(..., description="40-60 word direct answer to primary question")
    Intro: str = Field(..., description="Opening paragraph (80-120 words) framing the problem")

    # SEO metadata
    Meta_Title: str = Field(..., description="≤55 character SEO title with primary keyword")
    Meta_Description: str = Field(..., description="≤160 character SEO description with CTA")

    # Lead generation (optional)
    Lead_Survey_Title: Optional[str] = Field(default="", description="Optional survey title")
    Lead_Survey_Button: Optional[str] = Field(default="", description="Optional survey CTA button text")

    # Content sections (9 sections × 2 fields)
    section_01_title: str = Field(..., description="Section 1 heading (REQUIRED)")
    section_01_content: str = Field(..., description="Section 1 HTML content (REQUIRED)")
    section_02_title: Optional[str] = Field(default="", description="Section 2 heading")
    section_02_content: Optional[str] = Field(default="", description="Section 2 HTML content")
    section_03_title: Optional[str] = Field(default="", description="Section 3 heading")
    section_03_content: Optional[str] = Field(default="", description="Section 3 HTML content")
    section_04_title: Optional[str] = Field(default="", description="Section 4 heading")
    section_04_content: Optional[str] = Field(default="", description="Section 4 HTML content")
    section_05_title: Optional[str] = Field(default="", description="Section 5 heading")
    section_05_content: Optional[str] = Field(default="", description="Section 5 HTML content")
    section_06_title: Optional[str] = Field(default="", description="Section 6 heading")
    section_06_content: Optional[str] = Field(default="", description="Section 6 HTML content")
    section_07_title: Optional[str] = Field(default="", description="Section 7 heading")
    section_07_content: Optional[str] = Field(default="", description="Section 7 HTML content")
    section_08_title: Optional[str] = Field(default="", description="Section 8 heading")
    section_08_content: Optional[str] = Field(default="", description="Section 8 HTML content")
    section_09_title: Optional[str] = Field(default="", description="Section 9 heading")
    section_09_content: Optional[str] = Field(default="", description="Section 9 HTML content")

    # Key takeaways (3 items)
    key_takeaway_01: Optional[str] = Field(default="", description="Key insight #1")
    key_takeaway_02: Optional[str] = Field(default="", description="Key insight #2")
    key_takeaway_03: Optional[str] = Field(default="", description="Key insight #3")

    # People Also Ask (PAA) - 4 items
    paa_01_question: Optional[str] = Field(default="", description="PAA question #1")
    paa_01_answer: Optional[str] = Field(default="", description="PAA answer #1")
    paa_02_question: Optional[str] = Field(default="", description="PAA question #2")
    paa_02_answer: Optional[str] = Field(default="", description="PAA answer #2")
    paa_03_question: Optional[str] = Field(default="", description="PAA question #3")
    paa_03_answer: Optional[str] = Field(default="", description="PAA answer #3")
    paa_04_question: Optional[str] = Field(default="", description="PAA question #4")
    paa_04_answer: Optional[str] = Field(default="", description="PAA answer #4")

    # FAQ - 6 items
    faq_01_question: Optional[str] = Field(default="", description="FAQ question #1")
    faq_01_answer: Optional[str] = Field(default="", description="FAQ answer #1")
    faq_02_question: Optional[str] = Field(default="", description="FAQ question #2")
    faq_02_answer: Optional[str] = Field(default="", description="FAQ answer #2")
    faq_03_question: Optional[str] = Field(default="", description="FAQ question #3")
    faq_03_answer: Optional[str] = Field(default="", description="FAQ answer #3")
    faq_04_question: Optional[str] = Field(default="", description="FAQ question #4")
    faq_04_answer: Optional[str] = Field(default="", description="FAQ answer #4")
    faq_05_question: Optional[str] = Field(default="", description="FAQ question #5")
    faq_05_answer: Optional[str] = Field(default="", description="FAQ answer #5")
    faq_06_question: Optional[str] = Field(default="", description="FAQ question #6")
    faq_06_answer: Optional[str] = Field(default="", description="FAQ answer #6")

    # Images (3 slots) - populated by Imagen, not Gemini
    image_01_url: str = Field(default="", description="Hero image URL (set by Imagen)")
    image_01_alt_text: str = Field(default="", description="Hero image alt text, max 125 chars")
    image_01_credit: str = Field(default="", description="Image credit/attribution")
    image_02_url: str = Field(default="", description="Mid-article image URL")
    image_02_alt_text: str = Field(default="", description="Mid-article image alt text")
    image_02_credit: str = Field(default="", description="Image credit for mid-article image")
    image_03_url: str = Field(default="", description="Bottom image URL")
    image_03_alt_text: str = Field(default="", description="Bottom image alt text")
    image_03_credit: str = Field(default="", description="Image credit for bottom image")

    # TL;DR (optional, for long articles)
    TLDR: str = Field(default="", description="TL;DR summary (2-3 sentences)")

    # Sources and research
    Sources: List[Source] = Field(default_factory=list, description="List of citation sources")
    Search_Queries: str = Field(default="", description="Research queries documented")

    # Comparison tables (optional)
    tables: List[ComparisonTable] = Field(default_factory=list, description="Comparison tables (max 2)")

    @field_validator("Sources", mode="before")
    @classmethod
    def convert_sources_from_dicts(cls, v):
        """Convert list of dicts to list of Source objects (AI returns dicts)."""
        if not v:
            return []
        result = []
        for item in v:
            if isinstance(item, dict):
                # Skip items with empty/missing URL
                url = item.get("url", "")
                if url and url.strip():
                    try:
                        result.append(Source(**item))
                    except Exception as e:
                        logger.warning(f"Skipping invalid source: {e}")
            elif isinstance(item, Source):
                result.append(item)
        return result

    @field_validator("tables", mode="before")
    @classmethod
    def convert_tables_from_dicts(cls, v):
        """Convert list of dicts to list of ComparisonTable objects."""
        if not v:
            return []
        result = []
        for item in v:
            if isinstance(item, dict):
                try:
                    result.append(ComparisonTable(**item))
                except Exception as e:
                    logger.warning(f"Skipping invalid table: {e}")
            elif isinstance(item, ComparisonTable):
                result.append(item)
        return result

    # Optional enrichments (Gemini decides based on topic)
    pros_cons: Optional[Dict[str, List[str]]] = Field(
        default=None,
        description="Structured pros/cons for product reviews: {'pros': [...], 'cons': [...]}"
    )

    @field_validator("pros_cons", mode="before")
    @classmethod
    def handle_empty_pros_cons(cls, v):
        # Handle AI returning [] instead of None or {}
        if v is None or v == [] or v == {}:
            return None
        if isinstance(v, dict):
            return v
        return None

    cta_text: str = Field(default="", description="Specific call-to-action for the article")
    related_keywords: List[str] = Field(default_factory=list, description="Secondary keywords covered")
    content_type: str = Field(default="", description="listicle / how-to / comparison / guide / explainer")
    reading_time_min: Optional[int] = Field(default=None, description="Estimated reading time in minutes")
    video_url: Optional[str] = Field(default="", description="YouTube video URL (prefer company's own channel)")
    video_title: Optional[str] = Field(default="", description="Video title for embed")

    # Quality metrics (set by Stage 3)
    quality_score: Optional[int] = Field(default=None, description="Quality score 0-100")
    quality_failed: Optional[bool] = Field(default=False, description="True if quality score < 60")

    model_config = ConfigDict(extra="ignore")

    @field_validator("Headline", "Teaser", "Direct_Answer", "Intro", "Meta_Title", "Meta_Description", "section_01_title", "section_01_content")
    @classmethod
    def required_fields_not_empty(cls, v):
        if not v or not v.strip():
            raise ValueError("This field is required and cannot be empty")
        return v.strip()

    @field_validator("Headline")
    @classmethod
    def headline_length(cls, v):
        if len(v) > 100:
            logger.warning(f"Headline {len(v)} chars, truncating to 100")
            truncated = v[:97]
            last_space = truncated.rfind(' ')
            if last_space > 60:
                truncated = v[:last_space]
            return truncated + "..."
        return v

    @field_validator("Meta_Title")
    @classmethod
    def meta_title_length(cls, v):
        if len(v) > 55:
            logger.warning(f"Meta Title exceeds 55 chars: {len(v)} chars, truncating...")
            truncated = v[:52]
            last_space = truncated.rfind(' ')
            if last_space > 35:
                truncated = v[:last_space]
            return truncated + "..."
        return v

    @field_validator("Meta_Description")
    @classmethod
    def meta_description_length(cls, v):
        if len(v) > 160:
            logger.warning(f"Meta Description exceeds 160 chars: {len(v)} chars, truncating...")
            return v[:157] + "..."
        return v

    def get_active_sections(self) -> int:
        """Count non-empty section titles."""
        sections = [
            self.section_01_title, self.section_02_title, self.section_03_title,
            self.section_04_title, self.section_05_title, self.section_06_title,
            self.section_07_title, self.section_08_title, self.section_09_title,
        ]
        return sum(1 for s in sections if s and s.strip())

    def get_active_faqs(self) -> int:
        """Count non-empty FAQ questions."""
        faqs = [
            self.faq_01_question, self.faq_02_question, self.faq_03_question,
            self.faq_04_question, self.faq_05_question, self.faq_06_question,
        ]
        return sum(1 for f in faqs if f and f.strip())

    def get_active_paas(self) -> int:
        """Count non-empty PAA questions."""
        paas = [self.paa_01_question, self.paa_02_question, self.paa_03_question, self.paa_04_question]
        return sum(1 for p in paas if p and p.strip())

    # Alias methods for backward compatibility with stage 2/article_schema.py naming
    def count_sections(self) -> int:
        """Alias for get_active_sections() for backward compatibility."""
        return self.get_active_sections()

    def count_faqs(self) -> int:
        """Alias for get_active_faqs() for backward compatibility."""
        return self.get_active_faqs()

    def count_paas(self) -> int:
        """Alias for get_active_paas() for backward compatibility."""
        return self.get_active_paas()

    def __repr__(self) -> str:
        headline_preview = self.Headline[:40] + "..." if len(self.Headline) > 40 else self.Headline
        return f"ArticleOutput(headline='{headline_preview}', sections={self.get_active_sections()}, faqs={self.get_active_faqs()})"
