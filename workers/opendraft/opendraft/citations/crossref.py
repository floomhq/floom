"""Crossref API client: 50M+ papers with high-quality metadata."""

import re
import logging
import time
import requests
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

CROSSREF_USER_AGENT = "OpenDraft/2.0 (https://github.com/opendraft; mailto:contact@opendraft.dev)"


def validate_author_name(author_name: str) -> tuple:
    """Validate author name is academically acceptable."""
    if not author_name:
        return (False, "empty")
    name = author_name.strip()
    if len(name) <= 2:
        return (False, "too_short")
    domain_tlds = ['.com', '.org', '.net', '.edu', '.gov', '.io', '.ai']
    if '.' in name and any(tld in name.lower() for tld in domain_tlds):
        return (False, "domain_as_author")
    if name.startswith('http://') or name.startswith('https://'):
        return (False, "url_as_author")
    generic_terms = [
        'working paper', 'discussion paper', 'technical report', 'staff report',
        'anonymous', 'unknown', 'author', 'authors', 'editor', 'editors',
        'committee', 'commission', 'group', 'team', 'staff',
    ]
    if any(term in name.lower() for term in generic_terms):
        return (False, "generic_author")
    return (True, "valid")


class CrossrefClient:
    """Crossref API client for academic paper search."""

    def __init__(self, rate_limit_per_second: float = 10.0, timeout: int = 10, max_retries: int = 3):
        self.base_url = "https://api.crossref.org"
        self.timeout = timeout
        self.max_retries = max_retries
        self.min_interval = 1.0 / rate_limit_per_second
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
                headers = {"User-Agent": CROSSREF_USER_AGENT}
                response = self.session.get(url, params=params, headers=headers, timeout=self.timeout)
                if response.status_code == 200:
                    return response.json()
                elif response.status_code == 429:
                    wait = 3 * (2 ** attempt)
                    logger.debug("Rate limited, waiting %ss", wait)
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
        """Search for a paper by title/author/keywords. Returns first result."""
        response = self._make_request("/works", {
            "query": query,
            "rows": max_results,
            "sort": "relevance",
            "select": "DOI,title,author,published,container-title,publisher,volume,issue,page,type,abstract",
        })
        if not response:
            return None
        try:
            items = response.get("message", {}).get("items", [])
            if not items:
                return None
            return self._extract_metadata(items[0])
        except Exception as e:
            logger.error("Crossref parse error: %s", e)
            return None

    def search_papers(self, query: str, max_results: int = 5) -> list:
        """Search and return multiple results."""
        response = self._make_request("/works", {
            "query": query,
            "rows": max_results,
            "sort": "relevance",
            "select": "DOI,title,author,published,container-title,publisher,volume,issue,page,type,abstract",
        })
        if not response:
            return []
        items = response.get("message", {}).get("items", [])
        results = []
        for item in items:
            meta = self._extract_metadata(item)
            if meta:
                results.append(meta)
        return results

    def _extract_metadata(self, paper: Dict) -> Optional[Dict[str, Any]]:
        try:
            title = paper.get("title", [])
            if not title or not isinstance(title, list):
                return None
            title_str = title[0] if title else ""
            if not title_str:
                return None

            authors_raw = paper.get("author", [])
            authors = []
            for author in authors_raw:
                if isinstance(author, dict):
                    family = author.get("family", "")
                    if family:
                        is_valid, _ = validate_author_name(family)
                        if is_valid:
                            authors.append(family)
            if not authors:
                return None

            published = paper.get("published", {})
            date_parts = published.get("date-parts", [[]])
            year = 0
            if date_parts and date_parts[0]:
                year = date_parts[0][0] if date_parts[0] else 0
            if year == 0:
                published_online = paper.get("published-online", {})
                date_parts = published_online.get("date-parts", [[]])
                if date_parts and date_parts[0]:
                    year = date_parts[0][0] if date_parts[0] else 0
            if year == 0:
                return None

            doi = paper.get("DOI", "")
            url = f"https://doi.org/{doi}" if doi else ""
            container_title = paper.get("container-title", [])
            journal = container_title[0] if container_title else ""
            publisher = paper.get("publisher", "")
            volume = paper.get("volume", "")
            issue = paper.get("issue", "")
            page = paper.get("page", "")
            abstract = paper.get("abstract", "")
            if abstract:
                abstract = re.sub(r'<[^>]+>', '', abstract).strip()

            type_mapping = {
                "journal-article": "journal",
                "proceedings-article": "conference",
                "book": "book",
                "book-chapter": "book",
                "report": "report",
                "posted-content": "report",
                "dataset": "report",
            }
            source_type = type_mapping.get(paper.get("type", ""), "journal")

            return {
                "title": title_str,
                "authors": authors,
                "year": year,
                "doi": doi,
                "url": url,
                "journal": journal,
                "publisher": publisher,
                "volume": volume,
                "issue": issue,
                "pages": page,
                "source_type": source_type,
                "abstract": abstract if abstract else None,
            }
        except Exception as e:
            logger.error("Crossref metadata extraction error: %s", e)
            return None

    def close(self):
        self.session.close()
