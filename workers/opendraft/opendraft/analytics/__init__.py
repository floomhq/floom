"""
Analytics module for OpenDraft V2.

Provides quality scoring, metrics calculation, and regression tracking.
"""

from .quality_scorer import QualityScorer, score_draft, compare_scores, RegressionTracker
from .metrics import (
    calculate_ttr,
    calculate_sentence_variety,
    calculate_citation_density,
    count_thesis_statements,
    detect_advocacy_patterns,
)

__all__ = [
    'QualityScorer',
    'score_draft',
    'compare_scores',
    'RegressionTracker',
    'calculate_ttr',
    'calculate_sentence_variety',
    'calculate_citation_density',
    'count_thesis_statements',
    'detect_advocacy_patterns',
]
