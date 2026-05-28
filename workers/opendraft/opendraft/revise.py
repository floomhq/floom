"""Revision module for OpenDraft v3.

Allows revising existing drafts with specific instructions.
"""

import logging
from pathlib import Path
from typing import Optional
from datetime import datetime

from google import genai

from opendraft.config import get_config
from opendraft.export.pdf import export_pdf
from opendraft.export.docx import export_docx

logger = logging.getLogger(__name__)


def _is_safe_file(path: Path, base_folder: Path) -> bool:
    """Check if file is safe (not a symlink escaping the folder)."""
    try:
        resolved = path.resolve()
        base_resolved = base_folder.resolve()
        # Ensure resolved path is within base folder
        return str(resolved).startswith(str(base_resolved))
    except (OSError, ValueError):
        return False


def find_draft_in_folder(folder: Path) -> Optional[Path]:
    """Find the main draft markdown file in an output folder."""
    folder = folder.resolve()

    # Check exports/ subfolder first (standard location)
    exports_dir = folder / "exports"
    if exports_dir.exists():
        # Priority: named export > final_draft > largest non-intermediate file
        md_files = [f for f in exports_dir.glob("*.md") if _is_safe_file(f, folder)]

        # Filter out intermediate/temp files and hidden files
        export_files = [f for f in md_files if not any(
            x in f.name.lower() for x in ['intermediate', 'abstract', 'temp', '_generated']
        ) and not f.name.startswith(('_', '.')) and not f.is_symlink()]

        if export_files:
            # Prefer final_draft.md if it exists
            for f in export_files:
                if 'final_draft' in f.name.lower():
                    return f
            # Otherwise return the largest export file
            return max(export_files, key=lambda p: p.stat().st_size)

        # Fallback to any MD file (excluding numbered/hidden files)
        non_numbered = [f for f in md_files
                        if not f.name[0].isdigit()
                        and not f.name.startswith(('.', '_'))
                        and not f.is_symlink()]
        if non_numbered:
            return max(non_numbered, key=lambda p: p.stat().st_size)

    # Check drafts/ subfolder
    drafts_dir = folder / "drafts"
    if drafts_dir.exists():
        md_files = [f for f in drafts_dir.glob("*.md")
                    if _is_safe_file(f, folder) and not f.is_symlink()
                    and not f.name.startswith(('.', '_'))]
        if md_files:
            return max(md_files, key=lambda p: p.stat().st_size)

    # Fallback to root folder
    for name in ["final_draft.md", "draft.md"]:
        candidate = folder / name
        if candidate.exists() and _is_safe_file(candidate, folder) and not candidate.is_symlink():
            return candidate

    # Last resort: largest MD in root (excluding hidden/symlinks)
    md_files = [f for f in folder.glob("*.md")
                if _is_safe_file(f, folder) and not f.is_symlink()
                and not f.name.startswith(('.', '_'))]
    if md_files:
        return max(md_files, key=lambda p: p.stat().st_size)

    return None


def call_gemini_revise(
    draft: str,
    instructions: str,
    model: str = "gemini-3-pro-preview",
    on_token: callable = None,  # Callback for streaming tokens
) -> str:
    """
    Call Gemini to revise a draft based on instructions.

    Args:
        draft: The current draft text
        instructions: Revision instructions from user
        model: Gemini model to use
        on_token: Optional callback for streaming tokens (on_token(text_chunk))

    Returns:
        Revised draft text
    """
    config = get_config()
    client = genai.Client(api_key=config.google_api_key)

    prompt = f"""You are an academic writing expert. Revise the following draft based on the user's instructions.

## REVISION INSTRUCTIONS
{instructions}

## IMPORTANT RULES
1. Return the COMPLETE revised draft, not just the changed parts
2. Maintain the same overall structure unless instructed otherwise
3. Preserve all citations ({{cite_XXX}} references)
4. Keep the academic tone and formatting
5. Do NOT add commentary or explanations - just return the revised draft

## CURRENT DRAFT
{draft}

## YOUR TASK
Return the complete revised draft below:
"""

    logger.info("Calling %s for revision...", model)

    if on_token:
        # Streaming mode
        chunks = []
        for chunk in client.models.generate_content_stream(
            model=model,
            contents=prompt,
        ):
            if chunk.text:
                chunks.append(chunk.text)
                on_token(chunk.text)
        revised = "".join(chunks).strip()
    else:
        # Non-streaming mode
        response = client.models.generate_content(
            model=model,
            contents=prompt,
        )
        revised = response.text.strip()

    # Clean up any markdown code blocks if Gemini wrapped the response
    if revised.startswith("```markdown"):
        revised = revised[len("```markdown"):].strip()
    if revised.startswith("```"):
        revised = revised[3:].strip()
    if revised.endswith("```"):
        revised = revised[:-3].strip()

    return revised


def _get_next_version(folder: Path, base_name: str) -> str:
    """Find the next available version suffix (v2, v3, v4, ...)."""
    version = 2
    while True:
        suffix = f"v{version}"
        if not (folder / f"{base_name}_{suffix}.md").exists():
            return suffix
        version += 1
        if version > 99:  # Safety limit
            return f"v{version}"


def diff_versions(folder: Path, version_a: str = None, version_b: str = None) -> dict:
    """Generate diff between two versions of a draft.

    Args:
        folder: Output folder containing versions
        version_a: First version (default: previous version)
        version_b: Second version (default: latest version)

    Returns:
        Dict with diff info: lines_added, lines_removed, diff_text
    """
    import difflib

    folder = Path(folder).resolve()
    exports = folder / "exports" if (folder / "exports").exists() else folder

    # Find all versions
    versions = sorted([f for f in exports.glob("*_v*.md")], key=lambda p: p.stem)

    if len(versions) < 2:
        raise ValueError("Need at least 2 versions to diff")

    # Default: compare last two versions
    if version_b is None:
        file_b = versions[-1]
        version_b = file_b.stem.split('_')[-1]
    else:
        matches = [f for f in versions if f.stem.endswith(f"_{version_b}")]
        if not matches:
            raise ValueError(f"Version {version_b} not found")
        file_b = matches[0]

    if version_a is None:
        file_a = versions[-2] if len(versions) > 1 else versions[0]
        version_a = file_a.stem.split('_')[-1]
    else:
        matches = [f for f in versions if f.stem.endswith(f"_{version_a}")]
        if not matches:
            raise ValueError(f"Version {version_a} not found")
        file_a = matches[0]

    # Read files
    text_a = file_a.read_text(encoding='utf-8').splitlines(keepends=True)
    text_b = file_b.read_text(encoding='utf-8').splitlines(keepends=True)

    # Generate diff
    diff = list(difflib.unified_diff(text_a, text_b, fromfile=f"{version_a}", tofile=f"{version_b}"))

    # Count changes
    lines_added = sum(1 for line in diff if line.startswith('+') and not line.startswith('+++'))
    lines_removed = sum(1 for line in diff if line.startswith('-') and not line.startswith('---'))

    return {
        'version_a': version_a,
        'version_b': version_b,
        'file_a': file_a,
        'file_b': file_b,
        'lines_added': lines_added,
        'lines_removed': lines_removed,
        'diff_text': ''.join(diff),
    }


def _save_revision_history(
    output_dir: Path,
    version: str,
    instructions: str,
    score_before: float,
    score_after: float,
    section: int = None,
) -> None:
    """Save revision to history file for changelog tracking."""
    import json

    history_path = output_dir / "revision_history.json"

    # Load existing history
    if history_path.exists():
        try:
            history = json.loads(history_path.read_text())
        except (json.JSONDecodeError, OSError):
            history = {"revisions": []}
    else:
        history = {"revisions": []}

    # Add new entry
    entry = {
        "version": version,
        "timestamp": datetime.now().isoformat(),
        "instructions": instructions,
        "score_before": round(score_before, 1),
        "score_after": round(score_after, 1),
        "delta": round(score_after - score_before, 1),
    }
    if section:
        entry["section"] = section

    history["revisions"].append(entry)

    # Save
    history_path.write_text(json.dumps(history, indent=2))
    logger.info("Saved revision history: %s", history_path)


def extract_section(draft_text: str, section_num: int) -> tuple[str, str, str]:
    """Extract a specific section from the draft.

    Args:
        draft_text: Full draft markdown text
        section_num: Section number (1-based, matches ## headings)

    Returns:
        Tuple of (before_section, section_content, after_section)
    """
    import re

    # Find all ## headings (main sections)
    pattern = r'^(## .+)$'
    matches = list(re.finditer(pattern, draft_text, re.MULTILINE))

    if not matches:
        raise ValueError("No sections found in draft")

    if section_num < 1 or section_num > len(matches):
        raise ValueError(f"Section {section_num} not found. Draft has {len(matches)} sections.")

    # Get section boundaries
    section_start = matches[section_num - 1].start()
    section_end = matches[section_num].start() if section_num < len(matches) else len(draft_text)

    before = draft_text[:section_start]
    section = draft_text[section_start:section_end]
    after = draft_text[section_end:]

    return before, section.strip(), after


def revise_draft(
    target: Path,
    instructions: str,
    version_suffix: str = None,  # Auto-detect if None
    on_step: callable = None,  # Callback: on_step(step_num, step_name, data)
    on_token: callable = None,  # Callback for streaming tokens
    section: int = None,  # Revise only this section (1-based)
    reject_regression: float = None,  # Reject if quality drops by more than this %
) -> dict:
    """
    Revise an existing draft based on instructions.

    Args:
        target: Path to output folder or draft file
        instructions: Revision instructions
        version_suffix: Suffix for output files (default: v2)
        on_step: Optional callback for progress updates
                 Called as on_step(step_num, step_name, data_dict)
        on_token: Optional callback for streaming tokens
        section: Optional section number (1-based) to revise only that section
        reject_regression: If set, reject revision if quality drops by more than this %

    Returns:
        Dict with paths to revised outputs and quality scores

    Raises:
        ValueError: If reject_regression is set and quality drops too much
    """
    from opendraft.analytics import score_draft, compare_scores

    def _notify(step_num: int, step_name: str, **data):
        if on_step:
            on_step(step_num, step_name, data)

    # Resolve target
    if target.is_file():
        draft_path = target
        output_dir = target.parent
    elif target.is_dir():
        draft_path = find_draft_in_folder(target)
        if not draft_path:
            raise FileNotFoundError(f"No draft found in {target}")
        # Use exports/ subfolder if it exists
        output_dir = target / "exports" if (target / "exports").exists() else target
    else:
        raise FileNotFoundError(f"Target not found: {target}")

    logger.info("Revising: %s%s", draft_path, f" (section {section})" if section else "")

    # Read current draft
    draft_text = draft_path.read_text(encoding='utf-8')
    word_count_before = len(draft_text.split())

    # Section-targeted revision
    before_section = ""
    after_section = ""
    if section:
        before_section, draft_text, after_section = extract_section(draft_text, section)
        logger.info("Extracted section %s: %s words", section, len(draft_text.split()))

    # Step 1: Score before
    _notify(1, "Scoring original draft", word_count=word_count_before)
    score_before = score_draft(draft_text)
    logger.info("Quality before: %.1f%", score_before['overall_score'])
    _notify(1, "Scoring original draft", word_count=word_count_before, score=score_before['overall_score'])

    # Step 2: Call Gemini for revision
    _notify(2, "Revising with Gemini")
    revised_section = call_gemini_revise(draft_text, instructions, on_token=on_token)

    # Reassemble if section-targeted
    if section:
        revised_text = before_section + revised_section + "\n\n" + after_section
        revised_text = revised_text.strip()
    else:
        revised_text = revised_section

    word_count_after = len(revised_text.split())
    _notify(2, "Revising with Gemini", word_count=word_count_after)

    # Step 3: Score after
    _notify(3, "Scoring revised draft")
    score_after = score_draft(revised_text)
    logger.info("Quality after: %.1f%", score_after['overall_score'])
    _notify(3, "Scoring revised draft", score=score_after['overall_score'])

    # Quality regression guard
    quality_delta = score_after['overall_score'] - score_before['overall_score']
    if reject_regression is not None and quality_delta < -reject_regression:
        raise ValueError(
            f"Quality regression rejected: {score_before['overall_score']:.1f}% → "
            f"{score_after['overall_score']:.1f}% ({quality_delta:+.1f}% < -{reject_regression}% threshold)"
        )

    # Determine output filenames
    base_name = draft_path.stem
    # Remove existing version suffix if present
    import re
    base_name = re.sub(r'_v\d+$', '', base_name)

    # Auto-detect next version if not specified
    if version_suffix is None:
        version_suffix = _get_next_version(output_dir, base_name)

    md_name = f"{base_name}_{version_suffix}.md"
    pdf_name = f"{base_name}_{version_suffix}.pdf"
    docx_name = f"{base_name}_{version_suffix}.docx"

    md_path = output_dir / md_name
    pdf_path = output_dir / pdf_name
    docx_path = output_dir / docx_name

    # Step 4: Export files
    _notify(4, "Exporting files")

    # Save revised markdown
    md_path.write_text(revised_text, encoding='utf-8')
    logger.info("Saved: %s", md_path)

    # Export PDF
    title = base_name.replace("_", " ").title()
    if export_pdf(md_path, pdf_path, title=title):
        logger.info("Exported: %s", pdf_path)
    else:
        logger.warning("PDF export failed")
        pdf_path = None

    # Export DOCX
    if export_docx(md_path, docx_path, title=title):
        logger.info("Exported: %s", docx_path)
    else:
        logger.warning("DOCX export failed")
        docx_path = None

    # Calculate delta with component breakdown
    # Use lower threshold (3%) to show more component changes
    import os
    threshold = float(os.environ.get('OPENDRAFT_COMPONENT_THRESHOLD', '3.0'))
    comparison = compare_scores(score_before, score_after, threshold=threshold)
    delta = comparison['overall_delta']

    # Log significant changes
    if comparison['improvements']:
        for imp in comparison['improvements']:
            logger.info("  Improved: %s (+%.1f%)", imp['metric'], imp['delta'])
    if comparison['regressions']:
        for reg in comparison['regressions']:
            logger.warning("  Regressed: %s (%.1f%)", reg['metric'], reg['delta'])

    # Save revision history
    _save_revision_history(
        output_dir=output_dir,
        version=version_suffix,
        instructions=instructions,
        score_before=score_before['overall_score'],
        score_after=score_after['overall_score'],
        section=section,
    )

    return {
        'md_path': md_path,
        'pdf_path': pdf_path,
        'docx_path': docx_path,
        'score_before': score_before['overall_score'],
        'score_after': score_after['overall_score'],
        'delta': delta,
        'word_count': len(revised_text.split()),
        'component_deltas': comparison['component_deltas'],
        'improvements': comparison['improvements'],
        'regressions': comparison['regressions'],
    }
