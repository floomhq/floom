"""Citation operation implementations for Gemini function calling."""

import logging
import requests
from typing import Dict, List, Any

from opendraft.citations.database import Citation, CitationDatabase

logger = logging.getLogger(__name__)


class CitationOps:
    """Citation operations bound to a specific CitationDatabase instance."""

    def __init__(self, db: CitationDatabase):
        self.db = db

    @staticmethod
    def _safe_int(value, default=None):
        """Safely convert value to int. Gemini may send floats, strings, or garbage."""
        if value is None or value == "":
            return default
        try:
            return int(float(value))
        except (ValueError, TypeError):
            return default

    @staticmethod
    def _ensure_authors_list(value) -> List[str]:
        """Ensure authors is a proper list of strings.

        Gemini sometimes sends authors as a single string instead of a list.
        This causes citations like "(B et al., 2023)" instead of "(Brown et al., 2023)".
        """
        if value is None or value == "":
            return ["Unknown"]
        if isinstance(value, str):
            # Handle comma-separated string: "Brown, Smith, Jones"
            if "," in value:
                return [a.strip() for a in value.split(",") if a.strip()]
            # Single author string: "Brown"
            return [value.strip()] if value.strip() else ["Unknown"]
        if isinstance(value, list):
            # Ensure all items are non-empty strings
            cleaned = [str(a).strip() for a in value if a and str(a).strip()]
            return cleaned if cleaned else ["Unknown"]
        return ["Unknown"]

    def citation_db_add(
        self,
        title: str,
        authors: List[str],
        year: int,
        doi: str = "",
        journal: str = "",
        url: str = "",
        abstract: str = "",
        source_type: str = "journal",
        publisher: str = "",
        volume: str = "",
        issue: str = "",
        pages: str = "",
    ) -> str:
        """Add a citation to the database. Returns the assigned cite_id."""
        year = self._safe_int(year, default=2024)
        cite_id = self.db.next_id()
        citation = Citation(
            citation_id=cite_id,
            authors=self._ensure_authors_list(authors),
            year=year,
            title=title or "Untitled",
            source_type=source_type if source_type in ("journal", "book", "report", "website", "conference") else "journal",
            doi=doi if doi else None,
            journal=journal if journal else None,
            url=url if url else None,
            abstract=abstract if abstract else None,
            publisher=publisher if publisher else None,
            volume=self._safe_int(volume),
            issue=self._safe_int(issue),
            pages=pages if pages else None,
        )
        count_before = len(self.db.citations)
        self.db.add_citation(citation)
        if len(self.db.citations) == count_before:
            # Duplicate was detected and skipped
            dup = self.db._find_duplicate(citation)
            dup_id = dup.id if dup else "unknown"
            logger.info("Duplicate skipped for '%s' (matches %s)", title[:60], dup_id)
            return f"Duplicate skipped: '{title}' already exists as {dup_id}"
        logger.info("Added citation %s: %s", cite_id, title[:60])
        return f"Added citation {cite_id}: {title}"

    def citation_db_get(self, cite_id: str) -> Dict[str, Any]:
        """Get a citation by ID."""
        citation = self.db.get_citation(cite_id)
        if citation:
            return citation.to_dict()
        return {"error": f"Citation {cite_id} not found"}

    def citation_db_query(
        self,
        keyword: str,
        min_year: int = 0,
        max_results: int = 10,
    ) -> List[Dict[str, Any]]:
        """Search existing citations by keyword in title and abstract."""
        min_year = self._safe_int(min_year, default=0)
        max_results = self._safe_int(max_results, default=10)
        keyword_lower = keyword.lower()
        results = []
        for citation in self.db.citations:
            title_match = keyword_lower in citation.title.lower()
            abstract_match = citation.abstract and keyword_lower in citation.abstract.lower()
            year_ok = citation.year >= min_year if min_year > 0 else True
            if (title_match or abstract_match) and year_ok:
                results.append(citation.to_dict())
            if len(results) >= max_results:
                break
        if not results:
            return [{"info": f"No citations matching '{keyword}' found in database"}]
        return results

    def citation_db_list_all(self) -> List[Dict[str, str]]:
        """List all citation IDs and titles."""
        return [{"id": c.id, "title": c.title, "year": c.year} for c in self.db.citations]

    def audit_draft_citations(self, draft_text: str) -> Dict[str, Any]:
        """Audit citations in draft text against the database. Runs server-side."""
        import re
        # Extract all {cite_XXX} from draft
        cited = set(re.findall(r'\{(cite_\d+)\}', draft_text))
        db_ids = {c.id for c in self.db.citations}

        missing_from_db = cited - db_ids
        unused_in_draft = db_ids - cited

        # Citation density per section
        sections = re.split(r'^##\s', draft_text, flags=re.MULTILINE)
        section_stats = []
        for section in sections:
            if not section.strip():
                continue
            title = section.split('\n')[0].strip()
            count = len(re.findall(r'\{cite_\d+\}', section))
            words = len(section.split())
            section_stats.append({
                "section": title[:60],
                "citations": count,
                "words": words,
            })

        # Collect DOIs for verification
        dois = []
        for c in self.db.citations:
            if c.doi:
                dois.append({"cite_id": c.id, "doi": c.doi})

        return {
            "total_citations_in_draft": len(cited),
            "total_in_database": len(db_ids),
            "missing_from_db": list(missing_from_db),
            "unused_in_draft": list(unused_in_draft),
            "section_stats": section_stats,
            "dois_for_verification": dois,
        }

    def verify_doi_batch(self, dois: List[str]) -> List[Dict[str, Any]]:
        """Verify a batch of DOIs against Crossref."""
        results = []
        for doi in dois:
            try:
                resp = requests.get(
                    f"https://api.crossref.org/works/{doi}",
                    timeout=10,
                    headers={"User-Agent": "OpenDraft/2.0 (mailto:contact@opendraft.dev)"},
                )
                if resp.status_code == 200:
                    data = resp.json().get("message", {})
                    results.append({
                        "doi": doi,
                        "valid": True,
                        "title": (data.get("title", [""])[0])[:100],
                    })
                else:
                    results.append({"doi": doi, "valid": False, "status": resp.status_code})
            except Exception as e:
                results.append({"doi": doi, "valid": False, "error": str(e)})
        return results

    def validate_citation_formats(self) -> Dict[str, Any]:
        """Validate citations have proper author format. Returns warnings.

        Checks for:
        - Authors stored as string instead of list (data corruption from Gemini)
        - Single-letter author names (symptom of string indexing bug)
        """
        issues = []
        for citation in self.db.citations:
            if isinstance(citation.authors, str):
                issues.append({
                    "cite_id": citation.id,
                    "issue": "authors_is_string",
                    "value": citation.authors[:50]
                })
            elif citation.authors:
                for i, author in enumerate(citation.authors):
                    if len(author) == 1:
                        issues.append({
                            "cite_id": citation.id,
                            "issue": "single_letter_author",
                            "author_index": i,
                            "value": author
                        })
        return {
            "total_citations": len(self.db.citations),
            "valid": len(self.db.citations) - len(issues),
            "issues": issues[:20],  # Limit to first 20 issues
            "status": "pass" if not issues else "needs_review"
        }
