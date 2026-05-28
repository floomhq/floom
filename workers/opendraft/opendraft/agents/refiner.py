"""Refiner agent: final polish, citation compilation, bibliography generation."""

from opendraft.agents.base import BaseCodeAgent, ToolConfig
from opendraft.functions.declarations import get_tools_for_handlers
from opendraft.functions.workspace_ops import WorkspaceOps
from opendraft.functions.format_ops import FormatOps
from opendraft.functions.code_exec import CodeExecOps
from opendraft.orchestrator.state import SharedState
from opendraft.research import ResultsFormatter, IngestOps
from opendraft.analysis.ops import AnalysisOps
from opendraft.data import DataFetcher
from opendraft.qualitative import QualitativeOps


class RefinerAgent(BaseCodeAgent):
    """
    Replaces v1's Voice + Entropy + Polish + Enhancer.

    Final polish, compiles citations, generates bibliography,
    formatting checks via run_code (local sandbox).
    """

    def __init__(self, state: SharedState, model_name: str = "gemini-3-flash-preview"):
        workspace_ops = WorkspaceOps(state)
        format_ops = FormatOps(state.citation_db, workspace_ops=workspace_ops)
        code_ops = CodeExecOps()
        ingest_ops = IngestOps(state.research_store)
        analysis_ops = AnalysisOps(state.workspace_dir, state.research_store)
        data_fetcher = DataFetcher(state.workspace_dir)
        _figure_gen = None

        def _get_figure_gen():
            nonlocal _figure_gen
            if _figure_gen is None:
                from opendraft.analysis.figures import FigureGenerator

                _figure_gen = FigureGenerator(state.workspace_dir, state.research_store)
            return _figure_gen

        qualitative_ops = QualitativeOps(state.workspace_dir, state.research_store)

        results_formatter = ResultsFormatter()

        function_handlers = {
            "compile_citations": format_ops.compile_citations,
            "generate_bibliography": format_ops.generate_bibliography,
            "finalize_draft": format_ops.finalize_draft,
            "clean_draft": format_ops.clean_draft,
            "detect_repetition": format_ops.detect_repetition,
            "detect_advocacy_language": format_ops.detect_advocacy_language,
            "score_quality": format_ops.score_quality,
            "llm_refine": format_ops.llm_refine,
            # MVP: natural language formatter
            "format_results": lambda description, result_type=None: results_formatter.format(description, result_type),
            # Phase 1: structured ingestion
            "ingest_regression": ingest_ops.ingest_regression,
            "ingest_ttest": ingest_ops.ingest_ttest,
            "ingest_correlation": ingest_ops.ingest_correlation,
            "ingest_descriptives": ingest_ops.ingest_descriptives,
            "ingest_themes": ingest_ops.ingest_themes,
            "ingest_anova": ingest_ops.ingest_anova,
            "ingest_chisquare": ingest_ops.ingest_chisquare,
            "ingest_figure": ingest_ops.ingest_figure,
            "format_ingested_result": ingest_ops.format_result,
            "list_ingested_results": lambda: f"{ingest_ops.list_results()}\n\n{ingest_ops.list_figures()}",
            "generate_results_section": ingest_ops.generate_results_section,
            # Phase 2a: basic analysis (auto-ingests to research_store)
            "analyze_descriptives": analysis_ops.analyze_descriptives,
            "analyze_correlation": analysis_ops.analyze_correlation,
            "analyze_regression": analysis_ops.analyze_regression,
            "analyze_ttest": analysis_ops.analyze_ttest,
            "analyze_anova": analysis_ops.analyze_anova,
            "analyze_chisquare": analysis_ops.analyze_chisquare,
            "list_csv_columns": analysis_ops.list_csv_columns,
            # Phase 2b: extended analysis
            "analyze_logistic_regression": analysis_ops.analyze_logistic_regression,
            "analyze_mann_whitney": analysis_ops.analyze_mann_whitney,
            "analyze_kruskal_wallis": analysis_ops.analyze_kruskal_wallis,
            "analyze_wilcoxon": analysis_ops.analyze_wilcoxon,
            "analyze_factorial_anova": analysis_ops.analyze_factorial_anova,
            "analyze_repeated_measures": analysis_ops.analyze_repeated_measures,
            "analyze_reliability": analysis_ops.analyze_reliability,
            # Phase 2b: extended ingestion
            "ingest_logistic_regression": ingest_ops.ingest_logistic_regression,
            "ingest_nonparametric": ingest_ops.ingest_nonparametric,
            "ingest_factorial_anova": ingest_ops.ingest_factorial_anova,
            "ingest_repeated_measures": ingest_ops.ingest_repeated_measures,
            "ingest_reliability": ingest_ops.ingest_reliability,
            # Phase 3: advanced analysis
            "analyze_mixed_model": analysis_ops.analyze_mixed_model,
            "analyze_manova": analysis_ops.analyze_manova,
            "analyze_mediation": analysis_ops.analyze_mediation,
            "analyze_moderation": analysis_ops.analyze_moderation,
            # Phase 3: advanced ingestion
            "ingest_mixed_model": ingest_ops.ingest_mixed_model,
            "ingest_manova": ingest_ops.ingest_manova,
            "ingest_mediation": ingest_ops.ingest_mediation,
            "ingest_moderation": ingest_ops.ingest_moderation,
            # Phase 4: data integration
            "list_data_providers": data_fetcher.list_providers,
            "fetch_eurostat": data_fetcher.fetch_eurostat,
            "fetch_worldbank": data_fetcher.fetch_worldbank,
            "fetch_owid": data_fetcher.fetch_owid,
            "search_worldbank": data_fetcher.search_worldbank,
            # Figure generation
            "scatter_plot": lambda *args, **kwargs: _get_figure_gen().scatter_plot(*args, **kwargs),
            "bar_chart": lambda *args, **kwargs: _get_figure_gen().bar_chart(*args, **kwargs),
            "box_plot": lambda *args, **kwargs: _get_figure_gen().box_plot(*args, **kwargs),
            "histogram": lambda *args, **kwargs: _get_figure_gen().histogram(*args, **kwargs),
            "correlation_heatmap": lambda *args, **kwargs: _get_figure_gen().correlation_heatmap(*args, **kwargs),
            "line_chart": lambda *args, **kwargs: _get_figure_gen().line_chart(*args, **kwargs),
            "violin_plot": lambda *args, **kwargs: _get_figure_gen().violin_plot(*args, **kwargs),
            # Qualitative analysis
            "word_frequency": qualitative_ops.word_frequency,
            "extract_quotes": qualitative_ops.extract_quotes,
            "analyze_thematic": qualitative_ops.analyze_thematic,
            "sentiment_analysis": qualitative_ops.sentiment_analysis,
            "code_segments": qualitative_ops.code_segments,
            "content_analysis": qualitative_ops.content_analysis,
            "generate_wordcloud": qualitative_ops.generate_wordcloud,
            "analyze_ngrams": qualitative_ops.analyze_ngrams,
            "analyze_cooccurrence": qualitative_ops.analyze_cooccurrence,
            # Workspace
            "write_file": workspace_ops.write_file,
            "read_file": workspace_ops.read_file,
            "list_files": workspace_ops.list_files,
            "word_count": format_ops.word_count,
            "word_count_file": format_ops.word_count_file,
            "run_code": code_ops.run_code,
        }

        tool_config = ToolConfig(
            function_declarations=get_tools_for_handlers(function_handlers),
        )

        system_prompt = BaseCodeAgent.load_prompt("refiner")

        super().__init__(
            name="refiner",
            system_prompt=system_prompt,
            tool_config=tool_config,
            function_handlers=function_handlers,
            model_name=model_name,
            max_iterations=8,
        )
