"""Interactive CLI for OpenDraft v3."""

import sys
import argparse
import logging
from pathlib import Path
from typing import Optional

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt, Confirm

console = Console()

STYLE_MAP = {
    "apa": "APA 7th",
    "apa 7th": "APA 7th",
    "ieee": "IEEE",
    "chicago": "Chicago",
    "mla": "MLA",
}
LANGUAGE_CHOICES = {
    "english", "german", "spanish", "french", "italian", "portuguese",
    "dutch", "polish", "russian", "chinese", "japanese", "korean",
    "arabic", "turkish", "swedish", "danish", "norwegian", "finnish",
    "greek", "czech", "hungarian", "romanian", "ukrainian", "hebrew",
    "thai", "vietnamese", "indonesian", "malay", "hindi", "bengali",
}


def _normalize_citation_style(value: str) -> str:
    """Normalize citation style input from CLI flags."""
    key = value.strip().lower()
    if key not in STYLE_MAP:
        valid = ", ".join(sorted(STYLE_MAP.keys()))
        raise argparse.ArgumentTypeError(f"invalid citation style {value!r}; valid values: {valid}")
    return STYLE_MAP[key]


def _normalize_language(value: str) -> str:
    """Normalize language input from CLI flags."""
    language = value.strip().lower()
    if language not in LANGUAGE_CHOICES:
        valid = ", ".join(sorted(LANGUAGE_CHOICES))
        raise argparse.ArgumentTypeError(f"invalid language {value!r}; valid values: {valid}")
    return language


def _parse_generate_args(argv: list[str]) -> argparse.Namespace:
    """Parse direct draft-generation CLI arguments."""
    parser = argparse.ArgumentParser(
        prog="opendraft",
        description="Generate an academic draft",
    )
    parser.add_argument("topic", help="Research topic")
    parser.add_argument(
        "--citation-style",
        type=_normalize_citation_style,
        help="Citation style (apa, ieee, chicago, mla)",
    )
    parser.add_argument(
        "--language",
        type=_normalize_language,
        help="Draft language (english, german, spanish, french)",
    )
    parser.add_argument(
        "--workspace",
        default="workspace",
        help="Workspace directory (default: workspace)",
    )
    parser.add_argument(
        "-y", "--yes",
        action="store_true",
        help="Skip confirmation prompt (for non-interactive use)",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        default=True,
        help="Enable streaming progress display (default: on)",
    )
    parser.add_argument(
        "--no-stream",
        action="store_true",
        help="Disable streaming progress display",
    )
    return parser.parse_args(argv)


def setup_logging(level: str = "INFO"):
    """Configure logging for CLI usage."""
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )


def _print_help():
    """Print CLI help message."""
    console.print(Panel.fit(
        "[bold blue]OpenDraft v3[/bold blue]\n"
        "Academic Draft Generation with Quality Analytics",
        border_style="blue",
    ))
    console.print("\n[bold]Usage:[/bold]")
    console.print("  opendraft                    Interactive draft generation")
    console.print("  opendraft <topic>            Direct generation from command line")
    console.print("  opendraft --resume <run_id>  Resume interrupted run")
    console.print("  opendraft revise <folder> \"instructions\"  Revise existing draft")
    console.print("  opendraft versions <folder>  List all versions of a draft")
    console.print("  opendraft diff <folder> [vA] [vB]  Compare two versions")
    console.print("  opendraft rollback <folder> v<N>  Restore previous version")
    console.print("  opendraft history <folder>   Show revision history")
    console.print("  opendraft digest <file>      Generate 60-second audio digest")
    console.print("  opendraft analyze            Qualitative analysis pipeline")
    console.print("  opendraft stats              Quality statistics dashboard")
    console.print("  opendraft checkpoints        List/manage checkpoints")
    console.print("\n[bold]Revise Options:[/bold]")
    console.print("  --section N                  Revise only section N")
    console.print("  -y, --yes                    Skip confirmation")
    console.print("\n[bold]Generate Options:[/bold]")
    console.print("  --stream                     Live progress display (default)")
    console.print("  --no-stream                  Disable streaming progress")
    console.print("  -y, --yes                    Skip confirmation prompt")
    console.print("\n[bold]Examples:[/bold]")
    console.print("  opendraft \"AI in healthcare\" --citation-style IEEE --language english")
    console.print("  opendraft revise /tmp/opendraft_123 \"make conclusion stronger\"")
    console.print("  opendraft digest paper.pdf")
    console.print("  opendraft digest paper.pdf --voice adam -o output/")
    console.print("  opendraft digest paper.pdf --no-audio")
    console.print("  opendraft analyze data.csv --text-column response")
    console.print("  opendraft analyze interviews/ --output results/")
    console.print("  opendraft --resume run_20250209_123456_abc123")
    console.print("  opendraft checkpoints delete run_20250209_123456_abc123")


def _run_generate(topic, citation_style, language, workspace_dir, skip_confirm, use_streaming):
    """Run the draft generation flow."""
    console.print(Panel.fit(
        "[bold blue]OpenDraft v3[/bold blue]\n"
        "Academic Draft Generation with Quality Analytics",
        border_style="blue",
    ))

    # Topic prompt for interactive mode only.
    if topic is None:
        topic = ""
        while not topic:
            topic = Prompt.ask("\n[bold]Topic[/bold]", default="").strip()
            if not topic:
                console.print("[red]Topic cannot be empty. Please try again.[/red]")

    # Prompt missing settings. When --yes is set, use defaults.
    if citation_style is None:
        if skip_confirm:
            citation_style = "APA 7th"
        else:
            citation_style_input = Prompt.ask(
                "[bold]Citation style[/bold]",
                choices=["apa", "ieee", "chicago", "mla"],
                default="apa",
            )
            citation_style = STYLE_MAP[citation_style_input]

    if language is None:
        if skip_confirm:
            language = "english"
        else:
            language = Prompt.ask(
                "[bold]Language[/bold]",
                choices=["english", "german", "spanish", "french"],
                default="english",
            )

    console.print(f"\n[dim]Topic: {topic}[/dim]")
    console.print(f"[dim]Style: {citation_style} | Language: {language}[/dim]")
    console.print(f"[dim]Workspace: {workspace_dir.absolute()}[/dim]\n")

    if not skip_confirm and not Confirm.ask("Start generation?", default=True):
        sys.exit(0)

    from opendraft.config import get_config
    config = get_config()
    setup_logging(config.log_level)

    from opendraft.generate import generate_draft

    if use_streaming:
        from opendraft.streaming import StreamingProgress

        streamer = StreamingProgress(workspace_dir)

        try:
            with streamer:
                final_draft = generate_draft(
                    topic=topic,
                    citation_style=citation_style,
                    language=language,
                    workspace_dir=workspace_dir,
                    on_phase_start=streamer.on_phase_start,
                    on_phase_complete=streamer.on_phase_complete,
                    on_write=streamer.on_write,
                )
                word_count = len(final_draft.split())
                streamer.set_complete(word_count)

            output_path = workspace_dir / "final_draft.md"
            console.print(f"\n[bold]Output:[/bold] {output_path.absolute()}")
            console.print(f"[bold]Words:[/bold] {word_count:,}")

        except KeyboardInterrupt:
            streamer.set_status("Interrupted by user")
            console.print("\n[yellow]Generation interrupted by user.[/yellow]")
            sys.exit(0)
        except ValueError as e:
            streamer.set_error(str(e))
            console.print(f"\n[bold red]Configuration error:[/bold red] {e}")
            sys.exit(1)
        except Exception as e:
            streamer.set_error(str(e))
            console.print(f"\n[bold red]Error:[/bold red] {e}")
            logging.exception("Generation failed")
            sys.exit(1)

    else:
        phase_status = {}

        def on_phase_start(num, total, agent_name, description):
            phase_status["current"] = description
            console.print(f"\n[bold green]Phase {num}/{total}:[/bold green] {description}")

        def on_phase_complete(num, total, agent_name, result):
            signal = result.signal
            if signal == "DONE":
                console.print("  [green]Done[/green]")
            elif signal == "RERUN":
                console.print(f"  [yellow]Rerun requested: {result.rerun_reason}[/yellow]")
            elif signal == "ESCALATE":
                console.print(f"  [red]Escalated: {result.rerun_reason}[/red]")

        try:
            final_draft = generate_draft(
                topic=topic,
                citation_style=citation_style,
                language=language,
                workspace_dir=workspace_dir,
                on_phase_start=on_phase_start,
                on_phase_complete=on_phase_complete,
            )

            output_path = workspace_dir / "final_draft.md"
            console.print("\n[bold green]Draft complete![/bold green]")
            console.print(f"Output: {output_path.absolute()}")

            word_count = len(final_draft.split())
            console.print(f"Word count: {word_count}")

        except KeyboardInterrupt:
            console.print("\n[yellow]Generation interrupted by user.[/yellow]")
            sys.exit(0)
        except ValueError as e:
            console.print(f"\n[bold red]Configuration error:[/bold red] {e}")
            sys.exit(1)
        except Exception as e:
            console.print(f"\n[bold red]Error:[/bold red] {e}")
            logging.exception("Generation failed")
            sys.exit(1)


# Subcommand dispatch table
_SUBCOMMANDS = {
    "stats": lambda argv: __import__("opendraft.commands.stats", fromlist=["stats_command"]).stats_command(),
    "checkpoints": lambda argv: __import__("opendraft.commands.checkpoints", fromlist=["checkpoints_command"]).checkpoints_command(
        argv[0] if argv else "list", argv[1] if len(argv) > 1 else None
    ),
    "revise": lambda argv: __import__("opendraft.commands.revise", fromlist=["revise_command"]).revise_command(argv),
    "versions": lambda argv: __import__("opendraft.commands.versioning", fromlist=["versions_command"]).versions_command(argv),
    "diff": lambda argv: __import__("opendraft.commands.versioning", fromlist=["diff_command"]).diff_command(argv),
    "history": lambda argv: __import__("opendraft.commands.versioning", fromlist=["history_command"]).history_command(argv),
    "rollback": lambda argv: __import__("opendraft.commands.versioning", fromlist=["rollback_command"]).rollback_command(argv),
    "digest": lambda argv: __import__("opendraft.commands.digest", fromlist=["digest_command"]).digest_command(argv),
}


def main():
    topic: Optional[str] = None
    citation_style: Optional[str] = None
    language: Optional[str] = None
    workspace_dir = Path("workspace")
    skip_confirm = False
    use_streaming = True

    if len(sys.argv) > 1:
        subcommand = sys.argv[1]

        # --resume flag
        if subcommand == "--resume":
            if len(sys.argv) < 3:
                console.print("[red]Error: run_id required for --resume[/red]")
                console.print("[dim]Usage: opendraft --resume <run_id>[/dim]")
                return
            from opendraft.commands.resume import resume_command
            resume_command(sys.argv[2])
            return

        # Help
        if subcommand in ("help", "--help", "-h"):
            _print_help()
            return

        # Analyze (has its own arg parser)
        if subcommand == "analyze":
            parser = argparse.ArgumentParser(
                prog="opendraft analyze",
                description="Run qualitative analysis on interview/survey data"
            )
            parser.add_argument("input", help="Input CSV/Excel file or directory")
            parser.add_argument("--text-column", "-t", help="Column containing text to analyze")
            parser.add_argument("--id-column", "-i", help="Column containing document IDs")
            parser.add_argument("--output", "-o", help="Output directory for results")
            parser.add_argument("--coding-instructions", "-c", help="Custom coding instructions")

            args = parser.parse_args(sys.argv[2:])

            from opendraft.commands.analyze import analyze_command
            analyze_command(
                input_path=args.input,
                text_column=args.text_column,
                id_column=args.id_column,
                output_dir=args.output,
                coding_instructions=args.coding_instructions,
            )
            return

        # Dispatch table subcommands
        if subcommand in _SUBCOMMANDS:
            _SUBCOMMANDS[subcommand](sys.argv[2:])
            return

        # Not a known subcommand: treat as direct generation mode.
        args = _parse_generate_args(sys.argv[1:])
        topic = args.topic.strip()
        if not topic:
            console.print("[red]Topic cannot be empty.[/red]")
            return
        citation_style = args.citation_style
        language = args.language
        workspace_dir = Path(args.workspace)
        skip_confirm = args.yes
        use_streaming = args.stream and not args.no_stream

    _run_generate(topic, citation_style, language, workspace_dir, skip_confirm, use_streaming)


if __name__ == "__main__":
    main()
