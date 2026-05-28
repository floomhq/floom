"""Streaming progress display for OpenDraft v3.

Provides live progress updates during draft generation with:
- Phase progress visualization with progress bar
- Elapsed time tracking with ETA estimation
- Real-time word count and citation count updates
- Token-level streaming preview during Gemini generation
- Quality score display

Classes:
    StreamingProgress: Live display for full draft generation (5-phase pipeline)
    RevisionProgress: Live display for draft revision (4-step process)

Usage:
    # For draft generation
    with StreamingProgress(workspace_dir) as streamer:
        generate_draft(..., on_phase_start=streamer.on_phase_start, ...)

    # For revision
    with RevisionProgress("draft_name") as streamer:
        revise_draft(..., on_step=on_step, on_token=streamer.on_token)
"""

import time
import threading
from pathlib import Path
from typing import Optional, Callable
from dataclasses import dataclass, field

from rich.console import Console
from rich.live import Live
from rich.panel import Panel


@dataclass
class StreamingState:
    """Tracks current streaming state."""
    current_phase: int = 0
    total_phases: int = 5
    phase_name: str = ""
    phase_description: str = ""
    start_time: float = field(default_factory=time.time)
    word_count: int = 0
    status: str = "Starting..."
    workspace_dir: Optional[Path] = None
    citations_found: int = 0
    quality_score: Optional[float] = None
    is_complete: bool = False
    error: Optional[str] = None
    # Time estimation
    phase_start_times: dict = field(default_factory=dict)
    phase_durations: dict = field(default_factory=dict)


class StreamingProgress:
    """Live streaming progress display for draft generation."""

    def __init__(self, workspace_dir: Optional[Path] = None):
        self.console = Console()
        self.state = StreamingState(workspace_dir=workspace_dir)
        self._live: Optional[Live] = None
        self._update_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def _count_words_in_workspace(self) -> int:
        """Count words in all markdown files in workspace."""
        if not self.state.workspace_dir or not self.state.workspace_dir.exists():
            return 0

        total_words = 0
        for md_file in self.state.workspace_dir.glob("*.md"):
            try:
                text = md_file.read_text(encoding='utf-8', errors='ignore')
                total_words += len(text.split())
            except OSError:
                pass
        return total_words

    def on_write(self, filename: str, word_count: int) -> None:
        """Callback for immediate word count update when files are written.

        Args:
            filename: Name of the file that was written
            word_count: Word count of the written content
        """
        # Immediately recount workspace words for accurate display
        self.state.word_count = self._count_words_in_workspace()

    def _count_citations(self) -> int:
        """Count citations in citation database."""
        if not self.state.workspace_dir:
            return 0

        db_path = self.state.workspace_dir / "citation_database.json"
        if not db_path.exists():
            return 0

        try:
            import json
            with open(db_path) as f:
                data = json.load(f)
            return len(data.get('citations', {}))
        except (json.JSONDecodeError, OSError):
            return 0

    def _format_elapsed(self) -> str:
        """Format elapsed time as MM:SS."""
        elapsed = time.time() - self.state.start_time
        minutes = int(elapsed // 60)
        seconds = int(elapsed % 60)
        return f"{minutes:02d}:{seconds:02d}"

    def _estimate_remaining(self) -> Optional[str]:
        """Estimate remaining time based on completed phases."""
        if self.state.current_phase == 0 or self.state.is_complete:
            return None

        # Default phase durations (seconds) - based on typical runs
        DEFAULT_DURATIONS = {
            "researcher": 120,
            "architect": 60,
            "writer": 300,
            "validator": 90,
            "refiner": 90,
        }

        # Calculate remaining time for uncompleted phases
        remaining_seconds = 0
        phases = ["researcher", "architect", "writer", "validator", "refiner"]

        for i, phase in enumerate(phases):
            phase_num = i + 1
            if phase_num > self.state.current_phase:  # Future phases
                duration = self.state.phase_durations.get(phase, DEFAULT_DURATIONS.get(phase, 60))
                remaining_seconds += duration

        # Add estimate for current phase remaining
        if self.state.phase_name and self.state.phase_name in self.state.phase_start_times:
            phase_elapsed = time.time() - self.state.phase_start_times[self.state.phase_name]
            expected_duration = self.state.phase_durations.get(
                self.state.phase_name,
                DEFAULT_DURATIONS.get(self.state.phase_name, 60)
            )
            phase_remaining = max(0, expected_duration - phase_elapsed)
            remaining_seconds += phase_remaining

        if remaining_seconds <= 0:
            return None

        minutes = int(remaining_seconds // 60)
        if minutes < 1:
            return "~1 min"
        return f"~{minutes} min"

    def _build_display(self) -> Panel:
        """Build the live display panel."""
        # Phase progress
        phase_pct = (self.state.current_phase / self.state.total_phases) * 100
        progress_bar = "█" * int(phase_pct / 5) + "░" * (20 - int(phase_pct / 5))

        # Build content
        lines = []

        # Phase info
        if self.state.phase_name:
            phase_line = f"[bold cyan]Phase {self.state.current_phase}/{self.state.total_phases}[/bold cyan] {self.state.phase_description}"
        else:
            phase_line = "[dim]Initializing...[/dim]"
        lines.append(phase_line)

        # Progress bar
        lines.append(f"[green]{progress_bar}[/green] {phase_pct:.0f}%")

        # Stats line
        elapsed = self._format_elapsed()
        word_count = self.state.word_count
        citations = self.state.citations_found
        eta = self._estimate_remaining()

        stats = f"⏱️ {elapsed}"
        if eta:
            stats += f" (ETA: {eta})"
        stats += f"  |  📝 {word_count:,} words"
        if citations > 0:
            stats += f"  |  📚 {citations} citations"
        if self.state.quality_score is not None:
            stats += f"  |  ⭐ {self.state.quality_score:.1f}%"
        lines.append(f"[dim]{stats}[/dim]")

        # Status
        if self.state.error:
            lines.append(f"[bold red]Error: {self.state.error}[/bold red]")
        elif self.state.is_complete:
            lines.append("[bold green]✓ Draft complete![/bold green]")
        else:
            lines.append(f"[yellow]› {self.state.status}[/yellow]")

        content = "\n".join(lines)

        return Panel(
            content,
            title="[bold blue]OpenDraft v3[/bold blue]",
            border_style="blue",
            padding=(0, 1),
        )

    def _update_loop(self):
        """Background thread to update word count and refresh display."""
        while not self._stop_event.is_set():
            try:
                # Update word count
                self.state.word_count = self._count_words_in_workspace()
                self.state.citations_found = self._count_citations()

                # Refresh live display
                if self._live:
                    self._live.update(self._build_display())
            except Exception:
                # Silently handle display errors to avoid crashing the main process
                pass

            # Wait before next update
            self._stop_event.wait(1.0)  # Update every second

    def start(self):
        """Start the live streaming display."""
        self.state.start_time = time.time()
        self._stop_event.clear()

        # Start live display
        self._live = Live(
            self._build_display(),
            console=self.console,
            refresh_per_second=2,
            transient=False,
        )
        self._live.start()

        # Start background update thread
        self._update_thread = threading.Thread(
            target=self._update_loop,
            daemon=True,
            name="streaming-updater",
        )
        self._update_thread.start()

    def stop(self):
        """Stop the streaming display."""
        self._stop_event.set()

        if self._update_thread:
            self._update_thread.join(timeout=2.0)
            self._update_thread = None

        if self._live:
            # Final update
            self._live.update(self._build_display())
            self._live.stop()
            self._live = None

    def on_phase_start(self, num: int, total: int, agent_name: str, description: str):
        """Called when a phase starts."""
        self.state.current_phase = num
        self.state.total_phases = total
        self.state.phase_name = agent_name
        self.state.phase_description = description
        self.state.status = f"Running {agent_name}..."

        # Track phase start time for ETA calculation
        self.state.phase_start_times[agent_name] = time.time()

        if self._live:
            self._live.update(self._build_display())

    def on_phase_complete(self, num: int, total: int, agent_name: str, result):
        """Called when a phase completes."""
        signal = result.signal
        if signal == "DONE":
            self.state.status = f"{agent_name} completed"
        elif signal == "RERUN":
            self.state.status = f"Rerunning: {result.rerun_reason}"
        elif signal == "ESCALATE":
            self.state.status = f"Escalated: {result.rerun_reason}"

        # Record actual phase duration for future ETA estimates
        if agent_name in self.state.phase_start_times:
            duration = time.time() - self.state.phase_start_times[agent_name]
            self.state.phase_durations[agent_name] = duration

        if self._live:
            self._live.update(self._build_display())

    def set_quality_score(self, score: float):
        """Update the quality score display."""
        self.state.quality_score = score
        if self._live:
            self._live.update(self._build_display())

    def set_status(self, status: str):
        """Update the status message."""
        self.state.status = status
        if self._live:
            self._live.update(self._build_display())

    def set_complete(self, word_count: int = 0):
        """Mark generation as complete."""
        self.state.is_complete = True
        if word_count:
            self.state.word_count = word_count
        self.state.status = "Complete"
        if self._live:
            self._live.update(self._build_display())

    def set_error(self, error: str):
        """Mark an error occurred."""
        self.state.error = error
        if self._live:
            self._live.update(self._build_display())

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            self.set_error(str(exc_val))
        self.stop()
        return False


def create_streaming_callbacks(
    workspace_dir: Path,
) -> tuple[StreamingProgress, Callable, Callable]:
    """Create streaming progress and callback functions.

    Args:
        workspace_dir: Path to workspace directory

    Returns:
        Tuple of (StreamingProgress instance, on_phase_start, on_phase_complete)
    """
    streamer = StreamingProgress(workspace_dir)
    return (
        streamer,
        streamer.on_phase_start,
        streamer.on_phase_complete,
    )


@dataclass
class RevisionState:
    """Tracks revision streaming state."""
    start_time: float = field(default_factory=time.time)
    current_step: int = 0
    total_steps: int = 4
    step_name: str = "Initializing"
    word_count_before: int = 0
    word_count_after: int = 0
    score_before: Optional[float] = None
    score_after: Optional[float] = None
    is_complete: bool = False
    error: Optional[str] = None
    # Token streaming
    token_buffer: str = ""
    tokens_received: int = 0


class RevisionProgress:
    """Live streaming progress display for draft revision."""

    STEPS = [
        "Scoring original draft",
        "Revising with Gemini",
        "Scoring revised draft",
        "Exporting files",
    ]

    def __init__(self, target_name: str = "draft"):
        self.console = Console()
        self.state = RevisionState()
        self.target_name = target_name
        self._live: Optional[Live] = None
        self._update_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def _format_elapsed(self) -> str:
        """Format elapsed time as MM:SS."""
        elapsed = time.time() - self.state.start_time
        minutes = int(elapsed // 60)
        seconds = int(elapsed % 60)
        return f"{minutes:02d}:{seconds:02d}"

    def _build_display(self) -> Panel:
        """Build the live display panel."""
        # Progress calculation
        step_pct = (self.state.current_step / self.state.total_steps) * 100
        progress_bar = "█" * int(step_pct / 5) + "░" * (20 - int(step_pct / 5))

        lines = []

        # Step info
        step_line = f"[bold cyan]Step {self.state.current_step}/{self.state.total_steps}[/bold cyan] {self.state.step_name}"
        lines.append(step_line)

        # Progress bar
        lines.append(f"[green]{progress_bar}[/green] {step_pct:.0f}%")

        # Stats line
        elapsed = self._format_elapsed()
        stats = f"⏱️ {elapsed}"

        if self.state.word_count_before > 0:
            stats += f"  |  📝 {self.state.word_count_before:,} words"
            if self.state.word_count_after > 0:
                delta = self.state.word_count_after - self.state.word_count_before
                delta_sign = "+" if delta >= 0 else ""
                stats += f" → {self.state.word_count_after:,} ({delta_sign}{delta})"

        if self.state.score_before is not None:
            stats += f"  |  ⭐ {self.state.score_before:.1f}%"
            if self.state.score_after is not None:
                delta = self.state.score_after - self.state.score_before
                delta_sign = "+" if delta >= 0 else ""
                color = "green" if delta >= 0 else "red"
                stats += f" → [{color}]{self.state.score_after:.1f}% ({delta_sign}{delta:.1f})[/{color}]"

        lines.append(f"[dim]{stats}[/dim]")

        # Token preview during step 2 (Gemini revision)
        if self.state.current_step == 2 and self.state.token_buffer:
            # Show last 60 chars of generated text
            preview = self.state.token_buffer[-60:].replace('\n', ' ')
            if len(self.state.token_buffer) > 60:
                preview = "..." + preview
            lines.append(f"[dim italic]› {preview}[/dim italic]")

        # Status
        if self.state.error:
            lines.append(f"[bold red]Error: {self.state.error}[/bold red]")
        elif self.state.is_complete:
            lines.append("[bold green]✓ Revision complete![/bold green]")
        elif self.state.current_step == 2 and self.state.tokens_received > 0:
            lines.append(f"[yellow]› Generating... ({self.state.tokens_received} chunks)[/yellow]")
        else:
            lines.append(f"[yellow]› {self.state.step_name}...[/yellow]")

        content = "\n".join(lines)

        return Panel(
            content,
            title=f"[bold blue]Revising: {self.target_name}[/bold blue]",
            border_style="blue",
            padding=(0, 1),
        )

    def _update_loop(self):
        """Background thread to refresh display."""
        while not self._stop_event.is_set():
            try:
                if self._live:
                    self._live.update(self._build_display())
            except Exception:
                # Silently handle display errors to avoid crashing the main process
                pass
            self._stop_event.wait(0.5)  # Update every 0.5 seconds

    def start(self):
        """Start the live streaming display."""
        self.state.start_time = time.time()
        self._stop_event.clear()

        self._live = Live(
            self._build_display(),
            console=self.console,
            refresh_per_second=2,
            transient=False,
        )
        self._live.start()

        self._update_thread = threading.Thread(
            target=self._update_loop,
            daemon=True,
            name="revision-streamer",
        )
        self._update_thread.start()

    def stop(self):
        """Stop the streaming display."""
        self._stop_event.set()

        if self._update_thread:
            self._update_thread.join(timeout=2.0)
            self._update_thread = None

        if self._live:
            self._live.update(self._build_display())
            self._live.stop()
            self._live = None

    def set_step(self, step_num: int, step_name: Optional[str] = None):
        """Update current step."""
        self.state.current_step = step_num
        self.state.step_name = step_name or self.STEPS[step_num - 1] if step_num <= len(self.STEPS) else "Processing"
        if self._live:
            self._live.update(self._build_display())

    def set_word_count_before(self, count: int):
        """Set original word count."""
        self.state.word_count_before = count
        if self._live:
            self._live.update(self._build_display())

    def set_word_count_after(self, count: int):
        """Set revised word count."""
        self.state.word_count_after = count
        if self._live:
            self._live.update(self._build_display())

    def set_score_before(self, score: float):
        """Set original quality score."""
        self.state.score_before = score
        if self._live:
            self._live.update(self._build_display())

    def set_score_after(self, score: float):
        """Set revised quality score."""
        self.state.score_after = score
        if self._live:
            self._live.update(self._build_display())

    def set_complete(self):
        """Mark revision as complete."""
        self.state.is_complete = True
        self.state.current_step = self.state.total_steps
        if self._live:
            self._live.update(self._build_display())

    def set_error(self, error: str):
        """Mark an error occurred."""
        self.state.error = error
        if self._live:
            self._live.update(self._build_display())

    def on_token(self, text: str):
        """Handle incoming token from Gemini streaming."""
        self.state.token_buffer += text
        self.state.tokens_received += 1
        # Update word count estimate
        self.state.word_count_after = len(self.state.token_buffer.split())
        # Refresh display (not too often to avoid flicker)
        if self._live and self.state.tokens_received % 5 == 0:
            self._live.update(self._build_display())

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            self.set_error(str(exc_val))
        self.stop()
        return False
