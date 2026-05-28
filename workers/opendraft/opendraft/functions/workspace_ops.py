"""Workspace file operations for Gemini function calling."""

from typing import Callable, Optional

from opendraft.orchestrator.state import SharedState


class WorkspaceOps:
    """Workspace operations bound to a SharedState instance."""

    def __init__(
        self,
        state: SharedState,
        on_write: Optional[Callable[[str, int], None]] = None,
    ):
        """Initialize workspace operations.

        Args:
            state: SharedState instance for file operations
            on_write: Optional callback called after each write: on_write(filename, word_count)
        """
        self.state = state
        self.on_write = on_write

    def write_file(self, filename: str, content: str) -> str:
        self.state.write_file(filename, content)
        word_count = len(content.split())

        # Notify callback if set
        if self.on_write:
            try:
                self.on_write(filename, word_count)
            except Exception:
                pass  # Don't let callback errors break file writes

        return f"Written {len(content)} chars to {filename}"

    def read_file(self, filename: str) -> str:
        content = self.state.read_file(filename)
        if not content:
            return f"File '{filename}' not found or empty"
        return content

    def list_files(self) -> list:
        files = self.state.list_files()
        if not files:
            return ["(workspace is empty)"]
        return files
