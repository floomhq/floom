"""
Stage 2: Blog Generation + Image Creation

Generates a complete blog article using Gemini AI with Google Search grounding,
plus 3 images using Google Imagen.

Micro-API Design:
- Input: Stage2Input (keyword, company_context, language, word_count)
- Output: Stage2Output (ArticleOutput + image URLs)
- Can run as CLI or be imported as a module

AI Calls:
- 1x Gemini (blog article with 40+ fields)
- 3x Imagen (hero, mid, bottom images) - optional
"""

from .article_schema import ArticleOutput, Source, ComparisonTable
from .stage_2 import (
    run_stage_2,
    run_from_json,
    run_from_stage1_output,
    run_from_stage1_output_async,
    Stage2Input,
    Stage2Output,
)

__all__ = [
    "ArticleOutput",
    "Source",
    "ComparisonTable",
    "Stage2Input",
    "Stage2Output",
    "run_stage_2",
    "run_from_json",
    "run_from_stage1_output",
    "run_from_stage1_output_async",
]
