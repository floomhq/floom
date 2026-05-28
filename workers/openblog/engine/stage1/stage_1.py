"""
Stage 1: Set Context

Sets up all context for blog generation:
1. Job Input: Keywords (batch), company URL, language, market
2. Company Context: From provided data OR OpenContext (Gemini + Google Search)
3. Sitemap: Crawled and labeled URLs for internal linking
4. Voice Enhancement: Refine voice_persona by analyzing real blog content

Micro-API Design:
- Input: JSON with keywords, company_url, language, market, optional company_context
- Output: JSON with job_id, keywords, company_context, sitemap, metadata
- Can run as CLI or be imported as a module

AI Calls: 0-2
- OpenContext: 0-1 (only if company_context not provided)
- Voice Enhancement: 0-1 (only if 3+ blog URLs available)
"""

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Load .env from parent directory (openblog-neo/)
load_dotenv(Path(__file__).parent.parent / ".env")

from stage1_models import Stage1Input, Stage1Output, ArticleJob, generate_slug
from opencontext import get_company_context
from sitemap_crawler import crawl_sitemap
from voice_enhancer import sample_and_enhance
from constants import VOICE_ENHANCEMENT_SAMPLE_SIZE, VOICE_ENHANCEMENT_MIN_BLOGS

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# =============================================================================
# Core Logic
# =============================================================================

async def run_stage_1(input_data: Stage1Input) -> Stage1Output:
    """
    Run Stage 1: Set Context.

    Args:
        input_data: Stage1Input with keywords, company_url, language, market

    Returns:
        Stage1Output with complete context for downstream stages
    """
    logger.info(f"Stage 1: Set Context")
    logger.info(f"  Keywords: {input_data.keywords}")
    logger.info(f"  Company URL: {input_data.company_url}")
    logger.info(f"  Language: {input_data.language}")
    logger.info(f"  Market: {input_data.market}")

    ai_calls = 0
    opencontext_called = False

    # -----------------------------------------
    # Step 1: Get Company Context
    # -----------------------------------------
    if input_data.company_context and input_data.company_context.company_name:
        # Use provided company context (0 AI calls)
        logger.info("  Using provided company_context (0 AI calls)")
        company_context = input_data.company_context
    else:
        # Run OpenContext (1 AI call)
        logger.info("  Running OpenContext (1 AI call)")
        company_context, ai_called = await get_company_context(
            url=input_data.company_url,
            fallback_on_error=True
        )
        if ai_called:
            ai_calls += 1
            opencontext_called = True
        logger.info(f"  Company: {company_context.company_name}")

    # -----------------------------------------
    # Step 2: Crawl Sitemap (no AI)
    # -----------------------------------------
    logger.info("  Crawling sitemap...")
    sitemap_data = await crawl_sitemap(company_url=input_data.company_url)
    logger.info(f"  Sitemap: {sitemap_data.total_pages} pages, {len(sitemap_data.blog_urls)} blog URLs")

    # -----------------------------------------
    # Step 3: Enhance Voice Persona from Blog Content (1 AI call)
    # -----------------------------------------
    voice_enhanced = False
    voice_enhancement_urls = []

    if sitemap_data.blog_urls and len(sitemap_data.blog_urls) >= VOICE_ENHANCEMENT_MIN_BLOGS:
        logger.info(f"  Enhancing voice persona from {VOICE_ENHANCEMENT_SAMPLE_SIZE} blog samples...")
        enhanced_persona, voice_enhancement_urls, voice_enhanced = await sample_and_enhance(
            initial_persona=company_context.voice_persona,
            blog_urls=sitemap_data.blog_urls,
            sample_size=VOICE_ENHANCEMENT_SAMPLE_SIZE,
            min_blogs_required=VOICE_ENHANCEMENT_MIN_BLOGS,
        )
        if voice_enhanced:
            company_context.voice_persona = enhanced_persona
            ai_calls += 1
            logger.info(f"  Voice persona enhanced using {len(voice_enhancement_urls)} blog URLs")
        else:
            logger.info("  Voice enhancement skipped or failed, using initial persona")
    else:
        logger.info(f"  Not enough blog URLs ({len(sitemap_data.blog_urls)}) for voice enhancement, skipping")

    # -----------------------------------------
    # Step 4: Generate Article Jobs with Slugs
    # -----------------------------------------
    articles = []
    keyword_configs = input_data.get_keyword_configs()
    for config in keyword_configs:
        slug = generate_slug(config.keyword)
        href = f"/magazine/{slug}"
        articles.append(ArticleJob(
            keyword=config.keyword,
            slug=slug,
            href=href,
            word_count=config.word_count,
            keyword_instructions=config.instructions,
        ))
    logger.info(f"  Articles: {len(articles)} jobs created")

    # -----------------------------------------
    # Build Output
    # -----------------------------------------
    output = Stage1Output(
        articles=articles,
        language=input_data.language,
        market=input_data.market,
        company_context=company_context,
        sitemap=sitemap_data,
        opencontext_called=opencontext_called,
        ai_calls=ai_calls,
        voice_enhanced=voice_enhanced,
        voice_enhancement_urls=voice_enhancement_urls,
    )

    logger.info(f"Stage 1 complete. Job ID: {output.job_id}")

    return output


# =============================================================================
# JSON Interface (Micro-API)
# =============================================================================

async def run_from_json(input_json: dict) -> dict:
    """
    Run Stage 1 from JSON input, return JSON output.

    Micro-API interface for integration with other stages or services.

    Args:
        input_json: Dictionary with Stage1Input fields

    Returns:
        Dictionary with Stage1Output fields
    """
    input_data = Stage1Input(**input_json)
    output = await run_stage_1(input_data)
    return output.model_dump()


async def run_from_file(input_path: str, output_path: Optional[str] = None) -> dict:
    """
    Run Stage 1 from JSON file, optionally save output to file.

    Args:
        input_path: Path to input JSON file
        output_path: Optional path to save output JSON

    Returns:
        Dictionary with Stage1Output fields
    """
    # Read input
    with open(input_path, "r") as f:
        input_json = json.load(f)

    # Run
    result = await run_from_json(input_json)

    # Save output if path provided
    if output_path:
        with open(output_path, "w") as f:
            json.dump(result, f, indent=2)
        logger.info(f"Output saved to {output_path}")

    return result


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Stage 1: Set Context - Extract company context and sitemap"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        help="Input JSON file path"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output JSON file path"
    )
    parser.add_argument(
        "--url",
        type=str,
        help="Company URL (alternative to --input)"
    )
    parser.add_argument(
        "--keywords",
        type=str,
        nargs="+",
        help="Keywords (alternative to --input)"
    )
    parser.add_argument(
        "--language",
        type=str,
        default="en",
        help="Language code (default: en)"
    )
    parser.add_argument(
        "--market",
        type=str,
        default="US",
        help="Market code (default: US)"
    )

    args = parser.parse_args()

    async def run():
        if args.input:
            # Run from file
            result = await run_from_file(args.input, args.output)
        elif args.url and args.keywords:
            # Run from CLI args
            input_data = Stage1Input(
                keywords=args.keywords,
                company_url=args.url,
                language=args.language,
                market=args.market,
            )
            output = await run_stage_1(input_data)
            result = output.model_dump()

            if args.output:
                with open(args.output, "w") as f:
                    json.dump(result, f, indent=2)
                logger.info(f"Output saved to {args.output}")
        else:
            parser.print_help()
            sys.exit(1)

        # Print result
        print(json.dumps(result, indent=2))

    asyncio.run(run())


if __name__ == "__main__":
    main()
