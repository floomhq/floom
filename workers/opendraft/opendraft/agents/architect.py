"""Architect agent: designs outline based on citations and topic."""

from opendraft.agents.base import BaseCodeAgent, ToolConfig
from opendraft.functions.declarations import get_tools_for_handlers
from opendraft.functions.citation_ops import CitationOps
from opendraft.functions.workspace_ops import WorkspaceOps
from opendraft.functions.code_exec import CodeExecOps
from opendraft.orchestrator.state import SharedState


class ArchitectAgent(BaseCodeAgent):
    """
    Replaces v1's Architect + Formatter + Citation Manager.

    Analyzes citations via run_code (local sandbox), designs structured outline,
    assigns citations to sections.
    """

    def __init__(self, state: SharedState, model_name: str = "gemini-3-flash-preview"):
        citation_ops = CitationOps(state.citation_db)
        workspace_ops = WorkspaceOps(state)
        code_ops = CodeExecOps()

        function_handlers = {
            "citation_db_query": citation_ops.citation_db_query,
            "citation_db_list_all": citation_ops.citation_db_list_all,
            "write_file": workspace_ops.write_file,
            "read_file": workspace_ops.read_file,
            "list_files": workspace_ops.list_files,
            "run_code": code_ops.run_code,
        }

        tool_config = ToolConfig(
            function_declarations=get_tools_for_handlers(function_handlers),
        )

        system_prompt = BaseCodeAgent.load_prompt("architect")

        super().__init__(
            name="architect",
            system_prompt=system_prompt,
            tool_config=tool_config,
            function_handlers=function_handlers,
            model_name=model_name,
            max_iterations=3,
        )
