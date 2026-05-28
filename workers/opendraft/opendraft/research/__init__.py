"""Research results formatting and ingestion module."""
from .format_results import ResultsFormatter
from .store import (
    ResearchStore,
    ResearchResult,
    RegressionResult,
    TTestResult,
    CorrelationResult,
    DescriptivesResult,
    ThemeResult,
    AnovaResult,
    ChiSquareResult,
    # Phase 2b: Extended analysis
    LogisticRegressionResult,
    LogisticPredictor,
    NonParametricResult,
    FactorialAnovaResult,
    RepeatedMeasuresResult,
    ReliabilityResult,
    Figure,
    Predictor,
)
from .ingest import IngestOps

__all__ = [
    # MVP formatter
    "ResultsFormatter",
    # Phase 1: Store and dataclasses
    "ResearchStore",
    "ResearchResult",
    "RegressionResult",
    "TTestResult",
    "CorrelationResult",
    "DescriptivesResult",
    "ThemeResult",
    "AnovaResult",
    "ChiSquareResult",
    "Figure",
    "Predictor",
    # Phase 2b: Extended analysis
    "LogisticRegressionResult",
    "LogisticPredictor",
    "NonParametricResult",
    "FactorialAnovaResult",
    "RepeatedMeasuresResult",
    "ReliabilityResult",
    # Phase 1: Ingest operations
    "IngestOps",
]
