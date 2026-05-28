"""
Stage 4: URL Verification

Verifies and fixes broken/irrelevant URLs in article content:
- HTTP HEAD/GET checks for accessibility
- Gemini url_context for content relevance
- Gemini google_search for replacement sources
- Surgical find/replace in article fields

Usage:
    from stage_4 import run_stage_4, Stage4Input, Stage4Output

    input_data = Stage4Input(
        article=article_dict,
        keyword="AI code review",
    )

    output = await run_stage_4(input_data)
    print(f"Replaced {output.replaced_urls} URLs")

CLI:
    python stage_4.py --input article.json --output verified.json --keyword "AI tools"
"""

from .stage4_models import (
    Stage4Input,
    Stage4Output,
    URLVerificationResult,
    URLReplacement,
    URLStatus,
)
from .stage_4 import run_stage_4, run_from_json, run_from_file
from .url_extractor import URLExtractor, extract_urls
from .http_checker import HTTPChecker, HTTPCheckResult, check_urls
from .url_verifier import URLVerifier

__all__ = [
    # Main entry points
    "run_stage_4",
    "run_from_json",
    "run_from_file",
    # Models
    "Stage4Input",
    "Stage4Output",
    "URLVerificationResult",
    "URLReplacement",
    "URLStatus",
    # URL extraction
    "URLExtractor",
    "extract_urls",
    # HTTP checking
    "HTTPChecker",
    "HTTPCheckResult",
    "check_urls",
    # AI verification
    "URLVerifier",
]
