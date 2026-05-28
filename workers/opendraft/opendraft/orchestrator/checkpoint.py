"""Checkpoint system for pipeline resume after interruption.

Saves pipeline state after each phase, allowing interrupted runs to resume
from the last completed phase rather than starting over.
"""

import json
import logging
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, TYPE_CHECKING

from opendraft.core.errors import CheckpointError

if TYPE_CHECKING:
    from opendraft.orchestrator.state import SharedState

logger = logging.getLogger(__name__)


@dataclass
class PipelineCheckpoint:
    """Snapshot of pipeline state at a checkpoint.

    Attributes:
        run_id: Unique run identifier
        topic: Paper topic being processed
        current_phase: Phase that was running when checkpoint was created
        completed_phases: List of successfully completed phase names
        shared_state: Serialized SharedState data (citations, files, results)
        timestamp: When checkpoint was created
        model_name: Model being used for generation
        citation_style: Citation style (APA, IEEE, etc.)
        draft_language: Language for the draft
    """
    run_id: str
    topic: str
    current_phase: str
    completed_phases: list[str]
    shared_state: dict[str, Any]
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    model_name: str = "gemini-3-flash-preview"
    citation_style: str = "APA 7th"
    draft_language: str = "english"
    workspace_path: str = ""  # Absolute path to workspace directory

    def to_dict(self) -> dict[str, Any]:
        """Convert checkpoint to JSON-serializable dict."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PipelineCheckpoint":
        """Create checkpoint from dict."""
        return cls(**data)


class CheckpointManager:
    """Manages checkpoint save/load operations.

    Checkpoints are stored in ~/.opendraft/checkpoints/ as JSON files.
    """

    def __init__(self, storage_path: Optional[Path] = None):
        """Initialize checkpoint manager.

        Args:
            storage_path: Directory to store checkpoints (default: ~/.opendraft/checkpoints)
        """
        self.storage_path = storage_path or Path.home() / ".opendraft" / "checkpoints"
        self.storage_path.mkdir(parents=True, exist_ok=True)

    def _checkpoint_path(self, run_id: str) -> Path:
        """Get path for a checkpoint file."""
        # Sanitize run_id for filesystem
        safe_id = "".join(c if c.isalnum() or c in "_-" else "_" for c in run_id)
        return self.storage_path / f"{safe_id}.json"

    def save(self, checkpoint: PipelineCheckpoint) -> Path:
        """Save a checkpoint to disk.

        Args:
            checkpoint: The checkpoint to save

        Returns:
            Path to the saved checkpoint file

        Raises:
            CheckpointError: If save fails
        """
        path = self._checkpoint_path(checkpoint.run_id)
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(checkpoint.to_dict(), f, indent=2, default=str)
            logger.info("Saved checkpoint: %s at phase %s", checkpoint.run_id, checkpoint.current_phase)
            return path
        except (OSError, TypeError) as e:
            raise CheckpointError(
                f"Failed to save checkpoint {checkpoint.run_id}",
                details={"path": str(path), "error": str(e)}
            ) from e

    def load(self, run_id: str) -> Optional[PipelineCheckpoint]:
        """Load a checkpoint by run ID.

        Args:
            run_id: The run identifier

        Returns:
            PipelineCheckpoint if found, None otherwise

        Raises:
            CheckpointError: If checkpoint is corrupted
        """
        path = self._checkpoint_path(run_id)
        if not path.exists():
            return None

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            checkpoint = PipelineCheckpoint.from_dict(data)
            logger.info("Loaded checkpoint: %s (phase: %s)", run_id, checkpoint.current_phase)
            return checkpoint
        except json.JSONDecodeError as e:
            raise CheckpointError(
                f"Corrupted checkpoint {run_id}",
                details={"path": str(path), "error": str(e)}
            ) from e
        except (KeyError, TypeError) as e:
            raise CheckpointError(
                f"Incompatible checkpoint format {run_id}",
                details={"path": str(path), "error": str(e)}
            ) from e

    def delete(self, run_id: str) -> bool:
        """Delete a checkpoint.

        Args:
            run_id: The run identifier

        Returns:
            True if deleted, False if not found
        """
        path = self._checkpoint_path(run_id)
        if path.exists():
            try:
                path.unlink()
                logger.info("Deleted checkpoint: %s", run_id)
                return True
            except OSError as e:
                logger.warning("Failed to delete checkpoint %s: %s", run_id, e)
                return False
        return False

    def list_checkpoints(self) -> list[dict[str, Any]]:
        """List all available checkpoints with summary info.

        Returns:
            List of checkpoint summaries (run_id, topic, phase, timestamp)
        """
        checkpoints = []
        for path in self.storage_path.glob("*.json"):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                checkpoints.append({
                    "run_id": data.get("run_id", path.stem),
                    "topic": data.get("topic", "")[:50],
                    "current_phase": data.get("current_phase", "unknown"),
                    "completed_phases": data.get("completed_phases", []),
                    "timestamp": data.get("timestamp", ""),
                    "path": str(path),
                })
            except (json.JSONDecodeError, OSError):
                # Skip corrupted checkpoints
                continue

        # Sort by timestamp, newest first
        checkpoints.sort(key=lambda x: x.get("timestamp", ""), reverse=True)
        return checkpoints

    def cleanup_old_checkpoints(self, max_age_days: int = 7, keep_count: int = 10) -> int:
        """Remove old checkpoints to prevent disk bloat.

        Args:
            max_age_days: Delete checkpoints older than this
            keep_count: Always keep at least this many checkpoints

        Returns:
            Number of checkpoints deleted
        """
        checkpoints = self.list_checkpoints()

        # Always keep recent checkpoints
        if len(checkpoints) <= keep_count:
            return 0

        deleted = 0
        cutoff = datetime.now() - __import__("datetime").timedelta(days=max_age_days)

        for cp in checkpoints[keep_count:]:
            try:
                cp_time = datetime.fromisoformat(cp["timestamp"])
                if cp_time < cutoff:
                    path = Path(cp["path"])
                    if path.exists():
                        path.unlink()
                        deleted += 1
            except (ValueError, OSError):
                continue

        if deleted:
            logger.info("Cleaned up %s old checkpoints", deleted)
        return deleted


def serialize_shared_state(state: "SharedState") -> dict[str, Any]:
    """Serialize SharedState for checkpoint storage.

    Args:
        state: SharedState instance to serialize

    Returns:
        JSON-serializable dict
    """
    from opendraft.citations.database import save_citation_database_to_dict

    return {
        "topic": state.topic,
        "citation_db": save_citation_database_to_dict(state.citation_db),
        "workspace_files": {
            name: state.read_file(name)
            for name in state.list_files()
        },
        "phase_summaries": state.phase_summaries,
        "current_phase": state.current_phase,
        "quality_score": state.quality_score,
        "skip_llm_refine": state.skip_llm_refine,
        "run_id": state.run_id,
        "run_metadata": state.run_metadata,
    }


def deserialize_shared_state(
    data: dict[str, Any],
    workspace_dir: Path,
) -> "SharedState":
    """Restore SharedState from checkpoint data.

    Args:
        data: Serialized state dict
        workspace_dir: Workspace directory to restore files to

    Returns:
        Restored SharedState instance
    """
    from opendraft.orchestrator.state import SharedState
    from opendraft.citations.database import load_citation_database_from_dict

    # Create state with basic config
    state = SharedState(
        topic=data["topic"],
        workspace_dir=workspace_dir,
    )

    # Restore citation database
    if "citation_db" in data:
        state.citation_db = load_citation_database_from_dict(data["citation_db"])

    # Restore workspace files
    for filename, content in data.get("workspace_files", {}).items():
        if content:
            state.write_file(filename, content)

    # Restore metadata
    state.phase_summaries = data.get("phase_summaries", {})
    state.current_phase = data.get("current_phase", "init")
    state.quality_score = data.get("quality_score")
    state.skip_llm_refine = data.get("skip_llm_refine", False)
    state.run_id = data.get("run_id", state.run_id)
    state.run_metadata = data.get("run_metadata", state.run_metadata)

    return state
