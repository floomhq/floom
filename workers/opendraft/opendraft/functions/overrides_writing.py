"""Overrides for formatting, compilation, scoring, and code execution tools."""

# fmt: off

WORD_COUNT = {
    "description": "Count words in the given text.",
    "param_descriptions": {"text": "Text to count words in"},
}

WORD_COUNT_FILE = {
    "description": (
        "Count words in a workspace file. Use this instead of reading the file and "
        "passing content to word_count."
    ),
    "param_descriptions": {"filename": "Workspace filename to count words in"},
}

COMPILE_CITATIONS = {
    "description": "Replace all {cite_XXX} placeholders in the text with formatted citations.",
    "param_descriptions": {"draft_text": "Draft text with {cite_XXX} placeholders"},
}

GENERATE_BIBLIOGRAPHY = {
    "description": "Generate a complete formatted reference list from all citations in the database.",
}

FINALIZE_DRAFT = {
    "description": (
        "Read draft from workspace, compile all {cite_XXX} placeholders into formatted "
        "citations, append bibliography, and write final draft. Handles full text server-side."
    ),
    "param_descriptions": {
        "input_filename": "Source draft filename (default: draft.md)",
        "output_filename": "Output filename (default: final_draft.md)",
    },
}

COMPILE_DRAFT = {
    "description": (
        "Read all section_*.md files from workspace (in order), "
        "combine them into a single draft file, and return total word count. "
        "Call this after writing all sections individually."
    ),
    "param_descriptions": {
        "output_filename": "Output filename (default: draft.md)",
    },
}

CLEAN_DRAFT = {
    "description": (
        "Apply deterministic prose cleanup to a draft file server-side. Strips filler "
        "transitions, empty intensifiers, verbose phrases, meta-commentary, "
        "synonym chains, and duplicate References headings. Returns word count before/after."
    ),
    "param_descriptions": {
        "input_filename": "Source draft filename (default: draft.md)",
        "output_filename": "Output filename (default: draft_clean.md)",
    },
}

DETECT_REPETITION = {
    "description": (
        "Detect thesis restatement and repeated phrases in the draft. Checks for "
        "excessive thesis restatements and repeated 5+ word sequences. Returns warnings only."
    ),
    "param_descriptions": {"filename": "Draft filename to analyze (default: draft.md)"},
}

DETECT_ADVOCACY_LANGUAGE = {
    "description": (
        "Detect prescriptive or advocacy language inappropriate for academic tone. "
        "Checks for phrases like 'must be adopted', 'we advocate', 'undeniably'. Returns warnings only."
    ),
    "param_descriptions": {"filename": "Draft filename to analyze (default: draft.md)"},
}

SCORE_QUALITY = {
    "description": (
        "Score a draft's quality without modifying it. Returns comprehensive metrics: "
        "overall score (0-100), TTR, sentence variety, citation density, and more."
    ),
    "param_descriptions": {"filename": "Draft filename to score (default: draft.md)"},
}

LLM_REFINE = {
    "description": (
        "Apply LLM-based refinement to improve draft quality. ONLY call this if the quality "
        "gate FAILED (score < 85%) after clean_draft(). Processes server-side in sections."
    ),
    "param_descriptions": {
        "input_filename": "Source draft filename (default: draft_clean.md)",
        "output_filename": "Output filename (default: draft_refined.md)",
    },
}

FORMAT_RESULTS = {
    "description": (
        "Format research results as APA table and prose paragraph. "
        "Converts natural language descriptions of statistical results "
        "into properly formatted APA tables and prose."
    ),
    "param_descriptions": {
        "description": "Natural language description of statistical results",
        "result_type": "Type of statistical result (auto-detected if not provided)",
    },
    "param_enums": {
        "result_type": ["regression", "ttest", "anova", "correlation", "descriptive"],
    },
}

RUN_CODE = {
    "description": (
        "Execute Python code in a local sandbox. Available modules: math, json, re, "
        "collections, itertools, datetime, statistics. Returns stdout output and any errors."
    ),
    "param_descriptions": {"code": "Python code to execute. Use print() for output."},
}

OVERRIDES = {
    "word_count": WORD_COUNT,
    "word_count_file": WORD_COUNT_FILE,
    "compile_citations": COMPILE_CITATIONS,
    "generate_bibliography": GENERATE_BIBLIOGRAPHY,
    "finalize_draft": FINALIZE_DRAFT,
    "compile_draft": COMPILE_DRAFT,
    "clean_draft": CLEAN_DRAFT,
    "detect_repetition": DETECT_REPETITION,
    "detect_advocacy_language": DETECT_ADVOCACY_LANGUAGE,
    "score_quality": SCORE_QUALITY,
    "llm_refine": LLM_REFINE,
    "format_results": FORMAT_RESULTS,
    "run_code": RUN_CODE,
}

# fmt: on
