"""
Stage 3: Quality Check

Surgical fixes to transform AI-generated content into human-written copywriter quality.

Usage:
    from stage_3 import run_stage_3, Stage3Input, Stage3Output

    result = await run_stage_3({
        "article": article_dict,
        "keyword": "sales automation",
        "language": "en"
    })

CLI:
    python stage_3.py --input article.json --output fixed.json --keyword "AI tools"
"""

__version__ = "1.0.0"

from .stage3_models import Stage3Input, Stage3Output, QualityFix
from .stage_3 import QualityFixer, run_stage_3, run_stage_3_sync, run_from_file

__all__ = [
    # Metadata
    "__version__",
    # Main entry points
    "run_stage_3",
    "run_stage_3_sync",
    "run_from_file",
    # Models
    "Stage3Input",
    "Stage3Output",
    "QualityFix",
    # Class
    "QualityFixer",
]
