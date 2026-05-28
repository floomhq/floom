"""
Stage 1: Set Context

Sets up all context for blog generation:
- Job Input: Keywords (batch), company URL, language, market
- Company Context: Via OpenContext (Gemini + Google Search)
- Sitemap: Crawled and labeled URLs

Usage:
    from stage_1 import run_stage_1, Stage1Input, Stage1Output

    input_data = Stage1Input(
        keywords=[
            "keyword 1",
            {"keyword": "keyword 2", "word_count": 3000, "keyword_instructions": "Extra detail"}
        ],
        company_url="https://example.com",
        language="en",
        market="US",
        default_word_count=2000,
        batch_instructions="B2B focus"
    )

    output = await run_stage_1(input_data)

CLI:
    python stage_1.py --url https://example.com --keywords "keyword 1" "keyword 2"
    python stage_1.py --input job.json --output context.json
"""

from .stage1_models import (
    Stage1Input,
    Stage1Output,
    ArticleJob,
    KeywordConfig,
    CompanyContext,
    SitemapData,
    VoicePersona,
    LanguageStyle,
    VisualIdentity,
    BlogImageExample,
    generate_slug,
)
from .stage_1 import run_stage_1, run_from_json, run_from_file
from .opencontext import get_company_context, run_opencontext
from .sitemap_crawler import crawl_sitemap, SitemapCrawler

__all__ = [
    # Main entry points
    "run_stage_1",
    "run_from_json",
    "run_from_file",
    # Models
    "Stage1Input",
    "Stage1Output",
    "ArticleJob",
    "KeywordConfig",
    "CompanyContext",
    "SitemapData",
    "VoicePersona",
    "LanguageStyle",
    "VisualIdentity",
    "BlogImageExample",
    "generate_slug",
    # Sub-modules
    "get_company_context",
    "run_opencontext",
    "crawl_sitemap",
    "SitemapCrawler",
]
