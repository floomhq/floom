"""
Quality scoring for OpenDraft drafts.

Combines multiple metrics into a single quality score.
Used by the quality gate to decide if LLM refinement is needed.
"""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Any, Optional

from .metrics import (
    calculate_ttr,
    calculate_sentence_variety,
    calculate_citation_density,
    count_thesis_statements,
    detect_advocacy_patterns,
    calculate_word_count,
    detect_repetition,
)

logger = logging.getLogger(__name__)


class QualityScorer:
    """
    Comprehensive quality scorer for academic drafts.

    Weights and thresholds can be customized.
    """

    # Default weights for each metric (must sum to 1.0)
    DEFAULT_WEIGHTS = {
        'ttr': 0.20,              # Vocabulary diversity
        'sentence_variety': 0.15, # Sentence length variation
        'citation_density': 0.20, # Citations per paragraph
        'thesis_restraint': 0.15, # Not over-repeating thesis
        'advocacy_clean': 0.15,   # No prescriptive language
        'repetition_clean': 0.15, # No repeated phrases
    }

    # Thresholds for passing quality gate
    DEFAULT_THRESHOLDS = {
        'ttr_min': 0.32,
        'ttr_target': 0.40,
        'variety_min': 50.0,
        'variety_target': 70.0,
        'citation_density_min': 0.5,   # 50% of paragraphs have citations
        'citation_density_target': 1.0, # Every paragraph has 1 citation avg
        'thesis_max': 4,
        'thesis_target': 2,
        'advocacy_max': 3,
        'repetition_max': 5,
    }

    def __init__(
        self,
        weights: Optional[Dict[str, float]] = None,
        thresholds: Optional[Dict[str, float]] = None,
    ):
        self.weights = weights or self.DEFAULT_WEIGHTS.copy()
        self.thresholds = thresholds or self.DEFAULT_THRESHOLDS.copy()

    def score(self, text: str) -> Dict[str, Any]:
        """
        Calculate comprehensive quality score for text.

        Args:
            text: Draft text to score

        Returns:
            Dict with overall score, component scores, and recommendations
        """
        # Calculate all metrics
        ttr = calculate_ttr(text)
        variety = calculate_sentence_variety(text)
        citations = calculate_citation_density(text)
        thesis = count_thesis_statements(text)
        advocacy = detect_advocacy_patterns(text)
        word_stats = calculate_word_count(text)
        repetition = detect_repetition(text)

        # Calculate component scores (0-100 each)
        scores = {}

        # TTR score: linear scale from min to target
        ttr_range = self.thresholds['ttr_target'] - self.thresholds['ttr_min']
        ttr_normalized = (ttr - self.thresholds['ttr_min']) / ttr_range if ttr_range > 0 else 0
        scores['ttr'] = max(0, min(100, ttr_normalized * 100))

        # Sentence variety score: already 0-100
        scores['sentence_variety'] = variety['variety_score']

        # Citation density score
        density_range = self.thresholds['citation_density_target'] - self.thresholds['citation_density_min']
        density_normalized = (citations['density'] - self.thresholds['citation_density_min']) / density_range if density_range > 0 else 0
        scores['citation_density'] = max(0, min(100, density_normalized * 100))

        # Thesis restraint score: penalize over-repetition
        if thesis['count'] <= self.thresholds['thesis_target']:
            scores['thesis_restraint'] = 100
        elif thesis['count'] >= self.thresholds['thesis_max']:
            scores['thesis_restraint'] = 50
        else:
            # Linear decrease
            excess = thesis['count'] - self.thresholds['thesis_target']
            max_excess = self.thresholds['thesis_max'] - self.thresholds['thesis_target']
            scores['thesis_restraint'] = 100 - (excess / max_excess * 50)

        # Advocacy clean score: penalize prescriptive language
        if advocacy['total_issues'] == 0:
            scores['advocacy_clean'] = 100
        elif advocacy['total_issues'] >= self.thresholds['advocacy_max']:
            scores['advocacy_clean'] = 50
        else:
            scores['advocacy_clean'] = 100 - (advocacy['total_issues'] / self.thresholds['advocacy_max'] * 50)

        # Repetition clean score: gradual penalty (no hard floor)
        # Each repeated phrase costs 5 points, minimum score 0
        if repetition['total_repeated'] == 0:
            scores['repetition_clean'] = 100
        else:
            # 5 points per repeat: 2 repeats = 90, 10 repeats = 50, 20 repeats = 0
            scores['repetition_clean'] = max(0, 100 - (repetition['total_repeated'] * 5))

        # Calculate weighted overall score
        overall = sum(
            scores[metric] * weight
            for metric, weight in self.weights.items()
        )

        # Build recommendations
        recommendations = []

        if scores['ttr'] < 70:
            recommendations.append({
                'metric': 'vocabulary',
                'issue': f'TTR is {ttr:.3f}, below target {self.thresholds["ttr_target"]}',
                'action': 'Diversify vocabulary - rotate overused words',
            })

        if scores['sentence_variety'] < 60:
            recommendations.append({
                'metric': 'sentence_variety',
                'issue': f'Variety score is {variety["variety_score"]:.1f}%',
                'action': 'Mix short and long sentences more evenly',
            })

        if scores['citation_density'] < 70:
            recommendations.append({
                'metric': 'citations',
                'issue': f'Citation density is {citations["density"]:.1f} per paragraph',
                'action': 'Add more citations, aim for 2+ per paragraph',
            })

        if thesis['count'] > self.thresholds['thesis_target']:
            recommendations.append({
                'metric': 'thesis',
                'issue': f'Thesis stated {thesis["count"]} times',
                'action': 'Reduce thesis restatements to 2-3 max',
            })

        if advocacy['total_issues'] > 0:
            recommendations.append({
                'metric': 'advocacy',
                'issue': f'{advocacy["total_issues"]} prescriptive language instances',
                'action': 'Replace advocacy language with hedged academic tone',
                'examples': advocacy['findings'][:3],
            })

        if repetition['total_repeated'] > 0:
            recommendations.append({
                'metric': 'repetition',
                'issue': f'{repetition["total_repeated"]} repeated phrases detected',
                'action': 'Vary phrasing to reduce repetition',
                'examples': repetition['repeated_phrases'][:3],
            })

        return {
            'overall_score': round(overall, 1),
            'passes_gate': overall >= 85.0,
            'component_scores': {k: round(v, 1) for k, v in scores.items()},
            'raw_metrics': {
                'ttr': round(ttr, 4),
                'sentence_variety': variety,
                'citation_density': citations,
                'thesis_count': thesis,
                'advocacy': advocacy,
                'repetition': repetition,
                'word_count': word_stats,
            },
            'recommendations': recommendations,
            'timestamp': datetime.now().isoformat(),
        }


def score_draft(text: str) -> Dict[str, Any]:
    """
    Convenience function to score a draft with default settings.

    Args:
        text: Draft text to score

    Returns:
        Quality score dict
    """
    scorer = QualityScorer()
    return scorer.score(text)


def compare_scores(
    before: Dict[str, Any],
    after: Dict[str, Any],
    threshold: float = 5.0
) -> Dict[str, Any]:
    """
    Compare quality scores before and after cleanup.

    Args:
        before: Score dict before cleanup
        after: Score dict after cleanup
        threshold: Minimum delta to report as significant (default 5.0)

    Returns:
        Comparison dict with deltas
    """
    overall_delta = after['overall_score'] - before['overall_score']

    component_deltas = {}
    for metric in before['component_scores']:
        delta = after['component_scores'][metric] - before['component_scores'][metric]
        component_deltas[metric] = round(delta, 1)

    improvements = []
    regressions = []

    for metric, delta in component_deltas.items():
        if delta > threshold:
            improvements.append({'metric': metric, 'delta': delta})
        elif delta < -threshold:
            regressions.append({'metric': metric, 'delta': delta})

    return {
        'overall_delta': round(overall_delta, 1),
        'component_deltas': component_deltas,
        'improvements': improvements,
        'regressions': regressions,
        'net_improvement': overall_delta > 0,
    }


class RegressionTracker:
    """
    Track quality scores across runs for regression detection.
    """

    def __init__(self, storage_path: Optional[Path] = None):
        self.storage_path = storage_path or Path.home() / '.opendraft' / 'analytics'
        self.storage_path.mkdir(parents=True, exist_ok=True)
        self.history_file = self.storage_path / 'quality_history.jsonl'

    def record(
        self,
        run_id: str,
        topic: str,
        score: Dict[str, Any],
        stage: str = 'final',
    ) -> None:
        """
        Record a quality score for a run.

        Args:
            run_id: Unique run identifier
            topic: Paper topic
            score: Quality score dict
            stage: 'before_cleanup', 'after_cleanup', or 'final'
        """
        record = {
            'run_id': run_id,
            'topic': topic[:100],  # Truncate long topics
            'stage': stage,
            'overall_score': score['overall_score'],
            'component_scores': score['component_scores'],
            'word_count': score['raw_metrics']['word_count']['word_count'],
            'timestamp': datetime.now().isoformat(),
        }

        with open(self.history_file, 'a') as f:
            f.write(json.dumps(record) + '\n')

        logger.info("Recorded quality score: %.1f for run %s", score['overall_score'], run_id)

    def get_recent(self, n: int = 20) -> list:
        """
        Get the N most recent quality records.

        Args:
            n: Number of records to return

        Returns:
            List of record dicts
        """
        if not self.history_file.exists():
            return []

        records = []
        with open(self.history_file, 'r') as f:
            for line in f:
                if line.strip():
                    records.append(json.loads(line))

        return records[-n:]

    def get_averages(self) -> Dict[str, float]:
        """
        Get average scores across all recorded runs.

        Returns:
            Dict with average overall and component scores
        """
        records = self.get_recent(100)
        if not records:
            return {}

        # Only consider 'final' stage records
        final_records = [r for r in records if r.get('stage') == 'final']
        if not final_records:
            return {}

        avg_overall = sum(r['overall_score'] for r in final_records) / len(final_records)

        # Average component scores
        component_sums: Dict[str, float] = {}
        for record in final_records:
            for metric, score in record.get('component_scores', {}).items():
                component_sums[metric] = component_sums.get(metric, 0) + score

        avg_components = {
            metric: total / len(final_records)
            for metric, total in component_sums.items()
        }

        return {
            'overall': round(avg_overall, 1),
            'components': {k: round(v, 1) for k, v in avg_components.items()},
            'sample_size': len(final_records),
        }
