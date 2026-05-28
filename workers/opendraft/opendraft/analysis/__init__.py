"""Data analysis module for Phase 2.

Provides functions to analyze user-uploaded CSV data with automatic
ingestion into ResearchStore for APA formatting.
"""

from .ops import AnalysisOps
from .figures import FigureGenerator

__all__ = ["AnalysisOps", "FigureGenerator"]
