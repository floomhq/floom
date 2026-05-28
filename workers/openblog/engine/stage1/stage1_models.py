"""
Stage 1: Set Context - Data Models

Pydantic models for input/output JSON schemas.
Clean, no dependencies on other stages.
"""

import logging
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import uuid
import re

logger = logging.getLogger(__name__)


def generate_slug(keyword: str, max_length: int = 100) -> str:
    """
    Generate URL-safe slug from keyword.

    Args:
        keyword: The keyword to convert to a slug
        max_length: Maximum slug length (default 100)

    Returns:
        URL-safe slug string (returns "article" if result would be empty)
    """
    if not keyword:
        return "article"

    slug = keyword.lower().strip()
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)  # remove special chars
    slug = re.sub(r'[\s_]+', '-', slug)        # spaces/underscores to hyphens
    slug = re.sub(r'-+', '-', slug)            # collapse multiple hyphens
    slug = slug.strip('-')

    # Handle empty result (e.g., keyword was only special chars like "!!!")
    if not slug:
        return "article"

    # Truncate at word boundary if too long
    if len(slug) > max_length:
        slug = slug[:max_length]
        last_hyphen = slug.rfind('-')
        if last_hyphen > max_length // 2:
            slug = slug[:last_hyphen]

    return slug


# =============================================================================
# Voice Persona (from OpenContext)
# =============================================================================

class LanguageStyle(BaseModel):
    """Language style preferences for content writing."""
    formality: Optional[str] = Field(default="professional", description="casual/professional/formal")
    complexity: Optional[str] = Field(default="moderate", description="simple/moderate/technical/expert")
    sentence_length: Optional[str] = Field(default="mixed", description="short and punchy / mixed / detailed")
    perspective: Optional[str] = Field(default="expert-to-learner", description="peer-to-peer / expert-to-learner / consultant-to-executive")
    avg_words_per_sentence: Optional[int] = Field(default=None, description="Average words per sentence observed")
    reading_level: Optional[str] = Field(default="", description="Estimated reading level (e.g., '8th grade', 'college', 'expert')")


class VoicePersona(BaseModel):
    """Writing persona tailored to the ICP (Ideal Customer Profile)."""
    icp_profile: Optional[str] = Field(default="", description="Brief description of the ICP")
    voice_style: Optional[str] = Field(default="", description="2-3 sentence description of writing voice")
    language_style: LanguageStyle = Field(default_factory=LanguageStyle)
    sentence_patterns: List[str] = Field(default_factory=list, description="Example sentence patterns")
    vocabulary_level: Optional[str] = Field(default="", description="Technical vocabulary expectations")
    authority_signals: List[str] = Field(default_factory=list, description="What makes ICP trust content")
    do_list: List[str] = Field(default_factory=list, description="Behaviors that resonate with ICP")
    dont_list: List[str] = Field(default_factory=list, description="Anti-patterns to avoid")
    example_phrases: List[str] = Field(default_factory=list, description="Phrases that capture tone")
    opening_styles: List[str] = Field(default_factory=list, description="Section openers that engage")

    # Enhanced fields from blog content analysis
    transition_phrases: List[str] = Field(default_factory=list, description="Phrases used to transition between sections")
    closing_styles: List[str] = Field(default_factory=list, description="How articles typically end/conclude")
    headline_patterns: List[str] = Field(default_factory=list, description="Patterns observed in headlines/titles")
    subheading_styles: List[str] = Field(default_factory=list, description="How subheadings are written")
    cta_phrases: List[str] = Field(default_factory=list, description="Call-to-action phrases used")
    technical_terms: List[str] = Field(default_factory=list, description="Domain-specific terms frequently used")
    power_words: List[str] = Field(default_factory=list, description="Impactful words that appear frequently")
    banned_words: List[str] = Field(default_factory=list, description="Words/phrases to never use")
    paragraph_length: Optional[str] = Field(default="", description="Typical paragraph length (short/medium/long)")
    uses_questions: Optional[bool] = Field(default=None, description="Whether rhetorical questions are common")
    uses_lists: Optional[bool] = Field(default=None, description="Whether bullet/numbered lists are common")
    uses_statistics: Optional[bool] = Field(default=None, description="Whether data/statistics are frequently cited")
    first_person_usage: Optional[str] = Field(default="", description="How first person is used (we/I/avoided)")
    content_structure_pattern: Optional[str] = Field(default="", description="Common article structure (e.g., problem-solution, how-to, listicle)")


# =============================================================================
# Author Info (from Blog Articles)
# =============================================================================

class AuthorInfo(BaseModel):
    """Author information extracted from blog articles."""
    name: str = Field(..., description="Author's full name")
    title: str = Field(default="", description="Author's job title/role")
    bio: str = Field(default="", description="Short author bio if available")
    image_url: str = Field(default="", description="Author's profile image URL if available")
    linkedin_url: str = Field(default="", description="Author's LinkedIn profile if available")
    twitter_url: str = Field(default="", description="Author's Twitter/X profile if available")


# =============================================================================
# Visual Identity (for Image Generation)
# =============================================================================

class BlogImageExample(BaseModel):
    """Example image from existing blog posts for style reference.

    Note: url is optional because AI models often hallucinate image URLs.
    The description is the primary value - it informs image generation style.
    URLs are only populated if they pass HTTP validation.
    """
    url: str = Field(default="", description="Image URL (optional - only populated if validated)")
    description: str = Field(default="", description="AI-generated description of the image style/content")
    image_type: str = Field(default="hero", description="Type: hero, inline, infographic, etc.")
    validated: bool = Field(default=False, description="Whether the URL was validated via HTTP")


class VisualIdentity(BaseModel):
    """Visual identity for consistent image generation."""
    brand_colors: List[str] = Field(default_factory=list, description="Primary brand colors as hex codes (e.g., #FF5733)")
    secondary_colors: List[str] = Field(default_factory=list, description="Secondary/accent colors as hex codes")
    visual_style: Optional[str] = Field(default="", description="Overall visual style (e.g., minimalist, bold, corporate, playful)")
    design_elements: List[str] = Field(default_factory=list, description="Common design elements (gradients, icons, illustrations)")
    typography_style: Optional[str] = Field(default="", description="Typography feel (modern sans-serif, classic serif, etc.)")
    image_style_prompt: Optional[str] = Field(default="", description="Base prompt for image generation")
    blog_image_examples: List[BlogImageExample] = Field(default_factory=list, description="Example images from existing blog posts")
    mood: Optional[str] = Field(default="", description="Overall mood/feeling (professional, friendly, innovative, trustworthy)")
    avoid_in_images: List[str] = Field(default_factory=list, description="Elements to avoid in generated images")


# =============================================================================
# Company Context (OpenContext output schema)
# =============================================================================

class CompanyContext(BaseModel):
    """
    Company context extracted via OpenContext (Gemini + Google Search).

    Full parity with federicodeponte/opencontext schema.
    """
    company_name: str = Field(default="", description="Official company name")
    company_url: str = Field(default="", description="Company website URL")
    industry: str = Field(default="", description="Primary industry category")
    description: str = Field(default="", description="2-3 sentence company description")
    products: List[str] = Field(default_factory=list, description="Products/services offered")
    target_audience: str = Field(default="", description="Ideal customer profile description")
    competitors: List[str] = Field(default_factory=list, description="Main competitors")
    tone: str = Field(default="professional", description="Brand voice (professional/friendly/authoritative)")
    pain_points: List[str] = Field(default_factory=list, description="Customer pain points addressed")
    value_propositions: List[str] = Field(default_factory=list, description="Key value propositions")
    use_cases: List[str] = Field(default_factory=list, description="Common use cases")
    content_themes: List[str] = Field(default_factory=list, description="Content themes/topics")
    voice_persona: VoicePersona = Field(default_factory=VoicePersona, description="Writing persona for ICP")
    visual_identity: VisualIdentity = Field(default_factory=VisualIdentity, description="Visual identity for image generation")
    authors: List[AuthorInfo] = Field(default_factory=list, description="Blog authors extracted from articles")

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CompanyContext":
        """Create from dictionary, handling nested voice_persona and visual_identity."""
        if not data:
            return cls()

        # Handle voice_persona separately
        voice_data = data.get("voice_persona", {})
        if voice_data and isinstance(voice_data, dict):
            # Handle nested language_style
            lang_style_data = voice_data.get("language_style", {})
            if lang_style_data and isinstance(lang_style_data, dict):
                voice_data["language_style"] = LanguageStyle(**lang_style_data)
            data["voice_persona"] = VoicePersona(**voice_data)

        # Handle visual_identity separately
        visual_data = data.get("visual_identity", {})
        if visual_data and isinstance(visual_data, dict):
            # Handle nested blog_image_examples with proper error handling
            examples = visual_data.get("blog_image_examples", [])
            if examples:
                parsed_examples = []
                for ex in examples:
                    if isinstance(ex, dict):
                        try:
                            parsed_examples.append(BlogImageExample(**ex))
                        except Exception as e:
                            logger.warning(f"Failed to parse BlogImageExample: {e}")
                            continue
                    elif isinstance(ex, BlogImageExample):
                        parsed_examples.append(ex)
                visual_data["blog_image_examples"] = parsed_examples
            data["visual_identity"] = VisualIdentity(**visual_data)

        # Handle authors separately
        authors_data = data.get("authors", [])
        if authors_data and isinstance(authors_data, list):
            parsed_authors = []
            for author in authors_data:
                if isinstance(author, dict) and author.get("name"):
                    # Clean None values to empty strings for optional fields
                    cleaned = {
                        k: (v if v is not None else "")
                        for k, v in author.items()
                    }
                    parsed_authors.append(AuthorInfo(**cleaned))
            data["authors"] = parsed_authors

        return cls(**{k: v for k, v in data.items() if k in cls.model_fields})


# =============================================================================
# Sitemap Data
# =============================================================================

class SitemapData(BaseModel):
    """Crawled sitemap data with labeled URLs."""
    total_pages: int = Field(default=0, description="Total URLs found in sitemap")
    blog_urls: List[str] = Field(default_factory=list, description="URLs labeled as blog posts")
    product_urls: List[str] = Field(default_factory=list, description="URLs labeled as product pages")
    service_urls: List[str] = Field(default_factory=list, description="URLs labeled as service pages")
    resource_urls: List[str] = Field(default_factory=list, description="URLs labeled as resources (whitepapers, case studies)")
    docs_urls: List[str] = Field(default_factory=list, description="URLs labeled as documentation")
    tool_urls: List[str] = Field(default_factory=list, description="URLs labeled as tools/calculators")
    other_urls: List[str] = Field(default_factory=list, description="URLs with other/unknown labels")

    # Smart classification metadata
    classification_method: str = Field(default="pattern", description="Method used: pattern, url_analysis, title_sampling, ai_assisted")
    classification_confidence: float = Field(default=1.0, description="Classification confidence (0-1)")
    smart_classifier_used: bool = Field(default=False, description="Whether smart classifier was triggered")


# =============================================================================
# Stage 1 Input/Output
# =============================================================================

class ArticleJob(BaseModel):
    """Single article job with keyword, slug, href, and optional overrides."""
    keyword: str = Field(..., description="Primary keyword for this article")
    slug: str = Field(..., description="URL-safe slug")
    href: str = Field(..., description="Full internal href (e.g., /magazine/answer-engine-optimization)")
    word_count: Optional[int] = Field(default=None, description="Per-keyword word count override")
    keyword_instructions: Optional[str] = Field(default=None, description="Per-keyword instructions (combined with batch)")


class KeywordConfig(BaseModel):
    """Per-keyword configuration with resolved values."""
    keyword: str = Field(..., description="Primary keyword")
    word_count: int = Field(default=2000, description="Resolved word count for this keyword")
    instructions: Optional[str] = Field(default=None, description="Combined instructions (batch + keyword)")


class Stage1Input(BaseModel):
    """
    Input for Stage 1: Set Context.

    Supports batch keywords with optional per-keyword overrides.
    If company_context is provided, skips OpenContext call.

    Keywords can be provided as:
    - Simple strings: ["keyword 1", "keyword 2"]
    - Objects with overrides: [{"keyword": "...", "word_count": 1500, "custom_instructions": "..."}]
    - Mixed: ["keyword 1", {"keyword": "keyword 2", "word_count": 3000}]
    """
    keywords: List[Any] = Field(..., min_length=1, description="Keywords for blog generation (batch supported)")
    company_url: str = Field(..., description="Company website URL")
    language: str = Field(default="en", description="Target language code (en, de, fr, etc.)")
    market: str = Field(default="US", description="Target market/country code")
    company_context: Optional[CompanyContext] = Field(default=None, description="Pre-provided company context (skips OpenContext)")

    # Batch-level defaults
    default_word_count: int = Field(default=2000, description="Default word count for all articles")
    batch_instructions: Optional[str] = Field(default=None, description="Instructions for all articles in batch")

    def get_keyword_configs(self) -> List[KeywordConfig]:
        """
        Parse keywords into KeywordConfig objects with resolved values.

        Instructions are COMBINED (batch + keyword):
        - batch_instructions: applies to all articles
        - keyword_instructions: additional instructions for specific keyword

        Word count uses keyword-level if provided, otherwise batch default.
        """
        configs = []
        for kw in self.keywords:
            if isinstance(kw, str):
                configs.append(KeywordConfig(
                    keyword=kw,
                    word_count=self.default_word_count,
                    instructions=self.batch_instructions,
                ))
            elif isinstance(kw, dict):
                # Combine batch + keyword instructions
                combined = self._combine_instructions(
                    self.batch_instructions,
                    kw.get("keyword_instructions")
                )
                configs.append(KeywordConfig(
                    keyword=kw.get("keyword", ""),
                    word_count=kw.get("word_count") or self.default_word_count,
                    instructions=combined,
                ))
            elif hasattr(kw, "keyword"):
                # Already a KeywordConfig-like object
                combined = self._combine_instructions(
                    self.batch_instructions,
                    kw.keyword_instructions if hasattr(kw, "keyword_instructions") else None
                )
                configs.append(KeywordConfig(
                    keyword=kw.keyword,
                    word_count=kw.word_count if hasattr(kw, "word_count") and kw.word_count else self.default_word_count,
                    instructions=combined,
                ))
        return configs

    def _combine_instructions(self, batch: Optional[str], keyword: Optional[str]) -> Optional[str]:
        """Combine batch and keyword instructions."""
        if batch and keyword:
            return f"{batch}\n\nAdditional for this article: {keyword}"
        return batch or keyword

    def model_post_init(self, __context: Any) -> None:
        """Normalize company_url."""
        if self.company_url and not self.company_url.startswith("http"):
            self.company_url = f"https://{self.company_url}"


class Stage1Output(BaseModel):
    """
    Output from Stage 1: Set Context.

    Contains everything needed for subsequent stages.
    """
    job_id: str = Field(default_factory=lambda: str(uuid.uuid4()), description="Unique job identifier")
    articles: List[ArticleJob] = Field(..., description="Article jobs with keywords, slugs, and hrefs")
    language: str = Field(..., description="Target language code")
    market: str = Field(..., description="Target market/country code")
    company_context: CompanyContext = Field(..., description="Company context (from OpenContext or provided)")
    sitemap: SitemapData = Field(default_factory=SitemapData, description="Crawled sitemap data")
    created_at: str = Field(default_factory=lambda: datetime.now().isoformat(), description="Timestamp")

    # Metadata
    opencontext_called: bool = Field(default=False, description="Whether OpenContext was called (vs provided)")
    ai_calls: int = Field(default=0, description="Number of AI calls made")

    # Voice Enhancement Metadata
    voice_enhanced: bool = Field(default=False, description="Whether voice was enhanced from blog samples")
    voice_enhancement_urls: List[str] = Field(default_factory=list, description="Blog URLs used for voice enhancement")
