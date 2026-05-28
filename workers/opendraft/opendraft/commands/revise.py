"""Draft revision command."""

import logging
from pathlib import Path

from rich.panel import Panel
from rich.prompt import Confirm

from opendraft.commands.shared import console


def revise_command(argv: list):
    """Revise an existing draft with new instructions."""
    from opendraft.revise import revise_draft
    from opendraft.config import get_config
    from opendraft.streaming import RevisionProgress

    # Parse flags
    skip_confirm = "-y" in argv or "--yes" in argv
    argv = [a for a in argv if a not in ("-y", "--yes")]

    # Parse --section flag
    section_num = None
    if "--section" in argv:
        idx = argv.index("--section")
        if idx + 1 < len(argv):
            try:
                section_num = int(argv[idx + 1])
            except ValueError:
                console.print(f"[red]Error: Invalid section number: {argv[idx + 1]}[/red]")
                return
            argv = argv[:idx] + argv[idx + 2:]
        else:
            console.print("[red]Error: --section requires a number[/red]")
            return

    # Parse --reject-regression flag
    reject_regression = None
    if "--reject-regression" in argv:
        idx = argv.index("--reject-regression")
        if idx + 1 < len(argv):
            try:
                reject_regression = float(argv[idx + 1])
            except ValueError:
                console.print(f"[red]Error: Invalid threshold: {argv[idx + 1]}[/red]")
                return
            argv = argv[:idx] + argv[idx + 2:]
        else:
            console.print("[red]Error: --reject-regression requires a percentage (e.g., 5.0)[/red]")
            return

    if len(argv) < 2:
        console.print("[red]Error: Missing arguments[/red]")
        console.print("[dim]Usage: opendraft revise <folder_or_file> \"instructions\" [-y] [--section N] [--reject-regression N][/dim]")
        console.print("[dim]Example: opendraft revise /tmp/opendraft_123 \"make it shorter\"[/dim]")
        console.print("[dim]Example: opendraft revise /tmp/opendraft_123 \"fix methodology\" --section 3[/dim]")
        console.print("[dim]Example: opendraft revise /tmp/opendraft_123 \"edit\" --reject-regression 5.0[/dim]")
        return

    target = Path(argv[0])
    instructions = " ".join(argv[1:])

    if not target.exists():
        console.print(f"[red]Error: {target} not found[/red]")
        return

    config = get_config()
    from opendraft.cli import setup_logging
    setup_logging(config.log_level)

    section_info = f"\n[dim]Section: {section_num}[/dim]" if section_num else ""
    console.print(Panel.fit(
        f"[bold blue]Revising Draft[/bold blue]\n"
        f"[dim]Target: {target}[/dim]{section_info}\n"
        f"[dim]Instructions: {instructions[:50]}{'...' if len(instructions) > 50 else ''}[/dim]",
        border_style="blue",
    ))

    if not skip_confirm and not Confirm.ask("Proceed with revision?", default=True):
        return

    target_name = target.name if target.is_file() else target.stem
    if section_num:
        target_name = f"{target_name} (§{section_num})"
    streamer = RevisionProgress(target_name)

    def on_step(step_num: int, step_name: str, data: dict):
        streamer.set_step(step_num, step_name)
        if 'word_count' in data:
            if step_num == 1:
                streamer.set_word_count_before(data['word_count'])
            else:
                streamer.set_word_count_after(data['word_count'])
        if 'score' in data:
            if step_num == 1:
                streamer.set_score_before(data['score'])
            elif step_num == 3:
                streamer.set_score_after(data['score'])

    try:
        with streamer:
            result = revise_draft(
                target, instructions,
                on_step=on_step,
                on_token=streamer.on_token,
                section=section_num,
                reject_regression=reject_regression,
            )
            streamer.set_complete()

        delta = result['delta']
        delta_color = "green" if delta >= 0 else "red"
        delta_sign = "+" if delta >= 0 else ""

        console.print(f"\n[bold]Quality:[/bold] {result['score_before']:.1f}% → {result['score_after']:.1f}% ([{delta_color}]{delta_sign}{delta:.1f}%[/{delta_color}])")
        console.print(f"[bold]Words:[/bold] {result['word_count']:,}")

        improvements = result.get('improvements', [])
        regressions = result.get('regressions', [])

        if improvements or regressions:
            console.print("\n[bold]Component changes:[/bold]")
            for imp in improvements:
                console.print(f"  [green]↑ {imp['metric']}: +{imp['delta']:.1f}%[/green]")
            for reg in regressions:
                console.print(f"  [red]↓ {reg['metric']}: {reg['delta']:.1f}%[/red]")

        console.print("\n[bold]Output files:[/bold]")
        console.print(f"  MD:   {result['md_path']}")
        if result['pdf_path']:
            console.print(f"  PDF:  {result['pdf_path']}")
        if result['docx_path']:
            console.print(f"  DOCX: {result['docx_path']}")

        if delta < -5:
            console.print("\n[yellow]Warning: Quality dropped significantly. Review the changes.[/yellow]")

    except FileNotFoundError as e:
        console.print(f"[red]Error: {e}[/red]")
    except Exception as e:
        console.print(f"[bold red]Error:[/bold red] {e}")
        logging.exception("Revision failed")
