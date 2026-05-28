"""Qualitative analysis command."""

import sys
import logging
from pathlib import Path
from typing import Optional

from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.prompt import Confirm
from rich.table import Table

from opendraft.commands.shared import console


def analyze_command(
    input_path: str,
    text_column: Optional[str] = None,
    id_column: Optional[str] = None,
    output_dir: Optional[str] = None,
    coding_instructions: Optional[str] = None,
):
    """Run qualitative analysis on interview/survey data."""
    from opendraft.qualitative import QualitativePipeline, QualitativeExporter

    input_path = Path(input_path)

    if not input_path.exists():
        console.print(f"[red]Error: {input_path} not found[/red]")
        sys.exit(1)

    # Determine workspace
    if output_dir:
        workspace = Path(output_dir)
    else:
        workspace = Path("qualitative_workspace")

    workspace.mkdir(parents=True, exist_ok=True)

    console.print(Panel.fit(
        "[bold blue]OpenDraft Qualitative Analysis[/bold blue]\n"
        "AI-powered coding, analysis, and synthesis",
        border_style="blue",
    ))

    # Handle directory of files
    if input_path.is_dir():
        files = list(input_path.glob("*.csv")) + list(input_path.glob("*.xlsx"))
        if not files:
            console.print(f"[red]No CSV or Excel files found in {input_path}[/red]")
            sys.exit(1)
        console.print(f"[dim]Found {len(files)} files in {input_path}[/dim]")
        input_file = files[0]
        console.print(f"[dim]Processing: {input_file.name}[/dim]")
    else:
        input_file = input_path

    # Copy input file to workspace
    import shutil
    dest_file = workspace / input_file.name
    if input_file.resolve() != dest_file.resolve():
        shutil.copy2(input_file, dest_file)

    # Auto-detect text column if not specified
    if not text_column:
        import pandas as pd
        if input_file.suffix == '.csv':
            df = pd.read_csv(input_file, nrows=5)
        else:
            df = pd.read_excel(input_file, nrows=5)

        text_candidates = ['text', 'transcript', 'response', 'content', 'answer', 'comment']
        for col in df.columns:
            if col.lower() in text_candidates:
                text_column = col
                break

        if not text_column:
            for col in df.columns:
                if df[col].dtype == 'object' and df[col].str.len().mean() > 50:
                    text_column = col
                    break

        if not text_column:
            console.print("[red]Could not auto-detect text column. Please specify --text-column[/red]")
            console.print(f"[dim]Available columns: {list(df.columns)}[/dim]")
            sys.exit(1)

        console.print(f"[dim]Auto-detected text column: {text_column}[/dim]")

    console.print(f"\n[dim]Input: {input_file.name}[/dim]")
    console.print(f"[dim]Text column: {text_column}[/dim]")
    console.print(f"[dim]ID column: {id_column or 'auto-generated'}[/dim]")
    console.print(f"[dim]Workspace: {workspace.absolute()}[/dim]\n")

    if not Confirm.ask("Start qualitative analysis?", default=True):
        sys.exit(0)

    pipeline = QualitativePipeline(workspace)

    try:
        # Phase 1: Import
        with console.status("[bold green]Importing data...[/bold green]"):
            df = pipeline.import_data(
                input_file.name,
                text_column=text_column,
                id_column=id_column,
            )
        console.print(f"[green]✓[/green] Imported {len(df)} documents")

        # Phase 2: Coding
        console.print("\n[bold]Phase 2: Coding[/bold]")
        console.print("[dim]AI is reading and coding your data...[/dim]")

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Coding documents...", total=None)
            result = pipeline.run_coding(coding_instructions)
            progress.update(task, completed=True)

        console.print(f"[green]✓[/green] Created {result['codes_created']} codes, {result['segments_coded']} coded segments")

        # Phase 3: Analysis
        console.print("\n[bold]Phase 3: Analysis[/bold]")
        console.print("[dim]Identifying patterns and themes...[/dim]")

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Analyzing patterns...", total=None)
            analysis = pipeline.run_analysis()
            progress.update(task, completed=True)

        console.print(f"[green]✓[/green] Analysis complete ({analysis['iterations']} iterations)")

        # Phase 4: Synthesis
        console.print("\n[bold]Phase 4: Synthesis[/bold]")
        console.print("[dim]Writing findings narrative...[/dim]")

        with Progress(
            SpinnerColumn(),
            TextColumn("[progress.description]{task.description}"),
            console=console,
        ) as progress:
            task = progress.add_task("Synthesizing findings...", total=None)
            pipeline.run_synthesis()
            progress.update(task, completed=True)

        console.print("[green]✓[/green] Synthesis complete")

        # Export results
        console.print("\n[bold]Exporting results...[/bold]")
        exporter = QualitativeExporter(pipeline.state.code_db, workspace)
        exporter.export_full_analysis("analysis_results")

        # Summary
        console.print(Panel.fit(
            "[bold green]Analysis Complete![/bold green]",
            border_style="green",
        ))

        table = Table(title="Output Files", show_header=True)
        table.add_column("File", style="cyan")
        table.add_column("Description")

        table.add_row("findings.md", "Narrative synthesis of findings")
        table.add_row("analysis_results_codebook.xlsx", "Codebook with definitions")
        table.add_row("analysis_results_segments.xlsx", "All coded segments")
        table.add_row("analysis_results_cooccurrence.xlsx", "Code co-occurrence matrix")
        table.add_row("analysis_results_summary.xlsx", "Summary statistics")

        console.print(table)
        console.print(f"\n[dim]All files saved to: {workspace.absolute()}[/dim]")

    except KeyboardInterrupt:
        console.print("\n[yellow]Analysis interrupted by user.[/yellow]")
        sys.exit(0)
    except Exception as e:
        console.print(f"\n[bold red]Error:[/bold red] {e}")
        logging.exception("Analysis failed")
        sys.exit(1)
