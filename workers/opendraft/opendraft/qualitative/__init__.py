"""Qualitative analysis module.

Provides tools for analyzing text data:
- Word frequency analysis
- Quote extraction
- Thematic analysis (AI-based)
- Sentiment analysis
- Code segment classification

V3.1: Qualitative Pipeline
- CodeDatabase: Storage for codes and coded segments
- Hierarchical coding support
- Co-occurrence analysis
- CoderAgent, AnalystAgent, SynthesizerAgent: AI-powered coding workflow
"""

from .ops import QualitativeOps
from .database import (
    CodeDatabase,
    Code,
    CodedSegment,
    save_code_database,
    load_code_database,
    Memo,
    MemoDatabase,
    calculate_cohens_kappa,
    calculate_percent_agreement,
)
from .importer import QualitativeImporter
from .agents import (
    CoderAgent,
    AnalystAgent,
    SynthesizerAgent,
    QualitativeOpsHandler,
)
from .pipeline import QualitativePipeline, QualitativePipelineState
from .exporter import QualitativeExporter

__all__ = [
    "QualitativeOps",
    "CodeDatabase",
    "Code",
    "CodedSegment",
    "save_code_database",
    "load_code_database",
    "Memo",
    "MemoDatabase",
    "calculate_cohens_kappa",
    "calculate_percent_agreement",
    "QualitativeImporter",
    "CoderAgent",
    "AnalystAgent",
    "SynthesizerAgent",
    "QualitativeOpsHandler",
    "QualitativePipeline",
    "QualitativePipelineState",
    "QualitativeExporter",
]
