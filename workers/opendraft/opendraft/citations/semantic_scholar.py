"""Semantic Scholar API client: AI-powered search with 200M+ papers."""

import os
import logging
import time
import requests
from typing import Optional, Dict, Any, List

logger = logging.getLogger(__name__)

S2_USER_AGENT = "OpenDraft/2.0 (https://github.com/opendraft; mailto:contact@opendraft.dev)"


class SemanticScholarClient:
    """Semantic Scholar API client for academic paper search."""

    def __init__(self, api_key: Optional[str] = None, timeout: int = 10, max_retries: int = 2):
        self.base_url = "https://api.semanticscholar.org"
        self.timeout = timeout
        self.max_retries = max_retries

        self.api_key = api_key or os.getenv('SEMANTIC_SCHOLAR_API_KEY')
        if self.api_key:
            self.min_interval = 0.1  # 10 req/s with key
        else:
            self.min_interval = 1.0  # 1 req/s without key (conservative but not crawling)
        self.last_request_time = 0.0
        self.session = requests.Session()

    def _rate_limit_wait(self) -> None:
        elapsed = time.time() - self.last_request_time
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self.last_request_time = time.time()

    def _make_request(self, endpoint: str, params: Dict) -> Optional[Dict]:
        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        for attempt in range(self.max_retries):
            try:
                self._rate_limit_wait()
                headers = {"User-Agent": S2_USER_AGENT}
                if self.api_key:
                    headers["x-api-key"] = self.api_key
                response = self.session.get(url, params=params, headers=headers, timeout=self.timeout)
                if response.status_code == 200:
                    return response.json()
                elif response.status_code == 429:
                    wait = 3 * (2 ** attempt)
                    logger.debug("S2 rate limited, waiting %ss", wait)
                    time.sleep(wait)
                    continue
                elif response.status_code >= 500:
                    time.sleep(2 ** attempt)
                    continue
                else:
                    return None
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
                time.sleep(2 ** attempt)
                continue
            except requests.exceptions.RequestException:
                return None
        return None

    def search_paper(self, query: str, max_results: int = 5) -> Optional[Dict[str, Any]]:
        """Search for a paper. Returns first result."""
        response = self._make_request("/graph/v1/paper/search", {
            "query": query,
            "limit": max_results,
            "fields": "title,authors,year,venue,externalIds,url,citationCount,publicationTypes,abstract",
        })
        if not response:
            return None
        try:
            papers = response.get("data", [])
            if not papers:
                return None
            return self._extract_metadata(papers[0])
        except Exception as e:
            logger.error("S2 parse error: %s", e)
            return None

    def search_papers(self, query: str, max_results: int = 5) -> list:
        """Search and return multiple results."""
        response = self._make_request("/graph/v1/paper/search", {
            "query": query,
            "limit": max_results,
            "fields": "title,authors,year,venue,externalIds,url,citationCount,publicationTypes,abstract",
        })
        if not response:
            return []
        papers = response.get("data", [])
        results = []
        for paper in papers:
            meta = self._extract_metadata(paper)
            if meta:
                results.append(meta)
        return results

    def _extract_metadata(self, paper: Dict) -> Optional[Dict[str, Any]]:
        try:
            title = paper.get("title", "")
            if not title:
                return None

            authors_raw = paper.get("authors", [])
            authors = []
            for author in authors_raw:
                if isinstance(author, dict):
                    name = author.get("name", "")
                    if name:
                        name_parts = name.split()
                        last_name = name_parts[-1] if name_parts else name
                        authors.append(last_name)
            if not authors:
                return None

            year = paper.get("year", 0)
            if year == 0:
                return None

            external_ids = paper.get("externalIds", {}) or {}
            doi = external_ids.get("DOI", "")
            arxiv_id = external_ids.get("ArXiv", "")

            url = ""
            if doi:
                url = f"https://doi.org/{doi}"
            elif paper.get("url"):
                url = paper["url"]
            elif arxiv_id:
                url = f"https://arxiv.org/abs/{arxiv_id}"

            journal = paper.get("venue", "")
            abstract = paper.get("abstract", "")
            if abstract:
                abstract = abstract.strip()

            publication_types = paper.get("publicationTypes", []) or []
            source_type = self._map_source_type(publication_types, journal)

            return {
                "title": title,
                "authors": authors,
                "year": year,
                "doi": doi,
                "url": url,
                "journal": journal,
                "publisher": "",
                "volume": "",
                "issue": "",
                "pages": "",
                "source_type": source_type,
                "abstract": abstract if abstract else None,
            }
        except Exception as e:
            logger.error("S2 metadata extraction error: %s", e)
            return None

    def _map_source_type(self, publication_types: List[str], venue: str) -> str:
        if not publication_types:
            if venue:
                venue_lower = venue.lower()
                if any(kw in venue_lower for kw in ["conference", "proceedings", "workshop", "symposium"]):
                    return "conference"
            return "journal"

        types_str = " ".join(publication_types).lower()
        if "journal" in types_str:
            return "journal"
        elif any(kw in types_str for kw in ["conference", "proceedings"]):
            return "conference"
        elif "book" in types_str:
            return "book"
        return "journal"

    def close(self):
        self.session.close()
