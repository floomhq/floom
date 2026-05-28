"""PDF export from markdown draft."""

import logging
import subprocess
import shutil
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


def export_pdf(
    markdown_path: Path,
    output_path: Path,
    title: Optional[str] = None,
) -> bool:
    """
    Export markdown to PDF using available engine.

    Tries in order: pandoc, weasyprint.

    Args:
        markdown_path: Path to markdown file
        output_path: Path for output PDF
        title: Optional document title

    Returns:
        True if export succeeded
    """
    if shutil.which("pandoc"):
        return _export_pandoc(markdown_path, output_path, title)

    try:
        import weasyprint  # noqa: F401
        return _export_weasyprint(markdown_path, output_path)
    except ImportError:
        pass

    logger.error("No PDF engine available. Install pandoc or weasyprint.")
    return False


def _export_pandoc(markdown_path: Path, output_path: Path, title: Optional[str] = None) -> bool:
    cmd = [
        "pandoc", str(markdown_path),
        "-o", str(output_path),
        "--pdf-engine=xelatex",
        "-V", "geometry:margin=1in",
    ]
    if title:
        cmd.extend(["-V", f"title={title}"])

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode == 0:
            logger.info("PDF exported: %s", output_path)
            return True
        else:
            logger.error("Pandoc error: %s", result.stderr)
            return False
    except subprocess.TimeoutExpired:
        logger.error("Pandoc timed out")
        return False
    except FileNotFoundError:
        logger.error("Pandoc not found")
        return False


def _export_weasyprint(markdown_path: Path, output_path: Path) -> bool:
    try:
        import markdown
        import weasyprint

        md_text = markdown_path.read_text(encoding='utf-8')
        html = markdown.markdown(md_text, extensions=['tables', 'toc'])

        styled_html = f"""
        <html>
        <head>
            <style>
                body {{ font-family: 'Times New Roman', serif; margin: 1in; line-height: 1.6; }}
                h1 {{ font-size: 24pt; margin-top: 2em; }}
                h2 {{ font-size: 18pt; margin-top: 1.5em; }}
                h3 {{ font-size: 14pt; margin-top: 1em; }}
                p {{ text-align: justify; }}
            </style>
        </head>
        <body>{html}</body>
        </html>
        """

        weasyprint.HTML(string=styled_html).write_pdf(str(output_path))
        logger.info("PDF exported via WeasyPrint: %s", output_path)
        return True
    except Exception as e:
        logger.error("WeasyPrint error: %s", e)
        return False
