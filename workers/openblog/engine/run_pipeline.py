#!/usr/bin/env python3
"""
OpenBlog Neo - Main Pipeline Orchestrator

Runs the 5-stage blog generation pipeline:
- Stage 1: Set Context (runs once per batch)
- Stages 2-5: Run per article, all articles in parallel

Usage:
    python run_pipeline.py --url https://example.com --keywords "keyword 1" "keyword 2"
    python run_pipeline.py --input batch.json --output results/

Architecture:
    Stage 1 (once)
         ↓
    ┌────┴────┬─────────┐
    ▼         ▼         ▼
  [Art 1]  [Art 2]  [Art 3]  ← parallel
    │         │         │
    ▼         ▼         ▼
  Stage 2   Stage 2   Stage 2
    │         │         │
    ▼         ▼         ▼
  Stage 3   Stage 3   Stage 3  ← sequential per article
    │         │         │
    ▼         ▼         ▼
  Stage 4   Stage 4   Stage 4
    │         │         │
    ▼         ▼         ▼
  Stage 5   Stage 5   Stage 5
    │         │         │
    ▼         ▼         ▼
  [Out 1]  [Out 2]  [Out 3]
"""

import asyncio
import argparse
import copy
import importlib.util
import json
import logging
import sys
from pathlib import Path
from datetime import datetime
from typing import List, Optional

from dotenv import load_dotenv

# Load .env from current directory
load_dotenv(Path(__file__).parent / ".env")

# =============================================================================
# Module Loading - Done ONCE at import time for thread safety
# =============================================================================

_BASE_PATH = Path(__file__).parent

# Add base path for imports
if str(_BASE_PATH) not in sys.path:
    sys.path.insert(0, str(_BASE_PATH))

from shared.models import ArticleOutput
from shared.html_renderer import HTMLRenderer
from shared.article_exporter import ArticleExporter


def _load_module_from_path(module_name: str, file_path: Path):
    """Load a module from a specific file path."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Pre-load all stage modules at import time (thread-safe)
# Stage 2
_stage2_path = _BASE_PATH / "stage2"
if str(_stage2_path) not in sys.path:
    sys.path.insert(0, str(_stage2_path))
from stage_2 import run_stage_2, Stage2Input, CompanyContext, VisualIdentity

# Stage 3 - uniquely named models file, no collision risk
_stage3_path = _BASE_PATH / "stage3"
if str(_stage3_path) not in sys.path:
    sys.path.insert(0, str(_stage3_path))
_stage3_models = _load_module_from_path("stage3_models", _stage3_path / "stage3_models.py")
Stage3Input = _stage3_models.Stage3Input
_stage3_module = _load_module_from_path("stage_3_module", _stage3_path / "stage_3.py")
run_stage_3 = _stage3_module.run_stage_3

# Stage 4 - uniquely named models file, no collision risk
_stage4_path = _BASE_PATH / "stage4"
if str(_stage4_path) not in sys.path:
    sys.path.insert(0, str(_stage4_path))
_stage4_models = _load_module_from_path("stage4_models", _stage4_path / "stage4_models.py")
Stage4Input = _stage4_models.Stage4Input
_stage4_module = _load_module_from_path("stage_4_module", _stage4_path / "stage_4.py")
run_stage_4 = _stage4_module.run_stage_4

# Stage 5 - uniquely named models file, no collision risk
_stage5_path = _BASE_PATH / "stage5"
if str(_stage5_path) not in sys.path:
    sys.path.insert(0, str(_stage5_path))
_stage5_models = _load_module_from_path("stage5_models", _stage5_path / "stage5_models.py")
_stage5_module = _load_module_from_path("stage_5_module", _stage5_path / "stage_5.py")
run_stage_5 = _stage5_module.run_stage_5

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# =============================================================================
# Pipeline Orchestration
# =============================================================================

async def process_single_article(
    context,
    article,
    skip_images: bool = False,
    output_dir: Optional[Path] = None,
    export_formats: Optional[List[str]] = None,
) -> dict:
    """
    Process one article through stages 2-5 sequentially.

    Uses pre-loaded stage modules (loaded at import time for thread safety).

    Args:
        context: Stage1Output with company context, sitemap, etc.
        article: ArticleJob with keyword, slug, href
        skip_images: Skip image generation in Stage 2
        output_dir: Directory for exported files
        export_formats: List of export formats (html, markdown, json, csv, xlsx, pdf)

    Returns:
        Dict with article output and metadata
    """
    logger.info(f"  Processing article: {article.keyword}")

    result = {
        "keyword": article.keyword,
        "slug": article.slug,
        "href": article.href,
        "article": None,
        "images": [],
        "reports": {},
        "exported_files": {},
        "error": None,
    }

    try:
        # -----------------------------------------
        # Stage 2: Blog Gen + Image Gen
        # -----------------------------------------
        logger.info(f"    [Stage 2] Generating article...")

        # Extract visual_identity from company_context
        company_ctx = context.company_context.model_dump()
        visual_identity_data = company_ctx.pop("visual_identity", None)

        stage2_input = Stage2Input(
            keyword=article.keyword,
            company_context=CompanyContext(**company_ctx),
            visual_identity=VisualIdentity(**visual_identity_data) if visual_identity_data else None,
            language=context.language,
            job_id=context.job_id,
            skip_images=skip_images,
        )

        stage2_output = await run_stage_2(stage2_input)
        # Deep copy to prevent mutation side effects between stages
        article_dict = copy.deepcopy(stage2_output.article.model_dump())
        result["images"] = [img.model_dump() for img in stage2_output.images]
        result["reports"]["stage2"] = {
            "ai_calls": stage2_output.ai_calls,
            "images_generated": stage2_output.images_generated,
        }
        logger.info(f"    [Stage 2] ✓ Generated: {stage2_output.article.Headline[:50]}...")

        # -----------------------------------------
        # Stage 3: Quality Check
        # -----------------------------------------
        logger.info(f"    [Stage 3] Quality check...")

        # Build voice context from Stage 1 for brand-aligned quality fixes
        voice_context = None
        voice_persona = context.company_context.voice_persona
        if voice_persona:
            # Extract key voice fields for quality checking
            voice_data = voice_persona if isinstance(voice_persona, dict) else voice_persona.model_dump()
            lang_style = voice_data.get("language_style", {})
            if isinstance(lang_style, dict):
                formality = lang_style.get("formality", "")
            else:
                formality = getattr(lang_style, "formality", "")

            voice_context = {
                "tone": context.company_context.tone,
                "banned_words": voice_data.get("banned_words", []),
                "do_list": voice_data.get("do_list", []),
                "dont_list": voice_data.get("dont_list", []),
                "example_phrases": voice_data.get("example_phrases", []),
                "formality": formality,
                "first_person_usage": voice_data.get("first_person_usage", ""),
            }

        stage3_output = await run_stage_3({
            "article": article_dict,
            "keyword": article.keyword,
            "language": context.language,
            "voice_context": voice_context,
        })

        # Deep copy to prevent mutation side effects
        article_dict = copy.deepcopy(stage3_output["article"])
        result["reports"]["stage3"] = {
            "fixes_applied": stage3_output["fixes_applied"],
            "ai_calls": stage3_output["ai_calls"],
        }
        logger.info(f"    [Stage 3] ✓ Applied {stage3_output['fixes_applied']} fixes")

        # -----------------------------------------
        # Stage 4: URL Verification
        # -----------------------------------------
        logger.info(f"    [Stage 4] URL verification...")

        stage4_input = Stage4Input(
            article=article_dict,
            keyword=article.keyword,
            company_name=context.company_context.company_name,
        )

        stage4_output = await run_stage_4(stage4_input)
        # Deep copy to prevent mutation side effects
        article_dict = copy.deepcopy(stage4_output.article)
        result["reports"]["stage4"] = {
            "total_urls": stage4_output.total_urls,
            "valid_urls": stage4_output.valid_urls,
            "dead_urls": stage4_output.dead_urls,
            "replaced_urls": stage4_output.replaced_urls,
            "ai_calls": stage4_output.ai_calls,
        }
        logger.info(f"    [Stage 4] ✓ Verified {stage4_output.total_urls} URLs, replaced {stage4_output.replaced_urls}")

        # -----------------------------------------
        # Stage 5: Internal Links
        # -----------------------------------------
        logger.info(f"    [Stage 5] Internal links...")

        # Build batch siblings (other articles in this batch)
        batch_siblings = [
            {"keyword": a.keyword, "slug": a.slug, "href": a.href}
            for a in context.articles
            if a.keyword != article.keyword
        ]

        # Collect sitemap URLs with truncation warnings if needed
        blog_urls = context.sitemap.blog_urls if context.sitemap else []
        resource_urls = context.sitemap.resource_urls if context.sitemap else []
        tool_urls = context.sitemap.tool_urls if context.sitemap else []
        product_urls = context.sitemap.product_urls if context.sitemap else []
        service_urls = context.sitemap.service_urls if context.sitemap else []

        if len(blog_urls) > 50:
            logger.debug(f"    Truncating {len(blog_urls)} blog URLs to 50 for internal linking")
        if len(resource_urls) > 20:
            logger.debug(f"    Truncating {len(resource_urls)} resource URLs to 20 for internal linking")

        stage5_output = await run_stage_5({
            "article": article_dict,
            "current_href": article.href,
            "company_url": context.company_context.company_url,
            "batch_siblings": batch_siblings,
            "sitemap_blog_urls": blog_urls[:50],
            "sitemap_resource_urls": resource_urls[:20],
            "sitemap_tool_urls": tool_urls[:10],
            "sitemap_product_urls": product_urls[:10],
            "sitemap_service_urls": service_urls[:5],
        })

        # Deep copy to prevent mutation side effects
        article_dict = copy.deepcopy(stage5_output["article"])
        result["reports"]["stage5"] = {
            "links_added": stage5_output["links_added"],
        }
        logger.info(f"    [Stage 5] ✓ Added {stage5_output['links_added']} internal links")

        # -----------------------------------------
        # Export (if output_dir provided)
        # -----------------------------------------
        if output_dir:
            logger.info(f"    [Export] Exporting article...")

            # Render HTML
            html_content = HTMLRenderer.render(
                article=article_dict,
                company_name=context.company_context.company_name,
                company_url=context.company_context.company_url,
            )

            # Export all formats
            formats = export_formats or ["html", "json"]
            article_output_dir = output_dir / article.slug
            exported = ArticleExporter.export_all(
                article=article_dict,
                html_content=html_content,
                output_dir=article_output_dir,
                formats=formats,
            )

            result["exported_files"] = exported
            logger.info(f"    [Export] ✓ Exported to {article_output_dir}")

        result["article"] = article_dict
        logger.info(f"  ✓ Article complete: {article.keyword}")

    except Exception as e:
        logger.error(f"  ✗ Article failed: {article.keyword} - {type(e).__name__}: {e}")
        # Log exception details at debug level (avoid exposing sensitive data in production logs)
        logger.debug(f"Full exception for {article.keyword}:", exc_info=True)
        result["error"] = str(e)

    return result


async def run_pipeline(
    keywords: List[str],
    company_url: str,
    language: str = "en",
    market: str = "US",
    skip_images: bool = False,
    max_parallel: Optional[int] = None,
    output_dir: Optional[Path] = None,
    export_formats: Optional[List[str]] = None,
) -> dict:
    """
    Run full pipeline: Stage 1 once, then Stages 2-5 for each article in parallel.

    Args:
        keywords: List of keywords to generate articles for
        company_url: Company website URL
        language: Target language code
        market: Target market code
        skip_images: Skip image generation
        max_parallel: Limit concurrent article processing (None = unlimited)
        output_dir: Directory for exported files
        export_formats: List of export formats (html, markdown, json, csv, xlsx, pdf)

    Returns:
        Dict with pipeline results
    """
    start_time = datetime.now()
    logger.info("=" * 60)
    logger.info("OpenBlog Neo Pipeline")
    logger.info("=" * 60)
    logger.info(f"Keywords: {len(keywords)}")
    logger.info(f"Company: {company_url}")
    logger.info(f"Language: {language}, Market: {market}")
    logger.info("=" * 60)

    # Import Stage 1
    sys.path.insert(0, str(Path(__file__).parent / "stage1"))
    from stage_1 import run_stage_1
    from stage1_models import Stage1Input

    # -----------------------------------------
    # Stage 1: Set Context (runs once)
    # -----------------------------------------
    logger.info("\n[Stage 1] Set Context")

    input_data = Stage1Input(
        keywords=keywords,
        company_url=company_url,
        language=language,
        market=market,
    )

    context = await run_stage_1(input_data)

    logger.info(f"  Company: {context.company_context.company_name}")
    logger.info(f"  Articles: {len(context.articles)}")
    logger.info(f"  Sitemap: {context.sitemap.total_pages} pages")

    # -----------------------------------------
    # Stages 2-5: Per article (parallel)
    # -----------------------------------------
    logger.info("\n[Stages 2-5] Article Processing (parallel)")

    # Create tasks for each article
    tasks = [
        process_single_article(
            context,
            article,
            skip_images=skip_images,
            output_dir=output_dir,
            export_formats=export_formats,
        )
        for article in context.articles
    ]

    # Run with optional concurrency limit
    # Use return_exceptions=True to prevent one failed article from stopping all processing
    if max_parallel and max_parallel > 0:
        # Use semaphore to limit concurrency
        semaphore = asyncio.Semaphore(max_parallel)

        async def limited_task(task):
            async with semaphore:
                return await task

        results = await asyncio.gather(*[limited_task(t) for t in tasks], return_exceptions=True)
    else:
        # Unlimited parallelism
        results = await asyncio.gather(*tasks, return_exceptions=True)

    # Handle any exceptions that were returned
    processed_results = []
    for i, result in enumerate(results):
        if isinstance(result, Exception):
            keyword = context.articles[i].keyword if i < len(context.articles) else f"article_{i}"
            logger.error(f"  ✗ Article failed with exception: {keyword} - {result}")
            processed_results.append({
                "keyword": keyword,
                "article": None,
                "error": str(result),
            })
        else:
            processed_results.append(result)
    results = processed_results

    # -----------------------------------------
    # Collect Results
    # -----------------------------------------
    end_time = datetime.now()
    duration = (end_time - start_time).total_seconds()

    successful = sum(1 for r in results if r.get("article") or not r.get("error"))
    failed = sum(1 for r in results if r.get("error"))

    logger.info("\n" + "=" * 60)
    logger.info("Pipeline Complete")
    logger.info("=" * 60)
    logger.info(f"Duration: {duration:.1f}s")
    logger.info(f"Articles: {successful} successful, {failed} failed")
    logger.info("=" * 60)

    return {
        "job_id": context.job_id,
        "company": context.company_context.company_name,
        "language": language,
        "market": market,
        "duration_seconds": duration,
        "articles_total": len(results),
        "articles_successful": successful,
        "articles_failed": failed,
        "context": context.model_dump(),
        "results": results,
        "created_at": start_time.isoformat(),
    }


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="OpenBlog Neo - AI Blog Generation Pipeline"
    )
    parser.add_argument(
        "--url",
        type=str,
        help="Company URL"
    )
    parser.add_argument(
        "--keywords",
        type=str,
        nargs="+",
        help="Keywords for blog generation"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        help="Input JSON file with batch configuration"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output directory or file path"
    )
    parser.add_argument(
        "--language",
        type=str,
        default="en",
        help="Target language code (default: en)"
    )
    parser.add_argument(
        "--market",
        type=str,
        default="US",
        help="Target market code (default: US)"
    )
    parser.add_argument(
        "--skip-images",
        action="store_true",
        help="Skip image generation"
    )
    parser.add_argument(
        "--max-parallel",
        type=int,
        default=None,
        help="Max concurrent articles (default: unlimited)"
    )
    parser.add_argument(
        "--export-formats",
        type=str,
        nargs="+",
        default=["html", "json"],
        help="Export formats: html, markdown, json, csv, xlsx, pdf (default: html json)"
    )

    args = parser.parse_args()

    # Get input from file or CLI args
    if args.input:
        with open(args.input, "r") as f:
            config = json.load(f)
        keywords = config.get("keywords", [])
        company_url = config.get("company_url", "")
        language = config.get("language", args.language)
        market = config.get("market", args.market)
    elif args.url and args.keywords:
        keywords = args.keywords
        company_url = args.url
        language = args.language
        market = args.market
    else:
        parser.print_help()
        sys.exit(1)

    # Determine output directory
    output_dir = None
    if args.output:
        output_path = Path(args.output)
        if output_path.is_dir() or args.output.endswith("/"):
            output_dir = output_path
        else:
            output_dir = output_path.parent

    # Run pipeline
    results = asyncio.run(run_pipeline(
        keywords=keywords,
        company_url=company_url,
        language=language,
        market=market,
        skip_images=args.skip_images,
        max_parallel=args.max_parallel,
        output_dir=output_dir,
        export_formats=args.export_formats,
    ))

    # Save output
    if args.output:
        output_path = Path(args.output)
        if output_path.is_dir() or args.output.endswith("/"):
            output_path.mkdir(parents=True, exist_ok=True)
            output_file = output_path / f"pipeline_{results['job_id']}.json"
        else:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_file = output_path

        with open(output_file, "w") as f:
            json.dump(results, f, indent=2)
        logger.info(f"\nOutput saved to: {output_file}")
    else:
        # Print summary to stdout
        print(json.dumps({
            "job_id": results["job_id"],
            "company": results["company"],
            "articles_total": results["articles_total"],
            "articles_successful": results["articles_successful"],
            "duration_seconds": results["duration_seconds"],
        }, indent=2))


if __name__ == "__main__":
    main()
