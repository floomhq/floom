"""Researcher agent: discovers papers, builds citation database."""

from opendraft.agents.base import BaseCodeAgent, ToolConfig
from opendraft.functions.declarations import get_tools_for_handlers
from opendraft.functions.academic_search import search_semantic_scholar, search_crossref
from opendraft.functions.citation_ops import CitationOps
from opendraft.orchestrator.state import SharedState


class ResearcherAgent(BaseCodeAgent):
    """
    Replaces v1's Scout + Scribe + Signal agents.

    Uses function calls for Semantic Scholar / Crossref, builds citation database.
    """

    def __init__(self, state: SharedState, model_name: str = "gemini-3-flash-preview"):
        citation_ops = CitationOps(state.citation_db)

        function_handlers = {
            "search_semantic_scholar": search_semantic_scholar,
            "search_crossref": search_crossref,
            "citation_db_add": citation_ops.citation_db_add,
            "citation_db_query": citation_ops.citation_db_query,
            "citation_db_list_all": citation_ops.citation_db_list_all,
        }

        tool_config = ToolConfig(
            function_declarations=get_tools_for_handlers(function_handlers),
        )

        system_prompt = BaseCodeAgent.load_prompt("researcher")

        super().__init__(
            name="researcher",
            system_prompt=system_prompt,
            tool_config=tool_config,
            function_handlers=function_handlers,
            model_name=model_name,
            max_iterations=12,  # Need more iterations to find 80+ citations
        )
