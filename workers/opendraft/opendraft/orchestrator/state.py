"""SharedState: workspace and context management across agents."""

import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field

from opendraft.citations.database import CitationDatabase
from opendraft.research import ResearchStore

logger = logging.getLogger(__name__)


@dataclass
class AgentResult:
    """Result from a single agent run."""
    agent_name: str
    signal: str  # DONE, RERUN, ESCALATE
    output: str
    metadata: Dict[str, Any] = field(default_factory=dict)
    rerun_target: Optional[str] = None  # For RERUN: which agent to rerun
    rerun_reason: Optional[str] = None  # For RERUN: why


class SharedState:
    """
    Shared state passed between agents in the pipeline.

    Manages:
    - Citation database (built up by Researcher, used by all)
    - Workspace files (outline, sections, drafts)
    - Agent results and context summaries
    - Phase tracking
    - Quality metrics (V3: quality gate integration)
    """

    def __init__(
        self,
        topic: str,
        citation_style: str = "APA 7th",
        draft_language: str = "english",
        workspace_dir: Optional[Path] = None,
    ):
        self.topic = topic
        self.citation_db = CitationDatabase(
            citation_style=citation_style,
            draft_language=draft_language,
        )
        self.research_store = ResearchStore()  # Phase 1: structured results storage
        self.workspace_dir = workspace_dir or Path("workspace")
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self._clean_workspace()

        self.agent_results: List[AgentResult] = []
        self.phase_summaries: Dict[str, str] = {}
        self.current_phase: str = "init"

        # V3: Quality gate metrics
        self.quality_score: Optional[Dict[str, Any]] = None
        self.skip_llm_refine: bool = False  # Set True if quality >= 85%
        self.run_id: str = f"run_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        self.run_metadata: Dict[str, Any] = {"run_id": self.run_id, "started_at": datetime.now().isoformat()}

        # V3: Compile quality gate tracking
        self.compile_block_count: int = 0  # Tracks how many times compile_draft was blocked
        self.compile_block_reasons: List[str] = []  # Tracks block reasons for debugging

    def _clean_workspace(self) -> None:
        """Remove stale artifacts from previous runs to prevent contamination."""
        stale_patterns = ["section_*.md", "draft*.md", "frontmatter.md",
                          "final_draft.md", "validation_report.md"]
        for pattern in stale_patterns:
            for path in self.workspace_dir.glob(pattern):
                try:
                    path.unlink()
                    logger.info("Cleaned stale workspace file: %s", path.name)
                except OSError:
                    pass

    def _safe_path(self, filename: str) -> Path:
        """Resolve filename within workspace, blocking path traversal."""
        path = (self.workspace_dir / filename).resolve()
        if not str(path).startswith(str(self.workspace_dir.resolve())):
            raise ValueError(f"Path traversal blocked: {filename}")
        return path

    # Workspace file operations
    def write_file(self, filename: str, content: str) -> str:
        try:
            path = self._safe_path(filename)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8')
            logger.info("Wrote workspace file: %s", filename)
            return str(path)
        except OSError as e:
            logger.error("Failed to write workspace file %s: %s", filename, e)
            raise

    def read_file(self, filename: str) -> str:
        path = self._safe_path(filename)
        if not path.exists():
            return ""
        try:
            return path.read_text(encoding='utf-8')
        except OSError as e:
            logger.error("Failed to read workspace file %s: %s", filename, e)
            return ""

    def list_files(self) -> List[str]:
        if not self.workspace_dir.exists():
            return []
        return [str(p.relative_to(self.workspace_dir)) for p in self.workspace_dir.rglob("*") if p.is_file()]

    # Context building for agents
    def get_context_for_agent(self, agent_name: str) -> str:
        """Build context string from previous agent results."""
        lines = [f"Topic: {self.topic}"]
        lines.append(f"Citation style: {self.citation_db.citation_style}")
        lines.append(f"Language: {self.citation_db.draft_language}")
        lines.append(f"Citations in DB: {len(self.citation_db.citations)}")

        if self.phase_summaries:
            lines.append("\n--- Previous Phase Summaries ---")
            for phase, summary in self.phase_summaries.items():
                lines.append(f"\n[{phase}]:\n{summary[:2000]}")

        files = self.list_files()
        if files:
            lines.append(f"\n--- Workspace Files ---\n{', '.join(files)}")

        return "\n".join(lines)

    def add_result(self, result: AgentResult) -> None:
        self.agent_results.append(result)
        # Store a summary for the next agent
        summary = result.output[:3000] if result.output else ""
        self.phase_summaries[result.agent_name] = summary

    def get_final_draft(self) -> str:
        """Read the final compiled draft from workspace."""
        for filename in ['final_draft.md', 'compiled_draft.md', 'draft.md']:
            content = self.read_file(filename)
            if content:
                return content
        logger.warning("No draft file found in workspace (checked final_draft.md, compiled_draft.md, draft.md)")
        return ""
