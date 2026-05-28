"""
Stage 5: Internal Links

Embeds internal links naturally into blog content using Gemini.
"""

from .stage5_models import Stage5Input, Stage5Output, LinkCandidate, LinkEmbedding
from .stage_5 import InternalLinker, run_stage_5

__all__ = [
    "Stage5Input",
    "Stage5Output",
    "LinkCandidate",
    "LinkEmbedding",
    "InternalLinker",
    "run_stage_5",
]
