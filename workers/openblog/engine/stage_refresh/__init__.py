"""
Stage Refresh: Content Freshener

Uses deep research (Gemini + Google Search) to find and replace
factually outdated information with verified current data.

Usage:
    from stage_refresh import run_refresh, RefreshInput, RefreshOutput

    result = await run_refresh({
        "article": article_dict
    })

CLI:
    python stage_refresh.py --input article.json --output refreshed.json
"""

__version__ = "1.0.0"

from .refresh_models import RefreshInput, RefreshOutput, RefreshFix
from .stage_refresh import ContentRefresher, run_refresh, run_refresh_sync, run_from_file

__all__ = [
    "__version__",
    "run_refresh",
    "run_refresh_sync",
    "run_from_file",
    "RefreshInput",
    "RefreshOutput",
    "RefreshFix",
    "ContentRefresher",
]
