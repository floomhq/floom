"""
Stage 2: Blog Generation + Image Creation

Generates a complete blog article using Gemini AI (with Google Search grounding)
and 3 images using Google Imagen (in parallel).

Micro-API Design:
- Input: JSON with keyword, company_context, language, word_count
- Output: JSON with article (40+ fields) + image URLs
- Can run as CLI or be imported as a module

AI Calls:
- 1x Gemini (blog article generation)
- 3x Imagen (hero, mid, bottom images) - optional, can skip

Usage:
    # As module
    from stage_2 import run_stage_2, Stage2Input
    output = await run_stage_2(Stage2Input(...))

    # As CLI
    python stage_2.py --input stage1_output.json --output stage2_output.json
"""

import asyncio
import json
import logging
import re
import sys
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime, timezone
from pydantic import BaseModel, Field
import uuid

# Pattern to validate YouTube URLs
YOUTUBE_URL_PATTERN = re.compile(
    r'^https?://(?:www\.)?(?:youtube\.com/watch\?v=|youtu\.be/)[\w-]{11}',
    re.IGNORECASE
)

# Add parent to path for imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

from article_schema import ArticleOutput
from blog_writer import BlogWriter
from image_creator import ImageCreator
from image_prompts import build_image_prompt

# Import models from stage 1 (single source of truth)
try:
    from importlib import util as importlib_util
    _stage1_path = _parent / "stage1" / "stage1_models.py"
    _spec = importlib_util.spec_from_file_location("stage1_models", _stage1_path)
    _stage1_models = importlib_util.module_from_spec(_spec)
    _spec.loader.exec_module(_stage1_models)
    CompanyContext = _stage1_models.CompanyContext
    VisualIdentity = _stage1_models.VisualIdentity
    AuthorInfo = _stage1_models.AuthorInfo
except (ImportError, FileNotFoundError, AttributeError, ModuleNotFoundError, SyntaxError) as e:
    logging.warning(f"Could not import stage1 models, using local definitions: {e}")
    # Fallback definitions if import fails
    class AuthorInfo(BaseModel):
        """Author information from Stage 1."""
        name: str = Field(..., description="Author's full name")
        title: str = Field(default="", description="Author's job title/role")
        bio: str = Field(default="", description="Short author bio")
        image_url: str = Field(default="", description="Author's profile image URL")
        linkedin_url: str = Field(default="", description="Author's LinkedIn profile")
        twitter_url: str = Field(default="", description="Author's Twitter/X profile")

    class CompanyContext(BaseModel):
        """Company context from Stage 1."""
        company_name: str = Field(default="")
        company_url: str = Field(default="")
        industry: str = Field(default="")
        description: str = Field(default="")
        products: List[str] = Field(default_factory=list)
        target_audience: str = Field(default="")
        tone: str = Field(default="professional")
        voice_persona: Dict[str, Any] = Field(default_factory=dict)
        authors: List[AuthorInfo] = Field(default_factory=list, description="Blog authors from Stage 1")

    class VisualIdentity(BaseModel):
        """Visual identity from Stage 1 for consistent image generation."""
        brand_colors: List[str] = Field(default_factory=list, description="Primary brand colors as hex")
        secondary_colors: List[str] = Field(default_factory=list)
        visual_style: str = Field(default="", description="minimalist, bold, corporate, playful")
        design_elements: List[str] = Field(default_factory=list, description="gradients, icons, illustrations")
        typography_style: str = Field(default="")
        mood: str = Field(default="", description="professional, friendly, innovative")
        image_style_prompt: str = Field(default="", description="Base prompt for Imagen from Stage 1")
        avoid_in_images: List[str] = Field(default_factory=list, description="Elements to avoid")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# =============================================================================
# Input/Output Schemas
# =============================================================================

class Stage2Input(BaseModel):
    """
    Input for Stage 2: Blog Generation.

    Can come from Stage 1 output or be constructed manually.
    """
    keyword: str = Field(..., min_length=1, description="Primary SEO keyword for the article")
    company_context: CompanyContext = Field(..., description="Company context from Stage 1")
    visual_identity: Optional[VisualIdentity] = Field(default=None, description="Visual identity from Stage 1")
    language: str = Field(default="en", description="Target language code")
    country: str = Field(default="United States", description="Target country/region for localization")
    word_count: int = Field(default=2000, ge=500, le=10000, description="Target word count (500-10000)")
    custom_instructions: Optional[str] = Field(default=None, description="Batch-level instructions")
    keyword_instructions: Optional[str] = Field(default=None, description="Keyword-specific instructions")
    skip_images: bool = Field(default=False, description="Skip image generation")
    job_id: Optional[str] = Field(default=None, description="Job ID from Stage 1")


class ImageResult(BaseModel):
    """Generated image result."""
    url: str = Field(default="")
    alt_text: str = Field(default="")
    position: str = Field(default="")  # hero, mid, bottom


class Stage2Output(BaseModel):
    """
    Output from Stage 2: Blog Generation.

    Contains the full article and generated images.
    """
    job_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    keyword: str = Field(...)
    article: ArticleOutput = Field(...)
    images: List[ImageResult] = Field(default_factory=list)
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    ai_calls: int = Field(default=0, description="Number of AI calls made")
    images_generated: int = Field(default=0)


# =============================================================================
# Core Logic
# =============================================================================

async def run_stage_2(input_data: Stage2Input) -> Stage2Output:
    """
    Run Stage 2: Blog Generation + Image Creation.

    Args:
        input_data: Stage2Input with keyword, company_context, etc.

    Returns:
        Stage2Output with article and images
    """
    logger.info("Stage 2: Blog Generation + Image Creation")
    logger.info(f"  Keyword: {input_data.keyword}")
    logger.info(f"  Language: {input_data.language}")
    logger.info(f"  Word count: {input_data.word_count}")
    logger.info(f"  Skip images: {input_data.skip_images}")

    ai_calls = 0
    images_generated = 0

    # Initialize clients
    try:
        blog_writer = BlogWriter()
    except ValueError as e:
        logger.error(f"BlogWriter init failed: {e}")
        raise ValueError(f"Cannot generate article: {e}") from e
    image_creator = ImageCreator() if not input_data.skip_images else None

    # -----------------------------------------
    # Step 1: Generate Article
    # -----------------------------------------
    logger.info("  Generating article with Gemini...")

    article = await blog_writer.write_article(
        keyword=input_data.keyword,
        company_context=input_data.company_context.model_dump(),
        word_count=input_data.word_count,
        language=input_data.language,
        country=input_data.country,
        batch_instructions=input_data.custom_instructions,
        keyword_instructions=input_data.keyword_instructions,
    )
    ai_calls += 1

    logger.info(f"  Article generated: {article.Headline[:50]}...")
    logger.info(f"  Sections: {article.count_sections()}, FAQs: {article.count_faqs()}")

    # Validate video_url - clear if not a valid YouTube URL
    if article.video_url:
        if not YOUTUBE_URL_PATTERN.match(article.video_url):
            logger.info(f"  Clearing invalid video_url: {article.video_url[:50]}...")
            article.video_url = ""
            article.video_title = ""

    # -----------------------------------------
    # Step 2: Generate Images (parallel)
    # -----------------------------------------
    images: List[ImageResult] = []

    if not input_data.skip_images and image_creator:
        logger.info("  Generating 3 images in parallel...")

        company_data = input_data.company_context.model_dump()
        visual_identity = input_data.visual_identity.model_dump() if input_data.visual_identity else None

        # Build prompts for all 3 positions (using visual identity from Stage 1)
        prompts = {
            "hero": build_image_prompt(input_data.keyword, company_data, input_data.language, "hero", visual_identity),
            "mid": build_image_prompt(input_data.keyword, company_data, input_data.language, "mid", visual_identity),
            "bottom": build_image_prompt(input_data.keyword, company_data, input_data.language, "bottom", visual_identity),
        }

        # Generate images in parallel using async method
        async def generate_single_image(position: str, prompt: str) -> ImageResult:
            try:
                url = await image_creator.generate_async(prompt)
                alt = ImageCreator.generate_alt_text(f"{input_data.keyword} - {position}")
                return ImageResult(url=url or "", alt_text=alt, position=position)
            except Exception as e:
                # Include context in error logging for easier debugging
                logger.warning(
                    f"Image generation failed: position={position}, keyword={input_data.keyword}, "
                    f"error={type(e).__name__}: {e}"
                )
                return ImageResult(url="", alt_text="", position=position)

        image_results = await asyncio.gather(
            generate_single_image("hero", prompts["hero"]),
            generate_single_image("mid", prompts["mid"]),
            generate_single_image("bottom", prompts["bottom"]),
        )

        images = list(image_results)
        images_generated = sum(1 for img in images if img.url)
        ai_calls += images_generated  # Only count successful image generations

        logger.info(f"  Images generated: {images_generated}/3")

        # Update article with image URLs
        if images_generated > 0:
            for img in images:
                if img.position == "hero" and img.url:
                    article.image_01_url = img.url
                    article.image_01_alt_text = img.alt_text
                elif img.position == "mid" and img.url:
                    article.image_02_url = img.url
                    article.image_02_alt_text = img.alt_text
                elif img.position == "bottom" and img.url:
                    article.image_03_url = img.url
                    article.image_03_alt_text = img.alt_text

    # -----------------------------------------
    # Build Output
    # -----------------------------------------
    output = Stage2Output(
        job_id=input_data.job_id or str(uuid.uuid4()),
        keyword=input_data.keyword,
        article=article,
        images=images,
        ai_calls=ai_calls,
        images_generated=images_generated,
    )

    logger.info(f"Stage 2 complete. AI calls: {ai_calls}")

    return output


# =============================================================================
# JSON Interface (Micro-API)
# =============================================================================

async def run_from_json(input_json: dict) -> dict:
    """
    Run Stage 2 from JSON input, return JSON output.

    Micro-API interface for integration with other stages or services.

    Args:
        input_json: Dictionary with Stage2Input fields

    Returns:
        Dictionary with Stage2Output fields
    """
    input_data = Stage2Input(**input_json)
    output = await run_stage_2(input_data)
    return output.model_dump()


async def run_from_file(input_path: str, output_path: Optional[str] = None) -> dict:
    """
    Run Stage 2 from JSON file, optionally save output to file.

    Args:
        input_path: Path to input JSON file
        output_path: Optional path to save output JSON

    Returns:
        Dictionary with Stage2Output fields

    Raises:
        FileNotFoundError: If input file doesn't exist
        json.JSONDecodeError: If input file is not valid JSON
    """
    # Validate input path exists
    input_file = Path(input_path)
    if not input_file.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")

    # Read input with explicit encoding
    with open(input_file, "r", encoding="utf-8") as f:
        input_json = json.load(f)

    # Run
    result = await run_from_json(input_json)

    # Save output if path provided
    if output_path:
        # Resolve to absolute path (prevents some path traversal)
        output_file = Path(output_path).resolve()
        output_file.parent.mkdir(parents=True, exist_ok=True)
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        logger.info(f"Output saved to {output_file}")

    return result


async def run_from_stage1_output_async(
    stage1_output: dict,
    keyword: str,
    skip_images: bool = False,
    keyword_instructions: Optional[str] = None,
) -> dict:
    """
    Run Stage 2 from Stage 1 output (async version).

    Args:
        stage1_output: Output from Stage 1
        keyword: Which keyword to process (from Stage 1 keywords list)
        skip_images: Skip image generation
        keyword_instructions: Optional keyword-specific instructions

    Returns:
        Stage 2 output as dictionary
    """
    # Extract company context from Stage 1 output
    company_context = stage1_output.get("company_context", {})

    # visual_identity is nested inside company_context
    visual_identity = company_context.get("visual_identity", None)

    # Find the article job for this keyword to get per-article settings
    articles = stage1_output.get("articles", [])
    article_job = None
    for article in articles:
        if isinstance(article, dict) and article.get("keyword") == keyword:
            article_job = article
            break

    # Get word_count from article job, or fall back to default
    word_count = 2000
    if article_job:
        job_word_count = article_job.get("word_count")
        if job_word_count is not None and job_word_count > 0:
            word_count = job_word_count

    # Get country from market field (Stage 1 uses "market", Stage 2 uses "country")
    # Map common market codes to country names
    market = stage1_output.get("market") or "US"  # Handle empty string
    country_map = {
        "US": "United States",
        "UK": "United Kingdom",
        "DE": "Germany",
        "FR": "France",
        "ES": "Spain",
        "IT": "Italy",
        "CA": "Canada",
        "AU": "Australia",
    }
    country = country_map.get(market, market)  # Fall back to market code if not mapped

    # Combine instructions: CLI keyword_instructions overrides, else use article job's
    final_keyword_instructions = keyword_instructions
    if not final_keyword_instructions and article_job:
        final_keyword_instructions = article_job.get("keyword_instructions")

    input_json = {
        "keyword": keyword,
        "company_context": company_context,
        "visual_identity": visual_identity,
        "language": stage1_output.get("language", "en"),
        "country": country,
        "word_count": word_count,
        "custom_instructions": None,  # Batch instructions already combined in article job
        "keyword_instructions": final_keyword_instructions,
        "job_id": stage1_output.get("job_id"),
        "skip_images": skip_images,
    }

    return await run_from_json(input_json)


def run_from_stage1_output(
    stage1_output: dict,
    keyword: str,
    skip_images: bool = False,
    keyword_instructions: Optional[str] = None,
) -> dict:
    """
    Convenience function to run Stage 2 from Stage 1 output (sync wrapper).

    Note: Only use this outside of async context. Use run_from_stage1_output_async
    if you're already in an async context.

    Args:
        stage1_output: Output from Stage 1
        keyword: Which keyword to process (from Stage 1 keywords list)
        skip_images: Skip image generation
        keyword_instructions: Optional keyword-specific instructions

    Returns:
        Stage 2 output as dictionary
    """
    return asyncio.run(run_from_stage1_output_async(stage1_output, keyword, skip_images, keyword_instructions))


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Stage 2: Blog Generation + Image Creation"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        help="Input JSON file path (Stage 1 output or custom input)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output JSON file path"
    )
    parser.add_argument(
        "--keyword",
        type=str,
        help="Primary keyword (required if not in input file)"
    )
    parser.add_argument(
        "--company-url",
        type=str,
        help="Company URL (creates minimal company context)"
    )
    parser.add_argument(
        "--language",
        type=str,
        default="en",
        help="Language code (default: en)"
    )
    parser.add_argument(
        "--word-count",
        type=int,
        default=2000,
        help="Target word count (default: 2000)"
    )
    parser.add_argument(
        "--skip-images",
        action="store_true",
        help="Skip image generation"
    )
    parser.add_argument(
        "--country",
        type=str,
        default="United States",
        help="Target country/region (default: United States)"
    )
    parser.add_argument(
        "--custom-instructions",
        type=str,
        help="Batch-level custom instructions"
    )
    parser.add_argument(
        "--keyword-instructions",
        type=str,
        help="Keyword-specific instructions"
    )

    args = parser.parse_args()

    async def run():
        if args.input:
            # Validate input file exists
            if not Path(args.input).exists():
                logger.error(f"Input file not found: {args.input}")
                sys.exit(1)

            # Read input file with explicit encoding
            with open(args.input, "r", encoding="utf-8") as f:
                input_json = json.load(f)

            # Check if this is Stage 1 output (has articles list)
            if "articles" in input_json and args.keyword:
                result = await run_from_stage1_output_async(
                    input_json,
                    args.keyword,
                    args.skip_images,
                    args.keyword_instructions,  # Pass CLI keyword_instructions
                )
            else:
                # Direct Stage 2 input
                if args.skip_images:
                    input_json["skip_images"] = True
                if args.keyword_instructions:
                    input_json["keyword_instructions"] = args.keyword_instructions
                if args.custom_instructions:
                    input_json["custom_instructions"] = args.custom_instructions
                result = await run_from_json(input_json)

        elif args.keyword:
            # Create input from CLI args
            company_url = args.company_url or ""
            company_name = ""
            if company_url:
                company_name = company_url.replace("https://", "").replace("http://", "").split("/")[0]

            input_data = Stage2Input(
                keyword=args.keyword,
                company_context=CompanyContext(
                    company_url=company_url,
                    company_name=company_name,
                ),
                language=args.language,
                country=args.country,
                word_count=args.word_count,
                custom_instructions=args.custom_instructions,
                keyword_instructions=args.keyword_instructions,
                skip_images=args.skip_images,
            )
            output = await run_stage_2(input_data)
            result = output.model_dump()
        else:
            parser.print_help()
            sys.exit(1)

        # Save output if path provided
        if args.output:
            output_file = Path(args.output).resolve()
            output_file.parent.mkdir(parents=True, exist_ok=True)
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2, ensure_ascii=False)
            logger.info(f"Output saved to {output_file}")

        # Print summary
        print(f"\n=== Stage 2 Complete ===")
        print(f"Headline: {result['article']['Headline']}")
        # Count sections using explicit field names
        section_count = sum(
            1 for i in range(1, 10)
            if result['article'].get(f'section_{i:02d}_title')
        )
        print(f"Sections: {section_count}")
        print(f"Images: {result['images_generated']}")
        print(f"AI Calls: {result['ai_calls']}")

    asyncio.run(run())


if __name__ == "__main__":
    main()
