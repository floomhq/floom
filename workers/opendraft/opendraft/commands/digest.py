"""Audio digest command."""

import sys
import logging
from pathlib import Path

from rich.panel import Panel

from opendraft.commands.shared import console


def digest_command(argv: list[str]):
    """Generate 60-second audio digest for any document."""
    import argparse

    parser = argparse.ArgumentParser(
        prog="opendraft digest",
        description="Generate 60-second audio digest for any paper or document"
    )
    parser.add_argument("document", help="Path to document (PDF, MD, or TXT)")
    parser.add_argument("--output", "-o", help="Output directory (default: same as document)")
    parser.add_argument(
        "--voice",
        default="rachel",
        choices=["rachel", "adam", "josh", "elli", "bella"],
        help="ElevenLabs voice (default: rachel)"
    )
    parser.add_argument(
        "--no-audio",
        action="store_true",
        help="Skip audio generation (script only)"
    )
    parser.add_argument(
        "--model",
        default="gemini-3-flash-preview",
        help="Model for script generation (default: gemini-3-flash-preview)"
    )

    args = parser.parse_args(argv)
    document_path = Path(args.document)

    if not document_path.exists():
        console.print(f"[red]Error: File not found: {document_path}[/red]")
        sys.exit(1)

    console.print(Panel.fit(
        "[bold blue]OpenDraft Digest[/bold blue]\n"
        "60-second audio briefing generator",
        border_style="blue",
    ))

    console.print(f"[dim]Document: {document_path.name}[/dim]")
    console.print(f"[dim]Voice: {args.voice}[/dim]")
    console.print(f"[dim]Model: {args.model}[/dim]\n")

    from opendraft.agents.digest import generate_digest
    from opendraft.utils.document_reader import get_document_info

    try:
        info = get_document_info(document_path)
        console.print(f"[dim]Words: {info['word_count']:,} | Type: {info['type']}[/dim]\n")
    except Exception as e:
        console.print(f"[yellow]Could not get document info: {e}[/yellow]\n")

    output_dir = Path(args.output) if args.output else None

    with console.status("[bold green]Generating digest script...[/bold green]"):
        try:
            result = generate_digest(
                document_path,
                output_dir=output_dir,
                voice=args.voice,
                model_name=args.model,
                generate_audio=not args.no_audio,
            )
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            logging.exception("Digest generation failed")
            sys.exit(1)

    console.print(Panel(result["script"], title="Digest Script", border_style="green"))
    console.print(f"\n[dim]Word count: {result['word_count']} words[/dim]")
    console.print(f"[green]Script saved: {result['script_path']}[/green]")

    if "audio_path" in result:
        console.print(f"[green]Audio saved: {result['audio_path']}[/green]")
    elif "audio_error" in result:
        console.print(f"[yellow]Audio skipped: {result['audio_error']}[/yellow]")
        console.print("[dim]Set ELEVENLABS_API_KEY to enable audio generation[/dim]")

    cost = result.get("cost", {})
    if cost:
        console.print(f"[dim]Cost: ${cost.get('total_cost_usd', 0):.4f}[/dim]")
