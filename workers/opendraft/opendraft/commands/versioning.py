"""Version management commands: versions, diff, history, rollback."""

import json
import re
from datetime import datetime
from pathlib import Path

from rich.panel import Panel
from rich.table import Table

from opendraft.commands.shared import console


def versions_command(argv: list):
    """Show all versions of a draft in an output folder."""
    from opendraft.analytics import score_draft

    if not argv:
        console.print("[red]Error: Missing folder path[/red]")
        console.print("[dim]Usage: opendraft versions <folder>[/dim]")
        return

    folder = Path(argv[0])
    if not folder.exists():
        console.print(f"[red]Error: Folder not found: {folder}[/red]")
        return

    exports = folder / "exports" if (folder / "exports").exists() else folder

    versions = []
    for md_file in sorted(exports.glob("*_v*.md")):
        match = re.search(r'_v(\d+)\.md$', md_file.name)
        if match:
            version_num = int(match.group(1))
            stat = md_file.stat()
            text = md_file.read_text(encoding='utf-8')
            word_count = len(text.split())

            try:
                score = score_draft(text)['overall_score']
            except Exception:
                score = None

            versions.append({
                'version': version_num,
                'file': md_file,
                'modified': datetime.fromtimestamp(stat.st_mtime),
                'words': word_count,
                'score': score,
                'has_pdf': md_file.with_suffix('.pdf').exists(),
                'has_docx': md_file.with_suffix('.docx').exists(),
            })

    if not versions:
        console.print(f"[yellow]No versions found in {folder}[/yellow]")
        return

    versions.sort(key=lambda v: v['version'])

    table = Table(title=f"Versions in {folder.name}")
    table.add_column("Ver", style="cyan", justify="right")
    table.add_column("Modified", style="dim")
    table.add_column("Words", justify="right")
    table.add_column("Quality", justify="right")
    table.add_column("Exports")

    for v in versions:
        exports_list = []
        if v['has_pdf']:
            exports_list.append("PDF")
        if v['has_docx']:
            exports_list.append("DOCX")

        score_str = f"{v['score']:.1f}%" if v['score'] else "-"
        score_style = "green" if v['score'] and v['score'] >= 85 else "yellow" if v['score'] else ""

        table.add_row(
            f"v{v['version']}",
            v['modified'].strftime("%Y-%m-%d %H:%M"),
            f"{v['words']:,}",
            f"[{score_style}]{score_str}[/{score_style}]" if score_style else score_str,
            ", ".join(exports_list) or "-",
        )

    console.print(table)
    console.print(f"\n[dim]Use 'opendraft rollback {folder} v<N>' to restore a version[/dim]")
    console.print(f"[dim]Use 'opendraft diff {folder} [v<A>] [v<B>]' to compare versions[/dim]")


def diff_command(argv: list):
    """Show diff between two versions of a draft."""
    from opendraft.revise import diff_versions

    if not argv:
        console.print("[red]Error: Missing folder path[/red]")
        console.print("[dim]Usage: opendraft diff <folder> [v<A>] [v<B>][/dim]")
        console.print("[dim]Example: opendraft diff ./output v2 v3[/dim]")
        console.print("[dim]Default: compare last two versions[/dim]")
        return

    folder = Path(argv[0])
    if not folder.exists():
        console.print(f"[red]Error: Folder not found: {folder}[/red]")
        return

    version_a = argv[1] if len(argv) > 1 else None
    version_b = argv[2] if len(argv) > 2 else None

    try:
        result = diff_versions(folder, version_a, version_b)
    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
        return

    console.print(Panel.fit(
        f"[bold]Diff: {result['version_a']} → {result['version_b']}[/bold]\n"
        f"[green]+{result['lines_added']} lines added[/green]  "
        f"[red]-{result['lines_removed']} lines removed[/red]",
        title="Version Comparison",
        border_style="blue",
    ))

    if result['diff_text']:
        diff_lines = []
        for line in result['diff_text'].split('\n'):
            if line.startswith('+') and not line.startswith('+++'):
                diff_lines.append(f"[green]{line}[/green]")
            elif line.startswith('-') and not line.startswith('---'):
                diff_lines.append(f"[red]{line}[/red]")
            elif line.startswith('@@'):
                diff_lines.append(f"[cyan]{line}[/cyan]")
            else:
                diff_lines.append(line)

        console.print('\n'.join(diff_lines[:100]))

        if len(result['diff_text'].split('\n')) > 100:
            console.print(f"\n[dim]... ({len(result['diff_text'].split(chr(10))) - 100} more lines)[/dim]")
    else:
        console.print("[yellow]No differences found[/yellow]")


def history_command(argv: list):
    """Show revision history for a folder."""
    if not argv:
        console.print("[red]Error: Missing folder path[/red]")
        console.print("[dim]Usage: opendraft history <folder>[/dim]")
        return

    folder = Path(argv[0])
    exports = folder / "exports" if (folder / "exports").exists() else folder
    history_path = exports / "revision_history.json"

    if not history_path.exists():
        console.print(f"[yellow]No revision history found in {folder}[/yellow]")
        console.print("[dim]History is created when you use 'opendraft revise'[/dim]")
        return

    try:
        history = json.loads(history_path.read_text())
    except Exception as e:
        console.print(f"[red]Error reading history: {e}[/red]")
        return

    revisions = history.get("revisions", [])
    if not revisions:
        console.print("[yellow]No revisions recorded[/yellow]")
        return

    console.print(Panel.fit(
        f"[bold]Revision History[/bold]\n{len(revisions)} revision(s)",
        title=folder.name,
        border_style="blue",
    ))

    for rev in revisions:
        delta = rev.get('delta', 0)
        delta_style = "green" if delta > 0 else "red" if delta < 0 else "dim"
        section_note = f" [section {rev['section']}]" if rev.get('section') else ""

        console.print(f"\n[bold cyan]{rev['version']}[/bold cyan]{section_note}")
        console.print(f"  [dim]{rev['timestamp'][:19]}[/dim]")
        console.print(f"  Quality: {rev['score_before']:.1f}% → {rev['score_after']:.1f}% [{delta_style}]{delta:+.1f}%[/{delta_style}]")
        console.print(f"  [italic]\"{rev['instructions'][:60]}{'...' if len(rev['instructions']) > 60 else ''}\"[/italic]")


def rollback_command(argv: list):
    """Rollback to a previous version of a draft."""
    from opendraft.export.pdf import export_pdf
    from opendraft.export.docx import export_docx

    if len(argv) < 2:
        console.print("[red]Error: Missing folder and version[/red]")
        console.print("[dim]Usage: opendraft rollback <folder> v<N>[/dim]")
        console.print("[dim]Example: opendraft rollback ./output v3[/dim]")
        return

    folder = Path(argv[0])
    target_version = argv[1].lower()

    if not folder.exists():
        console.print(f"[red]Error: Folder not found: {folder}[/red]")
        return

    if not target_version.startswith('v') or not target_version[1:].isdigit():
        console.print(f"[red]Error: Invalid version format: {target_version}[/red]")
        console.print("[dim]Use format: v2, v3, v4, etc.[/dim]")
        return

    exports = folder / "exports" if (folder / "exports").exists() else folder

    target_file = None
    for md_file in exports.glob(f"*_{target_version}.md"):
        target_file = md_file
        break

    if not target_file:
        console.print(f"[red]Error: Version {target_version} not found[/red]")
        console.print("[dim]Use 'opendraft versions <folder>' to see available versions[/dim]")
        return

    existing_versions = []
    for md_file in exports.glob("*_v*.md"):
        match = re.search(r'_v(\d+)\.md$', md_file.name)
        if match:
            existing_versions.append(int(match.group(1)))

    next_version = max(existing_versions) + 1 if existing_versions else 2
    next_suffix = f"v{next_version}"

    base_name = re.sub(r'_v\d+$', '', target_file.stem)
    new_md = exports / f"{base_name}_{next_suffix}.md"
    new_pdf = exports / f"{base_name}_{next_suffix}.pdf"
    new_docx = exports / f"{base_name}_{next_suffix}.docx"

    content = target_file.read_text(encoding='utf-8')
    new_md.write_text(content, encoding='utf-8')

    console.print(f"[green]✓[/green] Rolled back {target_version} → {next_suffix}")
    console.print(f"  Created: {new_md.name}")

    title = base_name.replace("_", " ").title()
    if export_pdf(new_md, new_pdf, title=title):
        console.print(f"  Created: {new_pdf.name}")
    if export_docx(new_md, new_docx, title=title):
        console.print(f"  Created: {new_docx.name}")

    console.print(f"\n[dim]Rollback complete. {target_version} content is now {next_suffix}[/dim]")
