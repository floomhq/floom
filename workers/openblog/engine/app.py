"""
OpenBlog wrapper for floom-docker v0.

Exposes OpenBlog's 5-stage pipeline as two floom-docker actions:

  generate(url, keywords)  -> dict  # Full pipeline (stages 1-5) on new keywords
  refresh(article_json)    -> dict  # Re-run stages 3-5 on an existing article

Each action runs in its own Docker container (floom-docker v0 spawns a fresh
container per invocation), so module-level imports and sys.path mutations are
scoped to a single action run. We bridge the sync floom-docker calling
convention to OpenBlog's async pipeline via asyncio.run().
"""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import sys
from pathlib import Path
from typing import Any, Dict, List

# =============================================================================
# Path setup
# =============================================================================
# floom-docker drops us into /app (or similar) with this file and the copied
# openblog/ sources alongside. Add the directory of this file to sys.path so
# `shared`, `stage1`, ... `stage_refresh` are importable as top-level packages.

_BASE = Path(__file__).resolve().parent
if str(_BASE) not in sys.path:
    sys.path.insert(0, str(_BASE))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("openblog-floom")

# =============================================================================
# Import OpenBlog pipeline
# =============================================================================
# run_pipeline.py pre-loads every stage module at import time (it uses a
# custom importlib dance because historically several stages had files named
# `models.py` that collided in sys.modules). Importing run_pipeline here gives
# us the already-wired run_stage_3/4/5 handles as module attributes, so the
# refresh() action can call them without repeating the loader boilerplate.

import run_pipeline as _pipeline  # noqa: E402

run_pipeline = _pipeline.run_pipeline
run_stage_3 = _pipeline.run_stage_3
run_stage_4 = _pipeline.run_stage_4
run_stage_5 = _pipeline.run_stage_5
Stage4Input = _pipeline.Stage4Input

# Optional HTML renderer for pretty preview output. If the import or render
# fails, we swallow the error and fall back to an empty preview; the raw
# articles are always returned.
try:
    from shared.html_renderer import HTMLRenderer  # noqa: E402
except Exception as _render_exc:  # pragma: no cover - defensive
    HTMLRenderer = None  # type: ignore[assignment]
    logger.warning("HTMLRenderer unavailable: %s", _render_exc)


def _render_preview(articles: List[Dict[str, Any]], company: str = "") -> str:
    """
    Render the first successful article as a standalone HTML document.

    Returns an empty string on failure; never raises.
    """
    if HTMLRenderer is None or not articles:
        return ""
    first = next(
        (a for a in articles if isinstance(a.get("article"), dict) and not a.get("error")),
        None,
    )
    if not first:
        return ""
    try:
        return HTMLRenderer.render(
            article=first["article"],
            company_name=company or "",
            company_url="",
            author_name="",
            language="en",
        )
    except Exception as exc:
        logger.warning("HTMLRenderer.render failed: %s", exc)
        return "<p>Could not render HTML preview.</p>"


# =============================================================================
# Helpers
# =============================================================================

def _parse_keywords(raw: str) -> List[str]:
    """Parse newline-separated keywords from a textarea input."""
    if not raw:
        return []
    keywords = [line.strip() for line in raw.splitlines()]
    return [kw for kw in keywords if kw]


def _derive_keyword(article: Dict[str, Any]) -> str:
    """
    Pick a primary keyword from an existing article dict.

    The ArticleOutput schema does not carry the keyword explicitly, so we fall
    back to Headline -> Meta_Title -> first related_keyword -> empty.
    """
    for field in ("Headline", "Meta_Title"):
        val = article.get(field)
        if isinstance(val, str) and val.strip():
            return val.strip()
    related = article.get("related_keywords") or []
    if isinstance(related, list) and related:
        first = related[0]
        if isinstance(first, str) and first.strip():
            return first.strip()
    return ""


def _load_article_json(article_json: str) -> Dict[str, Any]:
    """Parse the article_json input, accepting either a raw article dict or a
    wrapper object that holds the article under an `article` key (matching the
    shape produced by `generate()` above)."""
    try:
        parsed = json.loads(article_json)
    except json.JSONDecodeError as e:
        raise ValueError(f"article_json is not valid JSON: {e}") from e

    if not isinstance(parsed, dict):
        raise ValueError("article_json must decode to a JSON object")

    # Accept either the bare article dict or the shape returned by generate().
    if "article" in parsed and isinstance(parsed["article"], dict) and "Headline" in parsed["article"]:
        return parsed["article"]
    return parsed


# =============================================================================
# Actions
# =============================================================================

def article_to_markdown(article: dict) -> str:
    """Convert an article dict to a Markdown string."""
    import re as _re
    lines: List[str] = []
    if article.get("Headline"):
        lines.append(f"# {article['Headline']}")
    if article.get("Subtitle"):
        lines.append(f"*{article['Subtitle']}*\n")
    if article.get("Teaser"):
        lines.append(f"> {article['Teaser']}\n")
    if article.get("Direct_Answer"):
        lines.append("## Quick Answer")
        lines.append(f"{article['Direct_Answer']}\n")
    if article.get("Intro"):
        lines.append("## Introduction")
        lines.append(f"{article['Intro']}\n")
    for i in range(1, 10):
        title = article.get(f"section_0{i}_title") or article.get(f"section_{i:02d}_title")
        content = article.get(f"section_0{i}_content") or article.get(f"section_{i:02d}_content")
        if title:
            lines.append(f"## {title}")
            if content:
                clean = _re.sub(r"<[^>]+>", "", content)
                lines.append(f"{clean}\n")
    return "\n".join(lines).strip()


def generate(url: str, keywords: str, _previous_output: str = None, _feedback: str = None, _knowledge: dict = None) -> dict:
    """
    Run OpenBlog's full 5-stage pipeline.

    When _previous_output and _feedback are provided (feedback loop), the
    pipeline uses the previous article plus user feedback to refine the result
    by prepending the feedback context to the keywords prompt.

    Args:
        url: Company website URL used for context extraction (stage 1).
        keywords: Newline-separated keyword list; one article per keyword.
        _previous_output: JSON string of the previous run's output (injected by floom-docker).
        _feedback: User's feedback text (injected by floom-docker).

    Returns:
        Dict with three keys: preview (HTML), markdown (MD source), raw (full result).
    """
    if not url or not url.strip():
        raise ValueError("url is required")

    keyword_list = _parse_keywords(keywords)
    if not keyword_list:
        raise ValueError("keywords is required (one keyword per line)")

    # Prepend knowledge context to keywords if available
    if _knowledge:
        context_lines = []
        for doc_name, doc_text in _knowledge.items():
            context_lines.append(f"[Context from {doc_name}]: {doc_text[:500]}")
        if context_lines:
            context_prefix = "[COMPANY KNOWLEDGE]\n" + "\n".join(context_lines) + "\n\n"
            keyword_list = [context_prefix + kw for kw in keyword_list]
            logger.info("generate() injected %d knowledge docs into keywords", len(_knowledge))

    # Feedback refinement: augment keywords with context from the previous run
    if _previous_output and _feedback:
        try:
            prev = json.loads(_previous_output) if isinstance(_previous_output, str) else _previous_output
            prev_articles = prev.get("raw", {}).get("articles", [])
            first_prev = next(
                (a for a in prev_articles if isinstance(a.get("article"), dict) and not a.get("error")),
                None,
            )
            if first_prev and first_prev.get("article"):
                headline = first_prev["article"].get("Headline", "")
                feedback_prefix = (
                    f"[REVISION REQUEST] The previous article had headline: \"{headline}\". "
                    f"User feedback: {_feedback}. "
                    f"Please incorporate this feedback when generating the article.\n\n"
                )
                keyword_list = [feedback_prefix + kw for kw in keyword_list]
                logger.info("generate() feedback mode: augmenting %d keyword(s) with revision context", len(keyword_list))
        except (json.JSONDecodeError, TypeError, KeyError) as exc:
            logger.warning("Could not parse _previous_output for feedback refinement: %s", exc)

    logger.info("generate() start: %d keyword(s) for %s", len(keyword_list), url)

    result = asyncio.run(run_pipeline(
        keywords=keyword_list,
        company_url=url,
        language="en",
        market="US",
        skip_images=True,        # Images add latency + cost; off by default
        max_parallel=3,
        output_dir=None,         # floom-docker captures the return value, not files
        export_formats=None,
    ))

    # Flatten the per-article results into a clean list for the action output.
    articles = []
    for art_result in result.get("results", []):
        articles.append({
            "keyword": art_result.get("keyword"),
            "slug": art_result.get("slug"),
            "href": art_result.get("href"),
            "article": art_result.get("article"),
            "error": art_result.get("error"),
            "reports": art_result.get("reports", {}),
        })

    preview_html = _render_preview(articles, company=str(result.get("company") or ""))

    # Build markdown from the first successful article
    md = ""
    first_ok = next(
        (a for a in articles if isinstance(a.get("article"), dict) and not a.get("error")),
        None,
    )
    if first_ok and first_ok.get("article"):
        md = article_to_markdown(first_ok["article"])

    raw = {
        "job_id": result.get("job_id"),
        "company": result.get("company"),
        "articles_total": result.get("articles_total"),
        "articles_successful": result.get("articles_successful"),
        "articles_failed": result.get("articles_failed"),
        "duration_seconds": result.get("duration_seconds"),
        "articles": articles,
    }

    return {
        "preview": preview_html,
        "markdown": md,
        "raw": raw,
    }


def refresh(article_data, _knowledge: dict = None) -> dict:
    """
    Re-run stages 3 (quality check), 4 (URL verify), and 5 (internal links)
    on an existing article.

    We skip stage 1 (context) and stage 2 (blog gen + images) because the
    article already exists; we just want to quality-check, validate links,
    and re-link internally.

    Stage 5 normally receives a sitemap from stage 1. Because refresh doesn't
    re-run stage 1, we pass empty sitemap lists -- stage 5 will still execute
    but won't have new internal link candidates. This is intentional: refresh
    is a lightweight freshness pass, not a full re-generation.

    Args:
        article_data: Parsed article data. With parse_to="json", this arrives
                      as a dict (from JSON/CSV upload) or {"text": "..."} (from
                      HTML/TXT). Also accepts a raw JSON string for backward
                      compatibility.

    Returns:
        Dict with the refreshed article and per-stage reports.
    """
    if not article_data:
        raise ValueError("article_data is required")

    # Handle parsed file input (dict from parse_to="json") or legacy string
    if isinstance(article_data, str):
        article = _load_article_json(article_data)
    elif isinstance(article_data, dict):
        # If it came from HTML/TXT parse, the content is under "text" key
        if "text" in article_data and len(article_data) == 1:
            article = _load_article_json(article_data["text"])
        elif "article" in article_data and isinstance(article_data["article"], dict) and "Headline" in article_data["article"]:
            article = article_data["article"]
        else:
            article = article_data
    elif isinstance(article_data, list):
        # CSV parsed to array of objects: use the first row
        if not article_data:
            raise ValueError("Empty CSV data")
        article = article_data[0]
    else:
        raise ValueError(f"Unexpected article_data type: {type(article_data)}")

    keyword = _derive_keyword(article)

    logger.info("refresh() start: keyword=%r", keyword)

    return asyncio.run(_refresh_async(article, keyword))


async def _refresh_async(article: Dict[str, Any], keyword: str) -> dict:
    reports: Dict[str, Any] = {}

    # -----------------------------------------
    # Stage 3: Quality Check
    # -----------------------------------------
    logger.info("  [Stage 3] Quality check...")
    stage3_output = await run_stage_3({
        "article": article,
        "keyword": keyword,
        "language": "en",
        "voice_context": None,  # No stage 1 context on refresh
    })
    article = copy.deepcopy(stage3_output["article"])
    reports["stage3"] = {
        "fixes_applied": stage3_output.get("fixes_applied", 0),
        "ai_calls": stage3_output.get("ai_calls", 0),
    }
    logger.info("  [Stage 3] applied %s fixes", reports["stage3"]["fixes_applied"])

    # -----------------------------------------
    # Stage 4: URL Verification
    # -----------------------------------------
    logger.info("  [Stage 4] URL verify...")
    stage4_input = Stage4Input(
        article=article,
        keyword=keyword,
    )
    stage4_output = await run_stage_4(stage4_input)
    article = copy.deepcopy(stage4_output.article)
    reports["stage4"] = {
        "total_urls": stage4_output.total_urls,
        "valid_urls": stage4_output.valid_urls,
        "dead_urls": stage4_output.dead_urls,
        "replaced_urls": stage4_output.replaced_urls,
        "ai_calls": stage4_output.ai_calls,
    }
    logger.info(
        "  [Stage 4] verified %s URLs, replaced %s",
        stage4_output.total_urls, stage4_output.replaced_urls,
    )

    # -----------------------------------------
    # Stage 5: Internal Links (empty sitemap)
    # -----------------------------------------
    logger.info("  [Stage 5] Internal links (no sitemap on refresh)...")
    stage5_output = await run_stage_5({
        "article": article,
        "current_href": "",
        "company_url": "",
        "batch_siblings": [],
        "sitemap_blog_urls": [],
        "sitemap_resource_urls": [],
        "sitemap_tool_urls": [],
        "sitemap_product_urls": [],
        "sitemap_service_urls": [],
    })
    article = copy.deepcopy(stage5_output["article"])
    reports["stage5"] = {
        "links_added": stage5_output.get("links_added", 0),
    }
    logger.info("  [Stage 5] added %s links", reports["stage5"]["links_added"])

    preview_html = _render_preview([{"article": article}])
    md = article_to_markdown(article)

    return {
        "preview": preview_html,
        "markdown": md,
        "raw": {
            "article": article,
            "keyword": keyword,
            "reports": reports,
        },
    }
