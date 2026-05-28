"""
HTML Renderer - Pure viewer for ArticleOutput.

Renders article dict to semantic HTML5 page.
No content manipulation - content should already be correct from stages 2-5.
"""

import logging
import re
from html import escape, unescape
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class HTMLRenderer:
    """Simple HTML renderer - no content manipulation."""

    @staticmethod
    def render(
        article: Dict[str, Any],
        company_name: str = "",
        company_url: str = "",
        author_name: str = "",
        language: str = "en",
    ) -> str:
        """
        Render article to production HTML.

        Args:
            article: ArticleOutput dict
            company_name: Company name for meta
            company_url: Company URL for links
            author_name: Author name (defaults to company_name)
            language: Language code for HTML lang attribute (default: "en")

        Returns:
            Complete HTML document string
        """
        # Extract fields
        headline = HTMLRenderer._strip_html(article.get("Headline", "Untitled"))
        teaser = HTMLRenderer._strip_html(article.get("Teaser", ""))
        intro = article.get("Intro", "")
        meta_title = HTMLRenderer._strip_html(article.get("Meta_Title", headline))
        meta_desc = HTMLRenderer._strip_html(article.get("Meta_Description", teaser))
        direct_answer = article.get("Direct_Answer", "")
        sources = article.get("Sources", "")

        # Author
        author = author_name or company_name or "Author"

        # Images
        hero_image = article.get("image_01_url", "")
        # Limit default alt text to 125 chars
        default_alt = f"Image for {headline}"
        if len(default_alt) > 125:
            default_alt = default_alt[:122] + "..."
        hero_alt = article.get("image_01_alt_text") or default_alt
        mid_image = article.get("image_02_url", "")
        mid_alt = article.get("image_02_alt_text", "")

        # Date (timezone-aware)
        now = datetime.now(timezone.utc)
        pub_date = now.strftime("%Y-%m-%d")
        display_date = now.strftime("%b %d, %Y")

        # Render sections
        sections_html = HTMLRenderer._render_sections(article, mid_image, mid_alt)

        # Render intro (escape to prevent XSS - intro may contain AI-generated content)
        intro_html = f'<div class="intro"><p>{escape(intro)}</p></div>' if intro else ""

        # Render direct answer (escape to prevent XSS)
        direct_html = f'<div class="direct-answer">{escape(direct_answer)}</div>' if direct_answer else ""

        # Render TOC
        toc_html = HTMLRenderer._render_toc(article)

        # Render key takeaways
        takeaways_html = HTMLRenderer._render_takeaways(article)

        # Render FAQ
        faq_html = HTMLRenderer._render_faq(article)

        # Render PAA
        paa_html = HTMLRenderer._render_paa(article)

        # Render sources
        sources_html = HTMLRenderer._render_sources(sources)

        # Render tables
        tables_html = HTMLRenderer._render_tables(article.get("tables", []))

        # Build HTML
        html = f"""<!DOCTYPE html>
<html lang="{escape(language)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{escape(meta_title)}</title>
    <meta name="description" content="{escape(meta_desc)}">
    <meta name="author" content="{escape(author)}">

    <!-- Open Graph -->
    <meta property="og:title" content="{escape(meta_title)}">
    <meta property="og:description" content="{escape(meta_desc)}">
    <meta property="og:type" content="article">
    {f'<meta property="og:image" content="{escape(hero_image)}">' if hero_image else ''}

    <style>
        :root {{
            --primary: #2563eb;
            --text: #1f2937;
            --text-light: #6b7280;
            --bg: #ffffff;
            --bg-light: #f9fafb;
            --border: #e5e7eb;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.7;
            color: var(--text);
            background: var(--bg);
        }}
        .container {{ max-width: 800px; margin: 0 auto; padding: 20px; }}
        header {{ padding: 40px 0 20px; border-bottom: 1px solid var(--border); margin-bottom: 30px; }}
        h1 {{ font-size: 2.2em; line-height: 1.2; margin-bottom: 15px; }}
        .teaser {{ font-size: 1.2em; color: var(--text-light); margin-bottom: 15px; }}
        .meta {{ font-size: 0.9em; color: var(--text-light); }}
        .hero-image {{ width: 100%; height: auto; border-radius: 8px; margin-bottom: 30px; }}
        .intro {{ font-size: 1.1em; margin-bottom: 30px; padding: 20px; background: var(--bg-light); border-radius: 8px; }}
        .intro p {{ margin-bottom: 15px; }}
        .direct-answer {{ margin: 20px 0; padding: 20px; background: #eff6ff; border-left: 4px solid var(--primary); border-radius: 4px; }}
        .toc {{ margin: 30px 0; padding: 20px; background: var(--bg-light); border-radius: 8px; }}
        .toc h2 {{ font-size: 1.2em; margin-bottom: 15px; }}
        .toc ul {{ list-style: none; }}
        .toc li {{ margin: 8px 0; }}
        .toc a {{ color: var(--primary); text-decoration: none; }}
        article {{ margin: 40px 0; }}
        article h2 {{ font-size: 1.6em; margin: 40px 0 20px; }}
        article h3 {{ font-size: 1.3em; margin: 30px 0 15px; }}
        article p {{ margin: 15px 0; }}
        article ul, article ol {{ margin: 15px 0 15px 30px; }}
        article li {{ margin: 8px 0; }}
        article a {{ color: var(--primary); }}
        .inline-image {{ width: 100%; height: auto; border-radius: 8px; margin: 30px 0; }}
        .takeaways {{ margin: 40px 0; padding: 20px; background: var(--bg-light); border-radius: 8px; }}
        .takeaways h2 {{ font-size: 1.3em; margin-bottom: 15px; }}
        .takeaways ul {{ list-style: none; }}
        .takeaways li {{ margin: 10px 0; padding-left: 25px; position: relative; }}
        .takeaways li::before {{ content: "✓"; position: absolute; left: 0; color: var(--primary); }}
        .sources {{ margin: 40px 0; padding: 20px; background: var(--bg-light); border-left: 4px solid var(--primary); }}
        .sources h2 {{ font-size: 1.2em; margin-bottom: 15px; }}
        .sources ol {{ margin: 0 0 0 20px; }}
        .sources li {{ margin: 10px 0; }}
        .faq, .paa {{ margin: 40px 0; }}
        .faq h2, .paa h2 {{ font-size: 1.4em; margin-bottom: 20px; }}
        .faq-item, .paa-item {{ margin: 20px 0; padding: 15px; background: var(--bg-light); border-radius: 8px; }}
        .faq-item h3, .paa-item h3 {{ font-size: 1.1em; margin-bottom: 10px; color: var(--text); }}
        .faq-item p, .paa-item p {{ color: var(--text-light); }}
        .comparison-table {{ margin: 40px 0; overflow-x: auto; }}
        .comparison-table h3 {{ font-size: 1.2em; margin-bottom: 15px; }}
        .comparison-table table {{ width: 100%; border-collapse: collapse; font-size: 0.95em; }}
        .comparison-table th, .comparison-table td {{ padding: 12px 15px; text-align: left; border: 1px solid var(--border); }}
        .comparison-table th {{ background: var(--bg-light); font-weight: 600; }}
        .comparison-table tr:hover {{ background: var(--bg-light); }}
    </style>
</head>
<body>
    <header class="container">
        <h1>{escape(headline)}</h1>
        {f'<p class="teaser">{escape(teaser)}</p>' if teaser else ''}
        <p class="meta">By {escape(author)} &bull; {display_date}</p>
    </header>

    <main class="container">
        {f'<img src="{escape(hero_image)}" alt="{escape(hero_alt)}" class="hero-image">' if hero_image else ''}

        {direct_html}
        {intro_html}
        {toc_html}

        <article>
            {sections_html}
        </article>

        {tables_html}
        {takeaways_html}
        {paa_html}
        {faq_html}
        {sources_html}
    </main>
</body>
</html>"""

        return html

    @staticmethod
    def _sanitize_html(html: str) -> str:
        """Sanitize HTML content by removing dangerous elements."""
        if not html:
            return ""

        # Remove script tags and content
        sanitized = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.IGNORECASE | re.DOTALL)
        # Remove style tags and content
        sanitized = re.sub(r'<style[^>]*>.*?</style>', '', sanitized, flags=re.IGNORECASE | re.DOTALL)
        # Remove iframe tags (can embed malicious content)
        sanitized = re.sub(r'<iframe[^>]*>.*?</iframe>', '', sanitized, flags=re.IGNORECASE | re.DOTALL)
        sanitized = re.sub(r'<iframe[^>]*/>', '', sanitized, flags=re.IGNORECASE)
        # Remove object/embed tags (can embed Flash/plugins)
        sanitized = re.sub(r'<object[^>]*>.*?</object>', '', sanitized, flags=re.IGNORECASE | re.DOTALL)
        sanitized = re.sub(r'<embed[^>]*/?>', '', sanitized, flags=re.IGNORECASE)
        # Remove form tags (prevent phishing)
        sanitized = re.sub(r'<form[^>]*>.*?</form>', '', sanitized, flags=re.IGNORECASE | re.DOTALL)
        # Remove event handlers (onclick, onload, onerror, etc.)
        sanitized = re.sub(r'\s*on\w+\s*=\s*["\'][^"\']*["\']', '', sanitized, flags=re.IGNORECASE)
        sanitized = re.sub(r'\s*on\w+\s*=\s*\S+', '', sanitized, flags=re.IGNORECASE)
        # Remove javascript: URLs
        sanitized = re.sub(r'href\s*=\s*["\']javascript:[^"\']*["\']', 'href="#"', sanitized, flags=re.IGNORECASE)
        sanitized = re.sub(r'src\s*=\s*["\']javascript:[^"\']*["\']', 'src=""', sanitized, flags=re.IGNORECASE)
        # Remove data: URLs (can contain executable content)
        sanitized = re.sub(r'href\s*=\s*["\']data:[^"\']*["\']', 'href="#"', sanitized, flags=re.IGNORECASE)
        sanitized = re.sub(r'src\s*=\s*["\']data:(?!image/)[^"\']*["\']', 'src=""', sanitized, flags=re.IGNORECASE)
        # Remove base tags (can hijack relative URLs)
        sanitized = re.sub(r'<base[^>]*/?>', '', sanitized, flags=re.IGNORECASE)
        # Remove meta refresh (can redirect)
        sanitized = re.sub(r'<meta[^>]*http-equiv\s*=\s*["\']refresh["\'][^>]*/?>', '', sanitized, flags=re.IGNORECASE)

        return sanitized

    @staticmethod
    def _render_sections(article: Dict[str, Any], mid_image: str, mid_alt: str) -> str:
        """Render article sections."""
        parts = []

        for i in range(1, 10):
            title = article.get(f"section_{i:02d}_title", "")
            content = article.get(f"section_{i:02d}_content", "")

            if not title and not content:
                continue

            anchor = f"section-{i}"
            if title:
                clean_title = HTMLRenderer._strip_html(title)
                parts.append(f'<h2 id="{anchor}">{escape(clean_title)}</h2>')

            if content and content.strip():
                # Sanitize HTML content to prevent XSS
                parts.append(HTMLRenderer._sanitize_html(content))

            # Mid-article image after section 3
            if i == 3 and mid_image:
                parts.append(f'<img src="{escape(mid_image)}" alt="{escape(mid_alt)}" class="inline-image">')

        return '\n'.join(parts)

    @staticmethod
    def _render_toc(article: Dict[str, Any]) -> str:
        """Render table of contents."""
        items = []

        for i in range(1, 10):
            title = article.get(f"section_{i:02d}_title", "")
            if title:
                anchor = f"section-{i}"
                clean_title = HTMLRenderer._strip_html(title)
                # Shorten for TOC (max 6 words)
                words = clean_title.split()[:6]
                short_title = ' '.join(words)
                if len(words) < len(clean_title.split()):
                    short_title += "..."
                items.append(f'<li><a href="#{anchor}">{escape(short_title)}</a></li>')

        if not items:
            return ""

        return f"""<nav class="toc">
            <h2>Table of Contents</h2>
            <ul>
                {''.join(items)}
            </ul>
        </nav>"""

    @staticmethod
    def _render_takeaways(article: Dict[str, Any]) -> str:
        """Render key takeaways."""
        items = []
        for i in range(1, 4):
            takeaway = article.get(f"key_takeaway_{i:02d}", "")
            if takeaway:
                items.append(f"<li>{escape(takeaway)}</li>")

        if not items:
            return ""

        return f"""<section class="takeaways">
            <h2>Key Takeaways</h2>
            <ul>{''.join(items)}</ul>
        </section>"""

    @staticmethod
    def _render_faq(article: Dict[str, Any]) -> str:
        """Render FAQ section."""
        items = []
        for i in range(1, 7):
            q = article.get(f"faq_{i:02d}_question", "")
            a = article.get(f"faq_{i:02d}_answer", "")
            if q and a:
                # Escape answer to prevent XSS (FAQ answers should be plain text)
                items.append(f'<div class="faq-item"><h3>{escape(q)}</h3><p>{escape(a)}</p></div>')

        if not items:
            return ""

        return f"""<section class="faq">
            <h2>Frequently Asked Questions</h2>
            {''.join(items)}
        </section>"""

    @staticmethod
    def _render_paa(article: Dict[str, Any]) -> str:
        """Render People Also Ask section."""
        items = []
        for i in range(1, 5):
            q = article.get(f"paa_{i:02d}_question", "")
            a = article.get(f"paa_{i:02d}_answer", "")
            if q and a:
                # Escape answer to prevent XSS (PAA answers should be plain text)
                items.append(f'<div class="paa-item"><h3>{escape(q)}</h3><p>{escape(a)}</p></div>')

        if not items:
            return ""

        return f"""<section class="paa">
            <h2>People Also Ask</h2>
            {''.join(items)}
        </section>"""

    @staticmethod
    def _render_sources(sources) -> str:
        """Render sources section. Handles list of {title, url} or string."""
        if not sources:
            return ""

        # New format: list of Source objects or dicts
        if isinstance(sources, list):
            items = []
            for s in sources:
                if hasattr(s, 'title'):
                    # Pydantic Source object
                    items.append(f'<li><a href="{escape(s.url)}" target="_blank" rel="noopener noreferrer">{escape(s.title)}</a></li>')
                elif isinstance(s, dict):
                    # Dict format - handle None values with `or ""`
                    url = s.get("url") or ""
                    title = s.get("title") or ""
                    if url:  # Only add if URL exists
                        items.append(f'<li><a href="{escape(url)}" target="_blank" rel="noopener noreferrer">{escape(title)}</a></li>')
            if not items:
                return ""
            return f"""<section class="sources">
                <h2>Sources</h2>
                <ul>{''.join(items)}</ul>
            </section>"""

        # Legacy string format
        if not str(sources).strip():
            return ""

        # If already HTML, sanitize by stripping all tags except safe ones
        # This prevents XSS from malicious HTML in sources
        if '<ol>' in sources or '<li>' in sources:
            # Strip potentially dangerous tags but keep structure
            # Remove script, style, and event handlers
            sanitized = re.sub(r'<script[^>]*>.*?</script>', '', sources, flags=re.IGNORECASE | re.DOTALL)
            sanitized = re.sub(r'<style[^>]*>.*?</style>', '', sanitized, flags=re.IGNORECASE | re.DOTALL)
            sanitized = re.sub(r'\s*on\w+\s*=\s*["\'][^"\']*["\']', '', sanitized, flags=re.IGNORECASE)
            sanitized = re.sub(r'\s*on\w+\s*=\s*\S+', '', sanitized, flags=re.IGNORECASE)
            return f"""<section class="sources">
                <h2>Sources</h2>
                {sanitized}
            </section>"""

        # Plain text format: [1]: URL - description
        lines = str(sources).strip().split('\n')
        items = []
        for line in lines:
            line = line.strip()
            if line:
                items.append(f"<li>{escape(line)}</li>")

        if not items:
            return ""

        return f"""<section class="sources">
            <h2>Sources</h2>
            <ol>{''.join(items)}</ol>
        </section>"""

    @staticmethod
    def _render_tables(tables) -> str:
        """Render comparison tables."""
        if not tables:
            return ""

        parts = []
        for table in tables:
            # Handle both dict and Pydantic model
            if hasattr(table, 'title'):
                title = table.title
                headers = table.headers
                rows = table.rows
            else:
                title = table.get('title', '')
                headers = table.get('headers', [])
                rows = table.get('rows', [])

            if not headers or not rows:
                continue

            header_html = ''.join(f'<th>{escape(h)}</th>' for h in headers)
            rows_html = ''
            for row in rows:
                cells = ''.join(f'<td>{escape(str(c))}</td>' for c in row)
                rows_html += f'<tr>{cells}</tr>'

            parts.append(f'''<div class="comparison-table">
                <h3>{escape(title)}</h3>
                <table>
                    <thead><tr>{header_html}</tr></thead>
                    <tbody>{rows_html}</tbody>
                </table>
            </div>''')

        return '\n'.join(parts)

    @staticmethod
    def _strip_html(text: str) -> str:
        """Strip HTML tags and decode entities."""
        if not text:
            return ""
        clean = re.sub(r'<[^>]+>', '', str(text))
        return unescape(clean).strip()
