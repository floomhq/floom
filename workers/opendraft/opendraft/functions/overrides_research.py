"""Overrides for research, citation, and workspace tools."""

# fmt: off

SEARCH_SEMANTIC_SCHOLAR = {
    "description": "Search Semantic Scholar for academic papers. Returns papers with title, authors, year, DOI, abstract.",
    "param_descriptions": {
        "query": "Search query (title, authors, keywords)",
        "max_results": "Maximum number of results to return (1-10)",
    },
}

SEARCH_CROSSREF = {
    "description": "Search Crossref for academic papers. Returns papers with title, authors, year, DOI, journal, publisher.",
    "param_descriptions": {
        "query": "Search query (title, authors, keywords)",
        "max_results": "Maximum number of results to return (1-10)",
    },
}

CITATION_DB_ADD = {
    "description": "Add a paper to the citation database. Returns the assigned citation ID (e.g., cite_001).",
    "param_descriptions": {
        "title": "Paper title",
        "authors": "List of author last names",
        "year": "Publication year",
        "doi": "DOI (optional)",
        "journal": "Journal or venue name (optional)",
        "url": "URL (optional)",
        "abstract": "Paper abstract (optional)",
        "source_type": "One of: journal, book, report, website, conference",
        "publisher": "Publisher (optional)",
        "volume": "Volume number (optional)",
        "issue": "Issue number (optional)",
        "pages": "Page range, e.g. '1-15' (optional)",
    },
}

CITATION_DB_GET = {
    "description": "Get a citation from the database by its ID.",
    "param_descriptions": {
        "cite_id": "Citation ID (e.g., cite_001)",
    },
}

CITATION_DB_QUERY = {
    "description": "Search existing citations in the database by keyword.",
    "param_descriptions": {
        "keyword": "Keyword to search in titles and abstracts",
        "min_year": "Minimum publication year (optional)",
        "max_results": "Maximum results to return",
    },
}

CITATION_DB_LIST_ALL = {
    "description": "List all citation IDs in the database with their titles.",
}

AUDIT_DRAFT_CITATIONS = {
    "description": (
        "Audit all {cite_XXX} references in the draft against the citation database. "
        "Reads the draft server-side and returns: total citations, missing from DB, "
        "unused in draft, and per-section citation density. Use this instead of manually "
        "reading the draft and running regex."
    ),
    "param_descriptions": {
        "draft_text": "Draft text to audit (or reads draft.md from workspace if empty)",
    },
}

VERIFY_DOI_BATCH = {
    "description": "Verify a batch of DOIs against Crossref. Returns verification status for each DOI.",
    "param_descriptions": {
        "dois": "List of DOIs to verify",
    },
}

VALIDATE_CITATION_FORMATS = {
    "description": (
        "Validate citations have proper author format. Checks for data corruption where "
        "authors are stored as strings instead of lists, or where author names are "
        "single letters. Returns warnings only."
    ),
}

WRITE_FILE = {
    "description": "Write content to a file in the workspace.",
    "param_descriptions": {
        "filename": "Filename (e.g., outline.md, section_1.md)",
        "content": "File content to write",
    },
}

READ_FILE = {
    "description": "Read a file from the workspace.",
    "param_descriptions": {
        "filename": "Filename to read",
    },
}

LIST_FILES = {
    "description": "List all files in the workspace.",
}

OVERRIDES = {
    "search_semantic_scholar": SEARCH_SEMANTIC_SCHOLAR,
    "search_crossref": SEARCH_CROSSREF,
    "citation_db_add": CITATION_DB_ADD,
    "citation_db_get": CITATION_DB_GET,
    "citation_db_query": CITATION_DB_QUERY,
    "citation_db_list_all": CITATION_DB_LIST_ALL,
    "audit_draft_citations": AUDIT_DRAFT_CITATIONS,
    "verify_doi_batch": VERIFY_DOI_BATCH,
    "validate_citation_formats": VALIDATE_CITATION_FORMATS,
    "write_file": WRITE_FILE,
    "read_file": READ_FILE,
    "list_files": LIST_FILES,
}

# fmt: on
