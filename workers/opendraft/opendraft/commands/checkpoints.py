"""Checkpoint management command."""

from typing import Optional

from rich.panel import Panel
from rich.table import Table

from opendraft.commands.shared import console


def checkpoints_command(action: str = "list", run_id: Optional[str] = None):
    """Manage pipeline checkpoints."""
    from opendraft.orchestrator.checkpoint import CheckpointManager

    manager = CheckpointManager()

    if action == "list":
        checkpoints = manager.list_checkpoints()
        if not checkpoints:
            console.print("[yellow]No checkpoints found.[/yellow]")
            console.print("[dim]Checkpoints are created automatically during draft generation.[/dim]")
            return

        console.print(Panel.fit(
            "[bold blue]Pipeline Checkpoints[/bold blue]",
            border_style="blue",
        ))

        table = Table(show_header=True, header_style="bold")
        table.add_column("Run ID", style="cyan", max_width=25)
        table.add_column("Topic", max_width=30)
        table.add_column("Phase", style="yellow")
        table.add_column("Completed", style="green")
        table.add_column("Timestamp", style="dim")

        for cp in checkpoints[:20]:
            completed = ", ".join(cp.get("completed_phases", [])[-3:])
            if len(cp.get("completed_phases", [])) > 3:
                completed = "... " + completed
            table.add_row(
                cp["run_id"][:25],
                (cp["topic"][:27] + "...") if len(cp["topic"]) > 30 else cp["topic"],
                cp["current_phase"],
                completed or "-",
                cp["timestamp"][:19] if cp["timestamp"] else "-",
            )

        console.print(table)
        console.print(f"\n[dim]Total: {len(checkpoints)} checkpoint(s)[/dim]")
        console.print("[dim]Resume with: opendraft --resume <run_id>[/dim]")

    elif action == "delete":
        if not run_id:
            console.print("[red]Error: run_id required for delete action[/red]")
            console.print("[dim]Usage: opendraft checkpoints delete <run_id>[/dim]")
            return
        if manager.delete(run_id):
            console.print(f"[green]Deleted checkpoint: {run_id}[/green]")
        else:
            console.print(f"[yellow]Checkpoint not found: {run_id}[/yellow]")

    elif action == "cleanup":
        deleted = manager.cleanup_old_checkpoints(max_age_days=7, keep_count=10)
        console.print(f"[green]Cleaned up {deleted} old checkpoint(s)[/green]")

    else:
        console.print(f"[red]Unknown action: {action}[/red]")
        console.print("[dim]Valid actions: list, delete, cleanup[/dim]")
