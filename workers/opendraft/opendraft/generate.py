"""Top-level entry point for draft generation."""

import logging
from pathlib import Path
from typing import Optional

from opendraft.config import get_config
from opendraft.orchestrator.state import SharedState
from opendraft.orchestrator.engine import Orchestrator

logger = logging.getLogger(__name__)


def generate_draft(
    topic: str,
    citation_style: str = "APA 7th",
    language: str = "english",
    model_name: Optional[str] = None,
    workspace_dir: Optional[Path] = None,
    on_phase_start: Optional[callable] = None,
    on_phase_complete: Optional[callable] = None,
    on_write: Optional[callable] = None,
) -> str:
    """
    Generate an academic draft on the given topic.

    Args:
        topic: The research topic / thesis question
        citation_style: One of "APA 7th", "IEEE", "Chicago", "MLA"
        language: Draft language ("english", "german", "spanish", "french")
        model_name: Override Gemini model name
        workspace_dir: Directory for intermediate files
        on_phase_start: Callback(phase_num, total, agent_name, description)
        on_phase_complete: Callback(phase_num, total, agent_name, result)
        on_write: Callback(filename, word_count) for live word count updates

    Returns:
        The final draft text (markdown).
    """
    config = get_config()
    config.validate()

    state = SharedState(
        topic=topic,
        citation_style=citation_style,
        draft_language=language,
        workspace_dir=workspace_dir,
    )

    orchestrator = Orchestrator(
        state=state,
        model_name=model_name or config.gemini_model,
        on_phase_start=on_phase_start,
        on_phase_complete=on_phase_complete,
        on_write=on_write,
    )

    final_draft = orchestrator.run()

    # Save citation database
    from opendraft.citations.database import save_citation_database
    db_path = (workspace_dir or Path("workspace")) / "citation_database.json"
    if state.citation_db.citations:
        save_citation_database(state.citation_db, db_path)

    return final_draft
