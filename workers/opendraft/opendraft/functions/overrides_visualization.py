"""Overrides for figure generation and qualitative analysis tools."""

# fmt: off

# =============================================================================
# FIGURE GENERATION
# =============================================================================

SCATTER_PLOT = {
    "description": "Create a scatter plot with optional regression line. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "x_var": "X-axis variable",
        "y_var": "Y-axis variable",
        "hue_var": "Optional color grouping variable",
        "title": "Optional custom title",
        "add_regression": "Add regression line (default true)",
    },
}

BAR_CHART = {
    "description": "Create a bar chart showing means by group with error bars. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "x_var": "Categorical x-axis variable",
        "y_var": "Numeric y-axis variable",
        "title": "Optional custom title",
        "error_bars": "Show error bars (default true)",
    },
}

BOX_PLOT = {
    "description": "Create a box plot showing distribution by groups. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "x_var": "Categorical grouping variable",
        "y_var": "Numeric variable",
        "title": "Optional custom title",
    },
}

HISTOGRAM = {
    "description": "Create a histogram with KDE overlay. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "variable": "Numeric variable to plot",
        "bins": "Number of bins (default 20)",
        "title": "Optional custom title",
    },
}

CORRELATION_HEATMAP = {
    "description": "Create a correlation heatmap for multiple variables. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "variables": "List of numeric variables to correlate",
        "title": "Optional custom title",
        "annotate": "Show correlation values (default true)",
    },
}

LINE_CHART = {
    "description": "Create a line chart for time series or trends. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "x_var": "X-axis variable (often time)",
        "y_var": "Y-axis variable",
        "hue_var": "Optional grouping for multiple lines",
        "title": "Optional custom title",
    },
}

VIOLIN_PLOT = {
    "description": "Create a violin plot showing distribution shape by groups. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "x_var": "Categorical grouping variable",
        "y_var": "Numeric variable",
        "title": "Optional custom title",
    },
}

# =============================================================================
# QUALITATIVE ANALYSIS
# =============================================================================

WORD_FREQUENCY = {
    "description": "Analyze word frequencies in text data. Returns top words with counts and percentages.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "top_n": "Number of top words (default 50)",
        "remove_stopwords": "Remove common English stopwords (default true)",
        "min_word_length": "Minimum word length (default 3)",
    },
}

EXTRACT_QUOTES = {
    "description": "Extract quotes containing a keyword with surrounding context.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "keyword": "Word or phrase to search for",
        "context_words": "Words of context before/after (default 15)",
        "max_quotes": "Maximum quotes to return (default 20)",
        "id_column": "Optional column for source ID",
    },
}

ANALYZE_THEMATIC = {
    "description": "Extract themes from text data using topic modeling (LDA or K-Means).",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "n_themes": "Number of themes to extract (default 5)",
        "method": "'lda' or 'kmeans' (default 'lda')",
        "n_words_per_theme": "Top words per theme (default 10)",
        "id_column": "Optional column for participant ID",
    },
}

SENTIMENT_ANALYSIS = {
    "description": "Analyze sentiment of text data using lexicon-based approach.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "id_column": "Optional column for source ID",
    },
}

CODE_SEGMENTS = {
    "description": "Apply qualitative codes to text segments. Creates a coding matrix.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "codes": "List of code names to apply",
        "id_column": "Optional column for source ID",
    },
}

CONTENT_ANALYSIS = {
    "description": "Systematic content analysis with predefined categories and keywords.",
    "schema_override": {
        "categories": {
            "type": "object",
            "description": "Dict mapping category names to keyword lists, e.g., {'barriers': ['difficult', 'challenge']}",
        },
    },
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "id_column": "Optional column for source ID",
    },
}

GENERATE_WORDCLOUD = {
    "description": "Generate a word cloud visualization from text data. Saved to figures/ directory.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "title": "Optional title for the figure",
        "max_words": "Maximum words to include (default 100)",
        "colormap": "Matplotlib colormap (default 'viridis')",
    },
}

ANALYZE_NGRAMS = {
    "description": "Analyze n-gram (phrase) frequencies in text data.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "n": "N-gram size: 2=bigrams, 3=trigrams (default 2)",
        "top_n": "Number of top n-grams (default 30)",
        "min_freq": "Minimum frequency filter (default 2)",
    },
}

ANALYZE_COOCCURRENCE = {
    "description": "Analyze code co-occurrence - which codes appear together in the same documents.",
    "param_descriptions": {
        "filename": "CSV file in workspace",
        "text_column": "Column containing text data",
        "codes": "List of code names to analyze",
        "min_cooccurrence": "Minimum co-occurrence count (default 1)",
        "id_column": "Optional column for source ID",
    },
}

OVERRIDES = {
    # Figures
    "scatter_plot": SCATTER_PLOT,
    "bar_chart": BAR_CHART,
    "box_plot": BOX_PLOT,
    "histogram": HISTOGRAM,
    "correlation_heatmap": CORRELATION_HEATMAP,
    "line_chart": LINE_CHART,
    "violin_plot": VIOLIN_PLOT,
    # Qualitative
    "word_frequency": WORD_FREQUENCY,
    "extract_quotes": EXTRACT_QUOTES,
    "analyze_thematic": ANALYZE_THEMATIC,
    "sentiment_analysis": SENTIMENT_ANALYSIS,
    "code_segments": CODE_SEGMENTS,
    "content_analysis": CONTENT_ANALYSIS,
    "generate_wordcloud": GENERATE_WORDCLOUD,
    "analyze_ngrams": ANALYZE_NGRAMS,
    "analyze_cooccurrence": ANALYZE_COOCCURRENCE,
}

# fmt: on
