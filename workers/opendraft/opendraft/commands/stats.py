"""Quality statistics command."""

from rich.panel import Panel
from rich.table import Table

from opendraft.commands.shared import console


def stats_command():
    """Show quality and cost statistics from recent runs."""
    from opendraft.analytics.quality_scorer import RegressionTracker

    tracker = RegressionTracker()
    records = tracker.get_recent(50)

    if not records:
        console.print("[yellow]No run history found.[/yellow]")
        console.print("[dim]Run some drafts first to build history.[/dim]")
        return

    final_records = [r for r in records if r.get('stage') == 'final']

    if not final_records:
        console.print("[yellow]No completed runs found.[/yellow]")
        return

    scores = [r['overall_score'] for r in final_records]
    avg_score = sum(scores) / len(scores)
    min_score = min(scores)
    max_score = max(scores)

    threshold = 85.0
    above_threshold = sum(1 for s in scores if s >= threshold)
    pct_above = (above_threshold / len(scores)) * 100

    if len(scores) >= 4:
        mid = len(scores) // 2
        first_half_avg = sum(scores[:mid]) / mid
        second_half_avg = sum(scores[mid:]) / (len(scores) - mid)
        trend = second_half_avg - first_half_avg
        trend_symbol = "↑" if trend > 0 else "↓" if trend < 0 else "→"
    else:
        trend = 0
        trend_symbol = "→"

    console.print(Panel.fit(
        "[bold blue]OpenDraft V3 Statistics[/bold blue]",
        border_style="blue",
    ))

    table = Table(title="Quality Summary", show_header=True, header_style="bold")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="green")

    table.add_row("Total runs", str(len(final_records)))
    table.add_row("Average score", f"{avg_score:.1f}%")
    table.add_row("Min / Max", f"{min_score:.1f}% / {max_score:.1f}%")
    table.add_row(f"Above {threshold}% gate", f"{above_threshold}/{len(scores)} ({pct_above:.0f}%)")
    table.add_row("Trend", f"{trend_symbol} {trend:+.1f}%")

    console.print(table)

    console.print("\n[bold]Recent Runs:[/bold]")
    recent_table = Table(show_header=True, header_style="bold dim")
    recent_table.add_column("Run ID", style="dim")
    recent_table.add_column("Topic", max_width=40)
    recent_table.add_column("Score", justify="right")
    recent_table.add_column("Gate", justify="center")

    for record in reversed(final_records[-10:]):
        run_id = record.get('run_id', 'N/A')[:20]
        topic = record.get('topic', 'N/A')[:40]
        score = record.get('overall_score', 0)
        gate = "✓" if score >= threshold else "✗"
        score_style = "green" if score >= threshold else "yellow" if score >= 70 else "red"

        recent_table.add_row(
            run_id,
            topic,
            f"[{score_style}]{score:.1f}%[/{score_style}]",
            f"[green]{gate}[/green]" if gate == "✓" else f"[red]{gate}[/red]"
        )

    console.print(recent_table)
