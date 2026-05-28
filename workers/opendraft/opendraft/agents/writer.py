"""Writer agent: writes draft sections with citations."""

from typing import Callable, Optional

from opendraft.agents.base import BaseCodeAgent, ToolConfig
from opendraft.functions.declarations import get_tools_for_handlers
from opendraft.functions.citation_ops import CitationOps
from opendraft.functions.workspace_ops import WorkspaceOps
from opendraft.functions.format_ops import FormatOps
from opendraft.functions.code_exec import CodeExecOps
from opendraft.orchestrator.state import SharedState


class WriterAgent(BaseCodeAgent):
    """
    Replaces v1's Crafter + Thread + Narrator.

    Writes sections with {cite_XXX} references, uses run_code (local sandbox)
    for word counts and cross-reference checks.
    """

    def __init__(
        self,
        state: SharedState,
        model_name: str = "gemini-3-flash-preview",
        on_write: Optional[Callable[[str, int], None]] = None,
    ):
        citation_ops = CitationOps(state.citation_db)
        workspace_ops = WorkspaceOps(state, on_write=on_write)
        format_ops = FormatOps(state.citation_db, workspace_ops=workspace_ops)
        code_ops = CodeExecOps()

        function_handlers = {
            "citation_db_get": citation_ops.citation_db_get,
            "citation_db_query": citation_ops.citation_db_query,
            "write_file": workspace_ops.write_file,
            "read_file": workspace_ops.read_file,
            "list_files": workspace_ops.list_files,
            "word_count": format_ops.word_count,
            "word_count_file": format_ops.word_count_file,
            "compile_draft": format_ops.compile_draft,
            "run_code": code_ops.run_code,
        }

        tool_config = ToolConfig(
            function_declarations=get_tools_for_handlers(function_handlers),
        )

        system_prompt = BaseCodeAgent.load_prompt("writer")

        super().__init__(
            name="writer",
            system_prompt=system_prompt,
            tool_config=tool_config,
            function_handlers=function_handlers,
            model_name=model_name,
            max_iterations=30,
        )
