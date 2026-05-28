"""Citation compiler: replace {cite_XXX} with formatted citations, generate reference lists."""

import re
import logging
from typing import Any, Dict, List, Tuple, Set

from opendraft.citations.database import Citation, CitationDatabase

logger = logging.getLogger(__name__)


class CitationCompiler:
    """Deterministic citation compiler for {cite_XXX} replacement."""

    def __init__(self, database: CitationDatabase):
        self.database = database
        self.citation_lookup = {c.id: c for c in database.citations}
        self.style = database.citation_style

    def compile_citations(self, text: str) -> Tuple[str, List[str]]:
        """
        Replace {cite_XXX} patterns with formatted in-text citations.

        Returns:
            (formatted_text, list_of_missing_ids)
        """
        missing_ids: List[str] = []

        def replace_citation(match: re.Match) -> str:
            cite_id = match.group(0).strip('{}')
            if cite_id not in self.citation_lookup:
                missing_ids.append(cite_id)
                return f"[MISSING: {cite_id}]"
            return self.format_in_text_citation(self.citation_lookup[cite_id])

        pattern = r'\{cite_\d+\}'
        formatted_text = re.sub(pattern, replace_citation, text)
        return formatted_text, missing_ids

    def format_in_text_citation(self, citation: Citation) -> str:
        if self.style == "IEEE":
            return self._format_ieee_in_text(citation)
        return self._format_apa_in_text(citation)

    def _format_apa_in_text(self, citation: Citation) -> str:
        authors = citation.authors
        year = citation.year
        if len(authors) == 1:
            return f"({authors[0]}, {year})"
        elif len(authors) == 2:
            return f"({authors[0]} & {authors[1]}, {year})"
        else:
            return f"({authors[0]} et al., {year})"

    def _format_ieee_in_text(self, citation: Citation) -> str:
        number = citation.id.replace("cite_", "")
        return f"[{int(number)}]"

    def generate_reference_list(self, text: str) -> str:
        """Generate formatted reference list from citations used in text."""
        cited_ids = self._extract_cited_ids(text)
        cited_citations = [
            self.citation_lookup[cid]
            for cid in sorted(cited_ids)
            if cid in self.citation_lookup
        ]

        if not cited_citations:
            return "\n\n## References\n\n(No citations found)\n"

        if self.style == "APA 7th":
            cited_citations.sort(key=lambda c: c.authors[0].lower())

        references = []
        for citation in cited_citations:
            if self.style == "IEEE":
                ref = self._format_ieee_reference(citation)
            else:
                ref = self._format_apa_reference(citation)
            references.append(ref)

        references_content = "\n\n".join(references)
        return f"\n\n## References\n\n{references_content}"

    def generate_bibliography(self) -> str:
        """Generate complete bibliography from all citations in database."""
        if not self.database.citations:
            return "\n\n## References\n\n(No citations in database)\n"

        citations = list(self.database.citations)
        if self.style == "APA 7th":
            citations.sort(key=lambda c: c.authors[0].lower() if c.authors else "")

        references = []
        for citation in citations:
            if self.style == "IEEE":
                ref = self._format_ieee_reference(citation)
            else:
                ref = self._format_apa_reference(citation)
            references.append(ref)

        return "\n\n## References\n\n" + "\n\n".join(references)

    def _extract_cited_ids(self, text: str) -> Set[str]:
        pattern = r'\{cite_\d+\}'
        matches = re.findall(pattern, text)
        return {match.strip('{}') for match in matches}

    def _format_apa_reference(self, citation: Citation) -> str:
        authors = citation.authors
        year = citation.year
        title = citation.title

        MAX_AUTHORS = 7
        if len(authors) == 1:
            author_str = f"{authors[0]}."
        elif len(authors) == 2:
            author_str = f"{authors[0]}, & {authors[1]}."
        elif len(authors) <= MAX_AUTHORS:
            author_str = ", ".join(authors[:-1]) + f", & {authors[-1]}."
        else:
            author_str = ", ".join(authors[:6]) + f", ... & {authors[-1]}."

        source_type = citation.source_type

        if source_type == 'journal':
            journal = citation.journal or ""
            volume = citation.volume
            issue = citation.issue
            pages = citation.pages or ""
            doi = citation.doi or ""
            url = citation.url or ""

            ref = f"{author_str} ({year}). {title}. *{journal}*"
            if volume:
                ref += f", *{volume}*"
            if issue:
                ref += f"({issue})"
            if pages:
                ref += f", {pages}"
            if doi:
                ref += f". https://doi.org/{doi}"
            elif url:
                ref += f". {url}"
            ref += "."

        elif source_type == 'book':
            publisher = citation.publisher or ""
            doi = citation.doi or ""
            url = citation.url or ""
            if publisher:
                ref = f"{author_str} ({year}). *{title}*. {publisher}."
            else:
                ref = f"{author_str} ({year}). *{title}*."
            if doi:
                ref += f" https://doi.org/{doi}"
            elif url:
                ref += f" {url}"

        elif source_type in ['report', 'website']:
            url = citation.url or ""
            doi = citation.doi or ""
            publisher = citation.publisher or ""
            ref = f"{author_str} ({year}). *{title}*"
            if publisher:
                ref += f". {publisher}"
            ref += "."
            if doi:
                ref += f" https://doi.org/{doi}"
            elif url:
                ref += f" {url}"

        elif source_type == 'conference':
            publisher = citation.publisher or ""
            pages = citation.pages or ""
            doi = citation.doi or ""
            url = citation.url or ""
            ref = f"{author_str} ({year}). {title}."
            if publisher:
                ref += f" {publisher}."
            if pages:
                ref += f" (pp. {pages})."
            if doi:
                ref += f" https://doi.org/{doi}"
            elif url:
                ref += f" {url}"

        else:
            doi = citation.doi or ""
            url = citation.url or ""
            ref = f"{author_str} ({year}). {title}."
            if doi:
                ref += f" https://doi.org/{doi}"
            elif url:
                ref += f" {url}"

        return ref

    def _format_ieee_reference(self, citation: Citation) -> str:
        authors = citation.authors
        year = citation.year
        title = citation.title

        if len(authors) <= 3:
            author_str = ", ".join([f"{a}." for a in authors])
        else:
            author_str = f"{authors[0]}. et al."

        source_type = citation.source_type

        if source_type == 'journal':
            journal = citation.journal or ""
            volume = citation.volume or ""
            pages = citation.pages or ""
            ref = f"[{citation.id.replace('cite_', '')}] {author_str}, \"{title},\" *{journal}*"
            if volume:
                ref += f", vol. {volume}"
            if pages:
                ref += f", pp. {pages}"
            ref += f", {year}."
        else:
            ref = f"[{citation.id.replace('cite_', '')}] {author_str}, \"{title},\" {year}."

        return ref

    def validate_compilation(self, original: str, compiled: str) -> Dict[str, Any]:
        issues = []
        remaining_ids = re.findall(r'\{cite_\d+\}', compiled)
        if remaining_ids:
            issues.append(f"Found {len(remaining_ids)} un-replaced citation IDs")
        missing_markers = re.findall(r'\[MISSING: cite_\d+\]', compiled)
        if missing_markers:
            issues.append(f"Found {len(missing_markers)} missing citations")
        original_ids = set(re.findall(r'cite_\d+', original))
        return {
            'success': len(issues) == 0,
            'issues': issues,
            'total_citations': len(original_ids),
            'missing_citations': len(missing_markers),
        }
