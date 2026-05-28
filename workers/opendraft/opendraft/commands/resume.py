"""Resume interrupted run command."""

import logging

from rich.panel import Panel
from rich.prompt import Confirm

from opendraft.commands.shared import console


def resume_command(run_id: str):
    """Resume an interrupted draft generation from checkpoint."""
    from opendraft.orchestrator.engine import Orchestrator
    from opendraft.config import get_config
    from opendraft.streaming import StreamingProgress

    config = get_config()
    from opendraft.cli import setup_logging
    setup_logging(config.log_level)

    console.print(Panel.fit(
        f"[bold blue]Resuming Run: {run_id}[/bold blue]",
        border_style="blue",
    ))

    orchestrator = Orchestrator.resume_from_checkpoint(run_id=run_id)

    if not orchestrator:
        console.print(f"[red]No checkpoint found for: {run_id}[/red]")
        console.print("[dim]Use 'opendraft checkpoints' to list available checkpoints.[/dim]")
        return

    completed_count = len(orchestrator.completed_phases)
    console.print(f"[dim]Completed phases: {', '.join(orchestrator.completed_phases) or 'none'}[/dim]")
    console.print(f"[dim]Workspace: {orchestrator.state.workspace_dir}[/dim]")

    if not Confirm.ask("Continue generation?", default=True):
        return

    streamer = StreamingProgress(orchestrator.state.workspace_dir)

    streamer.state.current_phase = completed_count
    streamer.state.status = f"Resuming from phase {completed_count + 1}"

    orchestrator.on_phase_start = streamer.on_phase_start
    orchestrator.on_phase_complete = streamer.on_phase_complete
    orchestrator.on_write = streamer.on_write

    try:
        with streamer:
            final_draft = orchestrator.run()
            word_count = len(final_draft.split())
            streamer.set_complete(word_count)

        output_path = orchestrator.state.workspace_dir / "final_draft.md"
        console.print(f"\n[bold]Output:[/bold] {output_path.absolute()}")
        console.print(f"[bold]Words:[/bold] {word_count:,}")

    except KeyboardInterrupt:
        streamer.set_status("Interrupted by user")
        console.print("\n[yellow]Generation interrupted by user.[/yellow]")
        console.print(f"[dim]Checkpoint saved. Resume with: opendraft --resume {run_id}[/dim]")
    except Exception as e:
        streamer.set_error(str(e))
        console.print(f"\n[bold red]Error:[/bold red] {e}")
        logging.exception("Generation failed")
        console.print(f"[dim]Checkpoint saved. Resume with: opendraft --resume {run_id}[/dim]")
