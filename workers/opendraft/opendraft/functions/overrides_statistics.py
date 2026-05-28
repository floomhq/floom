"""Overrides for structured ingestion, statistical analysis, and data providers."""

# fmt: off

# =============================================================================
# STRUCTURED INGESTION (Phase 1)
# =============================================================================

INGEST_REGRESSION = {
    "description": (
        "Ingest structured regression analysis results. Provide coefficients, standard errors, "
        "p-values, R-squared, etc. Returns a result ID for later formatting."
    ),
    "schema_override": {
        "type": {
            "type": "string",
            "enum": ["ols", "logistic", "hierarchical"],
            "description": "Type of regression",
        },
        "predictors": {
            "type": "array",
            "description": "List of predictors with their statistics",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "coef": {"type": "number", "description": "Coefficient (B)"},
                    "se": {"type": "number", "description": "Standard error"},
                    "beta": {"type": "number", "description": "Standardized coefficient"},
                    "t": {"type": "number", "description": "t-statistic"},
                    "p": {"type": "number", "description": "p-value"},
                    "ci_lower": {"type": "number", "description": "Lower 95% CI"},
                    "ci_upper": {"type": "number", "description": "Upper 95% CI"},
                },
                "required": ["name", "coef"],
            },
        },
    },
    "param_descriptions": {
        "dependent_var": "Name of the dependent variable",
        "r_squared": "R-squared value",
        "adj_r_squared": "Adjusted R-squared",
        "f_stat": "F-statistic",
        "f_p": "p-value for F-statistic",
        "n": "Sample size",
        "model_note": "Additional note for table",
    },
}

INGEST_TTEST = {
    "description": "Ingest t-test results for APA formatting.",
    "schema_override": {
        "type": {
            "type": "string",
            "enum": ["independent", "paired", "one_sample"],
            "description": "Type of t-test",
        },
    },
    "param_descriptions": {
        "group1": "First group/condition name",
        "group2": "Second group/condition name",
        "mean1": "Mean of first group",
        "mean2": "Mean of second group",
        "sd1": "SD of first group",
        "sd2": "SD of second group",
        "t": "t-statistic",
        "df": "Degrees of freedom",
        "p": "p-value",
        "cohens_d": "Cohen's d effect size",
        "ci_lower": "Lower 95% CI of difference",
        "ci_upper": "Upper 95% CI of difference",
        "test_value": "Test value (for one-sample)",
    },
}

INGEST_CORRELATION = {
    "description": "Ingest correlation matrix for APA formatting.",
    "schema_override": {
        "matrix": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "number"}},
            "description": "Correlation matrix (list of lists)",
        },
        "p_values": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "number"}},
            "description": "Matrix of p-values",
        },
        "method": {
            "type": "string",
            "enum": ["pearson", "spearman"],
            "description": "Correlation method",
        },
    },
    "param_descriptions": {
        "variables": "List of variable names",
        "n": "Sample size",
    },
}

INGEST_DESCRIPTIVES = {
    "description": "Ingest descriptive statistics for APA formatting.",
    "schema_override": {
        "variables": {
            "type": "array",
            "description": "List of variables with their statistics",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "mean": {"type": "number"},
                    "sd": {"type": "number"},
                    "min": {"type": "number"},
                    "max": {"type": "number"},
                    "median": {"type": "number"},
                    "n": {"type": "integer"},
                    "skewness": {"type": "number"},
                    "kurtosis": {"type": "number"},
                },
                "required": ["name", "mean", "sd"],
            },
        },
    },
    "param_descriptions": {
        "by_group": "Grouping variable name",
    },
}

INGEST_THEMES = {
    "description": (
        "Ingest thematic analysis results. Provide themes with descriptions, "
        "frequencies, and example quotes for qualitative results section."
    ),
    "schema_override": {
        "method": {
            "type": "string",
            "enum": ["thematic", "content", "grounded"],
            "description": "Analysis method",
        },
        "themes": {
            "type": "array",
            "description": "List of themes",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Theme name"},
                    "description": {"type": "string", "description": "Theme description"},
                    "frequency": {"type": "integer", "description": "Number of participants"},
                    "quotes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Example quotes",
                    },
                },
                "required": ["name"],
            },
        },
    },
    "param_descriptions": {
        "total_participants": "Total N",
    },
}

INGEST_ANOVA = {
    "description": (
        "Ingest one-way ANOVA results for APA formatting. "
        "Stores group means, F-statistic, and optional post-hoc comparisons."
    ),
    "schema_override": {
        "groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "mean": {"type": "number"},
                    "sd": {"type": "number"},
                    "n": {"type": "integer"},
                },
                "required": ["name", "mean", "sd", "n"],
            },
            "description": "Group statistics",
        },
        "post_hoc": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "group1": {"type": "string"},
                    "group2": {"type": "string"},
                    "diff": {"type": "number"},
                    "p": {"type": "number"},
                },
            },
            "description": "Post-hoc pairwise comparisons",
        },
    },
    "param_descriptions": {
        "dependent_var": "Dependent variable name",
        "group_var": "Grouping variable name",
        "f_stat": "F-statistic",
        "df_between": "Degrees of freedom between groups",
        "df_within": "Degrees of freedom within groups",
        "p": "p-value",
        "eta_squared": "Effect size (eta-squared)",
    },
}

INGEST_CHISQUARE = {
    "description": (
        "Ingest chi-square test of independence results for APA formatting. "
        "Stores contingency table and Cramer's V effect size."
    ),
    "schema_override": {
        "contingency_table": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "integer"}},
            "description": "2D contingency table (rows x columns)",
        },
        "row_labels": {"type": "array", "items": {"type": "string"}, "description": "Row labels"},
        "col_labels": {"type": "array", "items": {"type": "string"}, "description": "Column labels"},
    },
    "param_descriptions": {
        "var1": "Row variable name",
        "var2": "Column variable name",
        "chi_square": "Chi-square statistic",
        "df": "Degrees of freedom",
        "p": "p-value",
        "n": "Total sample size",
        "cramers_v": "Cramer's V effect size",
    },
}

INGEST_FIGURE = {
    "description": (
        "Register a figure for inclusion in the paper. "
        "Upload the image file separately, then call this to add caption and notes."
    ),
    "param_descriptions": {
        "filename": "Filename in workspace/figures/",
        "number": "Figure number (1, 2, 3...)",
        "title": "Figure title",
        "caption": "Detailed caption",
        "note": "Additional notes (e.g., 'Error bars = 95% CI')",
    },
}

FORMAT_INGESTED_RESULT = {
    "description": "Format a previously ingested result as APA table + prose.",
    "param_descriptions": {
        "result_id": "ID of the ingested result (e.g., result_001)",
        "table_number": "Table number to use",
    },
}

LIST_INGESTED_RESULTS = {
    "description": "List all ingested research results and figures.",
}

GENERATE_RESULTS_SECTION = {
    "description": (
        "Generate a complete Results section from all ingested research results. "
        "Combines quantitative and qualitative findings with proper APA formatting."
    ),
    "param_descriptions": {
        "include_tables": "Include APA tables",
        "include_figures": "Include figure references",
    },
}

# =============================================================================
# EXTENDED INGESTION (Phase 2b)
# =============================================================================

INGEST_LOGISTIC_REGRESSION = {
    "description": "Ingest logistic regression results for APA formatting.",
    "schema_override": {
        "predictors": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "dependent_var": "Binary dependent variable",
        "n": "Sample size",
        "n_events": "Number of events",
        "pseudo_r_squared": "Pseudo R-squared",
        "chi_square": "Chi-square statistic",
        "chi_p": "Chi-square p-value",
    },
}

INGEST_NONPARAMETRIC = {
    "description": "Ingest non-parametric test results for APA formatting.",
    "schema_override": {
        "test_type": {"type": "string", "enum": ["mann_whitney", "kruskal_wallis", "wilcoxon"]},
        "groups": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "variable": "Variable name",
        "statistic": "Test statistic",
        "p": "p-value",
        "n": "Sample size",
        "effect_size": "Effect size value",
        "effect_name": "Effect size name",
    },
}

INGEST_FACTORIAL_ANOVA = {
    "description": "Ingest factorial ANOVA results for APA formatting.",
    "schema_override": {
        "main_effect1": {"type": "object"},
        "main_effect2": {"type": "object"},
        "interaction": {"type": "object"},
    },
    "param_descriptions": {
        "dependent_var": "Dependent variable",
        "factor1": "First factor",
        "factor2": "Second factor",
        "n": "Sample size",
        "df_error": "Error degrees of freedom",
    },
}

INGEST_REPEATED_MEASURES = {
    "description": "Ingest repeated measures ANOVA results for APA formatting.",
    "schema_override": {
        "level_means": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "dependent_var": "Dependent variable",
        "within_factor": "Within-subjects factor",
        "levels": "Factor levels",
        "f_stat": "F-statistic",
        "df_effect": "Effect degrees of freedom",
        "df_error": "Error degrees of freedom",
        "p": "p-value",
        "n": "Sample size",
    },
}

INGEST_RELIABILITY = {
    "description": "Ingest reliability analysis results for APA formatting.",
    "schema_override": {
        "item_stats": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "scale_name": "Scale name",
        "items": "Item names",
        "cronbachs_alpha": "Cronbach's alpha",
        "n_items": "Number of items",
        "n_cases": "Number of cases",
        "mean_inter_item_r": "Mean inter-item correlation",
    },
}

# =============================================================================
# ADVANCED INGESTION (Phase 3)
# =============================================================================

INGEST_MIXED_MODEL = {
    "description": "Ingest pre-computed mixed model results for APA formatting.",
    "schema_override": {
        "fixed_effects": {"type": "array", "items": {"type": "object"}},
        "random_effects": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "dependent_var": "Dependent variable",
        "group_var": "Grouping variable",
        "n_obs": "Number of observations",
        "n_groups": "Number of groups",
        "icc": "Intraclass correlation",
        "aic": "AIC",
        "bic": "BIC",
    },
}

INGEST_MANOVA = {
    "description": "Ingest pre-computed MANOVA results for APA formatting.",
    "schema_override": {
        "univariate_results": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "dependent_vars": "Dependent variables",
        "group_var": "Grouping variable",
        "groups": "Group names",
        "pillais_trace": "Pillai's Trace",
        "wilks_lambda": "Wilks' Lambda",
        "f_stat": "F-statistic",
        "df1": "Numerator df",
        "df2": "Denominator df",
        "p": "p-value",
        "n": "Sample size",
    },
}

INGEST_MEDIATION = {
    "description": "Ingest pre-computed mediation results for APA formatting.",
    "schema_override": {
        "path_a": {"type": "object"},
        "path_b": {"type": "object"},
        "path_c": {"type": "object"},
        "path_c_prime": {"type": "object"},
    },
    "param_descriptions": {
        "x_var": "Independent variable",
        "m_var": "Mediator variable",
        "y_var": "Dependent variable",
        "indirect_effect": "Indirect effect",
        "n": "Sample size",
        "sobel_z": "Sobel z-statistic",
        "sobel_p": "Sobel p-value",
        "bootstrap_ci_lower": "Lower bootstrap CI",
        "bootstrap_ci_upper": "Upper bootstrap CI",
        "mediation_type": "Mediation type",
    },
}

INGEST_MODERATION = {
    "description": "Ingest pre-computed moderation results for APA formatting.",
    "schema_override": {
        "main_x": {"type": "object"},
        "main_w": {"type": "object"},
        "interaction": {"type": "object"},
        "simple_slopes": {"type": "array", "items": {"type": "object"}},
    },
    "param_descriptions": {
        "x_var": "Independent variable",
        "w_var": "Moderator variable",
        "y_var": "Dependent variable",
        "r_squared": "R-squared",
        "r_squared_change": "R-squared change",
        "f_change": "F-change",
        "f_change_p": "F-change p-value",
        "n": "Sample size",
    },
}

# =============================================================================
# DATA ANALYSIS (compute from CSV)
# =============================================================================

ANALYZE_DESCRIPTIVES = {
    "description": (
        "Compute descriptive statistics from a CSV file in the workspace. "
        "Automatically ingests results to ResearchStore for APA formatting."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace (e.g., 'data.csv')",
        "variables": "Variable names to analyze (default: all numeric)",
        "by_group": "Optional grouping variable name",
    },
}

ANALYZE_CORRELATION = {
    "description": (
        "Compute correlation matrix from a CSV file. "
        "Returns formatted APA correlation table with significance stars."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "variables": "Variable names to correlate",
        "method": "Correlation method (default: pearson)",
    },
    "param_enums": {"method": ["pearson", "spearman"]},
}

ANALYZE_REGRESSION = {
    "description": (
        "Run OLS regression on a CSV file with assumption checking. "
        "Returns formatted APA table, prose, and assumption check results."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "dependent_var": "Name of dependent variable",
        "independent_vars": "Names of independent variables",
        "regression_type": "Regression type (currently only OLS)",
    },
    "param_enums": {"regression_type": ["ols"]},
}

ANALYZE_TTEST = {
    "description": (
        "Run t-test comparing two groups in a CSV file. "
        "Returns formatted APA table and prose with effect size."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "variable": "Numeric variable to compare",
        "group_var": "Grouping variable (must have exactly 2 groups)",
        "test_type": "Type of t-test (default: independent)",
    },
    "param_enums": {"test_type": ["independent", "paired"]},
}

ANALYZE_ANOVA = {
    "description": (
        "Run one-way ANOVA comparing 3+ groups in a CSV file. "
        "Includes post-hoc tests (Bonferroni-corrected) when significant."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "variable": "Numeric dependent variable",
        "group_var": "Categorical grouping variable (3+ groups)",
        "post_hoc": "Whether to run post-hoc tests (default: true)",
    },
}

ANALYZE_CHISQUARE = {
    "description": (
        "Run chi-square test of independence between two categorical variables. "
        "Creates contingency table and computes Cramer's V effect size."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "var1": "First categorical variable (rows)",
        "var2": "Second categorical variable (columns)",
    },
}

LIST_CSV_COLUMNS = {
    "description": (
        "List all columns in a CSV file with their types and missing value counts. "
        "Use this to explore a dataset before running analyses."
    ),
    "param_descriptions": {"filename": "CSV filename in workspace"},
}

ANALYZE_LOGISTIC_REGRESSION = {
    "description": (
        "Run logistic regression for binary outcomes. "
        "Returns odds ratios, confidence intervals, and model fit statistics."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "dependent_var": "Binary dependent variable (0/1)",
        "independent_vars": "Names of predictor variables",
    },
}

ANALYZE_MANN_WHITNEY = {
    "description": (
        "Run Mann-Whitney U test (non-parametric alternative to t-test). "
        "Use when data violates normality assumptions."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "variable": "Numeric variable to compare",
        "group_var": "Grouping variable (must have exactly 2 groups)",
    },
}

ANALYZE_KRUSKAL_WALLIS = {
    "description": (
        "Run Kruskal-Wallis H test (non-parametric alternative to one-way ANOVA). "
        "Use when data violates normality or homogeneity assumptions."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "variable": "Numeric variable to compare",
        "group_var": "Grouping variable (3+ groups)",
    },
}

ANALYZE_WILCOXON = {
    "description": (
        "Run Wilcoxon signed-rank test (non-parametric alternative to paired t-test). "
        "Use for paired/repeated measures when normality is violated."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "var1": "First measurement variable",
        "var2": "Second measurement variable (paired with var1)",
    },
}

ANALYZE_FACTORIAL_ANOVA = {
    "description": (
        "Run two-way (factorial) ANOVA with main effects and interaction. "
        "Examines effects of two categorical factors on a continuous outcome."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "variable": "Numeric dependent variable",
        "factor1": "First categorical factor",
        "factor2": "Second categorical factor",
    },
}

ANALYZE_REPEATED_MEASURES = {
    "description": (
        "Run repeated measures ANOVA for within-subjects designs. "
        "Data must be in long format. Includes Greenhouse-Geisser correction."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace (long format)",
        "subject_var": "Subject/participant ID variable",
        "within_var": "Within-subjects factor variable",
        "value_var": "Dependent variable (measurement)",
    },
}

ANALYZE_RELIABILITY = {
    "description": (
        "Calculate Cronbach's alpha for scale reliability. "
        "Includes item-total correlations and alpha-if-deleted for each item."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "items": "List of item variable names (must be numeric)",
        "scale_name": "Name of the scale for reporting",
    },
}

ANALYZE_MIXED_MODEL = {
    "description": (
        "Run a mixed-effects (multilevel) model on CSV data. "
        "For hierarchical/nested data with random intercepts."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "dependent_var": "Dependent variable",
        "fixed_vars": "Fixed effect predictor variables",
        "group_var": "Grouping variable for random intercept",
    },
}

ANALYZE_MANOVA = {
    "description": (
        "Run a one-way MANOVA (multivariate ANOVA) on CSV data. "
        "Tests group differences on multiple dependent variables simultaneously."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "dependent_vars": "List of numeric dependent variables (2+)",
        "group_var": "Grouping variable",
    },
}

ANALYZE_MEDIATION = {
    "description": (
        "Run mediation analysis (Baron & Kenny approach with Sobel test). "
        "Tests whether M mediates the X -> Y relationship."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "x_var": "Independent variable (predictor)",
        "m_var": "Mediator variable",
        "y_var": "Dependent variable (outcome)",
        "n_bootstrap": "Bootstrap samples for CI (default: 1000)",
    },
}

ANALYZE_MODERATION = {
    "description": (
        "Run moderation analysis (interaction effect). "
        "Tests whether W moderates the X -> Y relationship."
    ),
    "param_descriptions": {
        "filename": "CSV filename in workspace",
        "x_var": "Independent variable",
        "w_var": "Moderator variable",
        "y_var": "Dependent variable",
    },
}

# =============================================================================
# DATA PROVIDERS
# =============================================================================

LIST_DATA_PROVIDERS = {
    "description": (
        "List available data providers for fetching datasets. "
        "Returns Eurostat, World Bank, OWID, and other SDMX providers."
    ),
}

FETCH_EUROSTAT = {
    "description": (
        "Fetch dataset from Eurostat (EU statistics). "
        "Data is saved as CSV in workspace for analysis."
    ),
    "schema_override": {
        "filters": {
            "type": "object",
            "description": "Dimension filters (e.g., {'geo': 'DE+FR', 'unit': 'CP_MEUR'})",
        },
    },
    "param_descriptions": {
        "dataset_id": "Eurostat dataset code (e.g., 'nama_10_gdp', 'tour_occ_nim')",
        "start_period": "Start year (e.g., '2010')",
        "end_period": "End year (e.g., '2023')",
    },
}

FETCH_WORLDBANK = {
    "description": (
        "Fetch indicator data from World Bank. "
        "Data is saved as CSV in workspace for analysis."
    ),
    "param_descriptions": {
        "indicator": "World Bank indicator code (e.g., 'NY.GDP.MKTP.CD')",
        "countries": "Country codes semicolon-separated (e.g., 'USA;DEU;FRA') or 'all'",
        "start_year": "Start year",
        "end_year": "End year",
    },
}

FETCH_OWID = {
    "description": (
        "Fetch dataset from Our World in Data. "
        "Data is saved as CSV in workspace for analysis."
    ),
    "param_descriptions": {
        "dataset_name": "OWID dataset name (e.g., 'covid-19', 'life-expectancy')",
    },
}

SEARCH_WORLDBANK = {
    "description": "Search World Bank indicators by keyword. Returns matching indicator codes.",
    "param_descriptions": {"query": "Search term (e.g., 'GDP', 'population', 'education')"},
}

OVERRIDES = {
    # Ingestion Phase 1
    "ingest_regression": INGEST_REGRESSION,
    "ingest_ttest": INGEST_TTEST,
    "ingest_correlation": INGEST_CORRELATION,
    "ingest_descriptives": INGEST_DESCRIPTIVES,
    "ingest_themes": INGEST_THEMES,
    "ingest_anova": INGEST_ANOVA,
    "ingest_chisquare": INGEST_CHISQUARE,
    "ingest_figure": INGEST_FIGURE,
    "format_ingested_result": FORMAT_INGESTED_RESULT,
    "list_ingested_results": LIST_INGESTED_RESULTS,
    "generate_results_section": GENERATE_RESULTS_SECTION,
    # Ingestion Phase 2b
    "ingest_logistic_regression": INGEST_LOGISTIC_REGRESSION,
    "ingest_nonparametric": INGEST_NONPARAMETRIC,
    "ingest_factorial_anova": INGEST_FACTORIAL_ANOVA,
    "ingest_repeated_measures": INGEST_REPEATED_MEASURES,
    "ingest_reliability": INGEST_RELIABILITY,
    # Ingestion Phase 3
    "ingest_mixed_model": INGEST_MIXED_MODEL,
    "ingest_manova": INGEST_MANOVA,
    "ingest_mediation": INGEST_MEDIATION,
    "ingest_moderation": INGEST_MODERATION,
    # Analysis
    "analyze_descriptives": ANALYZE_DESCRIPTIVES,
    "analyze_correlation": ANALYZE_CORRELATION,
    "analyze_regression": ANALYZE_REGRESSION,
    "analyze_ttest": ANALYZE_TTEST,
    "analyze_anova": ANALYZE_ANOVA,
    "analyze_chisquare": ANALYZE_CHISQUARE,
    "list_csv_columns": LIST_CSV_COLUMNS,
    "analyze_logistic_regression": ANALYZE_LOGISTIC_REGRESSION,
    "analyze_mann_whitney": ANALYZE_MANN_WHITNEY,
    "analyze_kruskal_wallis": ANALYZE_KRUSKAL_WALLIS,
    "analyze_wilcoxon": ANALYZE_WILCOXON,
    "analyze_factorial_anova": ANALYZE_FACTORIAL_ANOVA,
    "analyze_repeated_measures": ANALYZE_REPEATED_MEASURES,
    "analyze_reliability": ANALYZE_RELIABILITY,
    "analyze_mixed_model": ANALYZE_MIXED_MODEL,
    "analyze_manova": ANALYZE_MANOVA,
    "analyze_mediation": ANALYZE_MEDIATION,
    "analyze_moderation": ANALYZE_MODERATION,
    # Data providers
    "list_data_providers": LIST_DATA_PROVIDERS,
    "fetch_eurostat": FETCH_EUROSTAT,
    "fetch_worldbank": FETCH_WORLDBANK,
    "fetch_owid": FETCH_OWID,
    "search_worldbank": SEARCH_WORLDBANK,
}

# fmt: on
