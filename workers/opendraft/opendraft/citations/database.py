"""Citation database: structured citation management with schema validation."""

import json
import logging
from pathlib import Path
from typing import Dict, List, Optional, Literal
from datetime import datetime

logger = logging.getLogger(__name__)

# Words that should stay lowercase in title case (except at start)
LOWERCASE_WORDS = {
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on',
    'or', 'so', 'the', 'to', 'up', 'yet', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'with', 'from',
    'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
    'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where',
    'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
    'no', 'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'also'
}

COMMON_ACRONYMS = {
    'AI', 'ML', 'NLP', 'API', 'CPU', 'GPU', 'IoT', 'USA', 'UK', 'EU', 'UN',
    'WHO', 'GDP', 'CEO', 'CTO', 'CFO', 'HR', 'IT', 'R&D', 'B2B', 'B2C', 'SaaS',
    'DNA', 'RNA', 'HIV', 'AIDS', 'COVID', 'MRI', 'CT', 'ICU', 'FDA', 'NIH',
    'NASA', 'ESA', 'CERN', 'MIT', 'UCLA', 'IEEE', 'ACM', 'AAAI', 'NIST',
    'ISO', 'GDPR', 'HIPAA', 'SOC', 'PCI', 'DSS', 'VPN', 'SSL', 'TLS', 'HTTP',
    'HTTPS', 'SQL', 'NoSQL', 'REST', 'SOAP', 'JSON', 'XML', 'HTML', 'CSS', 'JS',
    'PHP', 'AWS', 'GCP', 'ROI', 'KPI', 'CRM', 'ERP', 'SME', 'SMB', 'IPO', 'VC',
    'PE', 'M&A', 'P&L', 'EBITDA', 'CAGR', 'YoY', 'QoQ', 'MoM', 'LTV', 'CAC',
    'NPS', 'ARPU', 'DAU', 'MAU', 'WAU', 'UX', 'UI', 'PM', 'MVP', 'POC', 'UAT'
}


def normalize_title(title: str) -> str:
    """Normalize ALL CAPS titles to proper title case, preserving acronyms."""
    if not title:
        return title

    letters = [c for c in title if c.isalpha()]
    if not letters:
        return title

    uppercase_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    if uppercase_ratio < 0.7:
        return title

    words = title.split()
    normalized_words = []
    after_colon = False

    for i, word in enumerate(words):
        clean_word = word.strip('.,;:!?()[]{}"\'-\u2013\u2014')
        upper_clean = clean_word.upper()
        is_start_of_segment = (i == 0) or after_colon

        base_word = clean_word.split('-')[0].upper() if '-' in clean_word else upper_clean
        if upper_clean in COMMON_ACRONYMS or base_word in COMMON_ACRONYMS:
            if '-' in clean_word:
                parts = clean_word.split('-')
                normalized_parts = []
                for part in parts:
                    if part.upper() in COMMON_ACRONYMS or part.isdigit():
                        normalized_parts.append(part.upper())
                    else:
                        normalized_parts.append(part.capitalize())
                normalized = word.replace(clean_word, '-'.join(normalized_parts))
            else:
                normalized = word.replace(clean_word, upper_clean)
        elif not is_start_of_segment and clean_word.lower() in LOWERCASE_WORDS:
            normalized = word.lower()
        else:
            if clean_word:
                title_cased = clean_word[0].upper() + clean_word[1:].lower()
                normalized = word.replace(clean_word, title_cased)
            else:
                normalized = word

        normalized_words.append(normalized)
        after_colon = word.endswith(':')

    result = ' '.join(normalized_words)
    if result and result[0].islower():
        result = result[0].upper() + result[1:]
    return result


CitationSourceType = Literal["journal", "book", "report", "website", "conference"]
CitationStyle = Literal["APA 7th", "IEEE", "Chicago", "MLA"]
Language = Literal["english", "german", "spanish", "french"]


class Citation:
    """Structured citation with complete metadata."""

    def __init__(
        self,
        citation_id: str,
        authors: List[str],
        year: int,
        title: str,
        source_type: CitationSourceType,
        language: Language = "english",
        journal: Optional[str] = None,
        publisher: Optional[str] = None,
        volume: Optional[int] = None,
        issue: Optional[int] = None,
        pages: Optional[str] = None,
        doi: Optional[str] = None,
        url: Optional[str] = None,
        access_date: Optional[str] = None,
        api_source: Optional[str] = None,
        abstract: Optional[str] = None,
    ):
        self.id = citation_id
        self.authors = authors
        self.year = year
        self.title = normalize_title(title)
        self.source_type = source_type
        self.language = language
        self.journal = journal
        self.publisher = publisher
        self.volume = volume
        self.issue = issue
        self.pages = pages
        self.doi = doi
        self.url = url
        self.access_date = access_date
        self.api_source = api_source
        self.abstract = abstract

    def to_dict(self) -> Dict:
        data = {
            "id": self.id,
            "authors": self.authors,
            "year": self.year,
            "title": self.title,
            "source_type": self.source_type,
            "language": self.language,
        }
        for field in ['journal', 'publisher', 'volume', 'issue', 'pages',
                       'doi', 'url', 'access_date', 'api_source', 'abstract']:
            val = getattr(self, field)
            if val is not None:
                data[field] = val
        return data

    @staticmethod
    def from_dict(data: Dict) -> 'Citation':
        return Citation(
            citation_id=data["id"],
            authors=data["authors"],
            year=data["year"],
            title=data["title"],
            source_type=data["source_type"],
            language=data.get("language", "english"),
            journal=data.get("journal"),
            publisher=data.get("publisher"),
            volume=data.get("volume"),
            issue=data.get("issue"),
            pages=data.get("pages"),
            doi=data.get("doi"),
            url=data.get("url"),
            access_date=data.get("access_date"),
            abstract=data.get("abstract"),
            api_source=data.get("api_source"),
        )


class CitationDatabase:
    """Citation database with validation and metadata."""

    def __init__(
        self,
        citations: Optional[List[Citation]] = None,
        citation_style: CitationStyle = "APA 7th",
        draft_language: Language = "english",
        extracted_date: Optional[str] = None,
    ):
        self.citations = citations or []
        self.citation_style = citation_style
        self.draft_language = draft_language
        self.extracted_date = extracted_date or datetime.now().isoformat()

    def add_citation(self, citation: Citation) -> None:
        """Add citation, skipping if a duplicate DOI or near-identical title exists."""
        duplicate = self._find_duplicate(citation)
        if duplicate:
            logger.info(
                "Skipping duplicate citation '%s' (matches existing %s)",
                citation.title[:50], duplicate.id
            )
            return
        self.citations.append(citation)

    def _find_duplicate(self, citation: Citation) -> Optional[Citation]:
        """Check if a citation already exists by DOI or title similarity."""
        # Exact DOI match
        if citation.doi:
            doi_clean = citation.doi.strip().lower()
            for existing in self.citations:
                if existing.doi and existing.doi.strip().lower() == doi_clean:
                    return existing

        # Title similarity (normalized comparison)
        new_title = self._normalize_for_dedup(citation.title)
        if not new_title:
            return None
        for existing in self.citations:
            existing_title = self._normalize_for_dedup(existing.title)
            if not existing_title:
                continue
            # Exact title match after normalization
            if new_title == existing_title:
                return existing
            # High overlap: check if one title contains the other (handles subtitle variations)
            if len(new_title) > 20 and len(existing_title) > 20:
                if new_title in existing_title or existing_title in new_title:
                    return existing
        return None

    @staticmethod
    def _normalize_for_dedup(title: str) -> str:
        """Normalize title for dedup comparison: lowercase, strip punctuation, collapse whitespace."""
        import re
        if not title:
            return ""
        t = title.lower()
        t = re.sub(r'[^\w\s]', '', t)
        t = re.sub(r'\s+', ' ', t).strip()
        return t

    def get_citation(self, citation_id: str) -> Optional[Citation]:
        for citation in self.citations:
            if citation.id == citation_id:
                return citation
        return None

    def next_id(self) -> str:
        """Generate next citation ID (cite_001, cite_002, ...)."""
        if not self.citations:
            return "cite_001"
        max_num = 0
        for c in self.citations:
            if c.id and c.id.startswith("cite_"):
                try:
                    num = int(c.id.replace("cite_", ""))
                    max_num = max(max_num, num)
                except ValueError:
                    continue
        return f"cite_{max_num + 1:03d}"

    def to_dict(self) -> Dict:
        return {
            "citations": [c.to_dict() for c in self.citations],
            "metadata": {
                "total_citations": len(self.citations),
                "citation_style": self.citation_style,
                "draft_language": self.draft_language,
                "extracted_date": self.extracted_date,
            }
        }

    @staticmethod
    def from_dict(data: Dict) -> 'CitationDatabase':
        citations = [Citation.from_dict(c) for c in data["citations"]]
        metadata = data.get("metadata", {})
        return CitationDatabase(
            citations=citations,
            citation_style=metadata.get("citation_style", "APA 7th"),
            draft_language=metadata.get("draft_language", "english"),
            extracted_date=metadata.get("extracted_date"),
        )

    def validate(self) -> bool:
        if not self.citations:
            return True  # Empty is valid for v2 (agents build it up)

        seen_ids = set()
        current_year = datetime.now().year
        max_year = current_year + 2

        for citation in self.citations:
            if not citation.id or not citation.id.startswith("cite_"):
                raise ValueError(f"Invalid citation ID: {citation.id}")
            if citation.id in seen_ids:
                raise ValueError(f"Duplicate citation ID: {citation.id}")
            seen_ids.add(citation.id)

            if not citation.authors:
                raise ValueError(f"Citation {citation.id} has no authors")
            # Validate author format (should be list of strings, not a string)
            if isinstance(citation.authors, str):
                raise ValueError(f"Citation {citation.id} has authors as string, expected list")
            for i, author in enumerate(citation.authors):
                if not isinstance(author, str):
                    raise ValueError(f"Citation {citation.id} has invalid author at index {i}: '{author}'")
                if len(author) < 2:
                    logger.warning("Citation %s has short author name at index %s: '%s'", citation.id, i, author)
            if not citation.year:
                raise ValueError(f"Citation {citation.id} missing year")
            if not citation.title:
                raise ValueError(f"Citation {citation.id} missing title")

            if citation.year > max_year:
                logger.warning("Citation %s has future year %s, clamping to %s", citation.id, citation.year, current_year)
                citation.year = current_year
            elif citation.year < 1900:
                logger.warning("Citation %s has invalid year %s, clamping to 1900", citation.id, citation.year)
                citation.year = 1900

        return True


def load_citation_database(path: Path) -> CitationDatabase:
    if not path.exists():
        raise FileNotFoundError(f"Citation database not found: {path}")
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        logger.error("Corrupt citation database at %s: %s", path, e)
        raise ValueError(f"Citation database is corrupt: {e}") from e
    return CitationDatabase.from_dict(data)


def save_citation_database(db: CitationDatabase, path: Path) -> None:
    db.validate()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(db.to_dict(), f, indent=2, ensure_ascii=False)


def has_more_metadata(citation_a: Citation, citation_b: Citation) -> bool:
    optional_fields = ['journal', 'publisher', 'volume', 'issue', 'pages', 'doi', 'url', 'access_date', 'abstract']
    score_a = sum(1 for field in optional_fields if getattr(citation_a, field) is not None)
    score_b = sum(1 for field in optional_fields if getattr(citation_b, field) is not None)
    return score_a > score_b


# --- Checkpoint serialization helpers ---

def save_citation_database_to_dict(db: CitationDatabase) -> Dict:
    """Serialize citation database to dict for checkpointing.

    Args:
        db: CitationDatabase instance

    Returns:
        JSON-serializable dict
    """
    return db.to_dict()


def load_citation_database_from_dict(data: Dict) -> CitationDatabase:
    """Deserialize citation database from checkpoint dict.

    Args:
        data: Serialized database dict

    Returns:
        CitationDatabase instance
    """
    return CitationDatabase.from_dict(data)
