"""Academic search function implementations wrapping CrossRef + Semantic Scholar."""

import logging
from typing import Dict, List, Any

from opendraft.citations.crossref import CrossrefClient
from opendraft.citations.semantic_scholar import SemanticScholarClient

logger = logging.getLogger(__name__)

# Lazy-initialized clients
_crossref: CrossrefClient = None
_semantic_scholar: SemanticScholarClient = None


def _get_crossref() -> CrossrefClient:
    global _crossref
    if _crossref is None:
        _crossref = CrossrefClient()
    return _crossref


def _get_semantic_scholar() -> SemanticScholarClient:
    global _semantic_scholar
    if _semantic_scholar is None:
        _semantic_scholar = SemanticScholarClient()
    return _semantic_scholar


def search_semantic_scholar(query: str, max_results: int = 5) -> List[Dict[str, Any]]:
    """Search Semantic Scholar and return list of paper metadata."""
    max_results = int(max_results)  # Gemini may send float
    client = _get_semantic_scholar()
    try:
        results = client.search_papers(query, max_results=min(max_results, 10))
    except Exception as e:
        logger.error("Semantic Scholar search failed: %s", e)
        return [{"error": f"Search failed: {e}", "query": query}]
    if not results:
        return [{"error": "No results found", "query": query}]
    return results


def search_crossref(query: str, max_results: int = 5) -> List[Dict[str, Any]]:
    """Search Crossref and return list of paper metadata."""
    max_results = int(max_results)  # Gemini may send float
    client = _get_crossref()
    try:
        results = client.search_papers(query, max_results=min(max_results, 10))
    except Exception as e:
        logger.error("Crossref search failed: %s", e)
        return [{"error": f"Search failed: {e}", "query": query}]
    if not results:
        return [{"error": "No results found", "query": query}]
    return results


def cleanup_clients() -> None:
    """Close API client sessions. Call after pipeline completes."""
    global _crossref, _semantic_scholar
    if _crossref is not None:
        _crossref.close()
        _crossref = None
    if _semantic_scholar is not None:
        _semantic_scholar.close()
        _semantic_scholar = None
