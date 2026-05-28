"""
Stage 4: URL Verification

Verifies all external URLs in the article content:
1. Extract URLs from content fields
2. HTTP HEAD/GET check for accessibility
3. Gemini url_context for content relevance (optional)
4. Gemini google_search for replacements (if dead/irrelevant)
5. Surgical replacement in article fields

Micro-API Design:
- Input: JSON with article content + keyword
- Output: JSON with verified article + URL report
- Can run as CLI or be imported as a module

AI Calls: 0-2 (only if dead URLs found or content verification enabled)
"""

import argparse
import asyncio
import copy
import json
import logging
import re
from pathlib import Path
from typing import Optional, Dict, Any, List
from urllib.parse import urlparse

from dotenv import load_dotenv

# Load .env from parent directory (openblog-neo/)
load_dotenv(Path(__file__).parent.parent / ".env")

from stage4_models import (
    Stage4Input,
    Stage4Output,
    URLVerificationResult,
    URLReplacement,
    URLStatus,
)
from url_extractor import URLExtractor
from http_checker import HTTPChecker, HTTPCheckResult
from url_verifier import URLVerifier

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# =============================================================================
# URL Replacement Helpers
# =============================================================================

def is_html_field(field_name: str) -> bool:
    """
    Check if a field contains HTML with anchor tags.

    Per ArticleOutput schema, only section_XX_content fields are HTML.
    Other fields (Intro, Direct_Answer, paa/faq answers) are plain text.
    """
    return field_name.startswith("section_") and field_name.endswith("_content")


def replace_anchor_tag(content: str, old_url: str, new_url: str, anchor_text: str) -> str:
    """
    Replace anchor tag URL and text while preserving other attributes.

    Before: <a href="https://old-url.com" target="_blank" rel="noopener">Old Text</a>
    After:  <a href="https://new-url.com" target="_blank" rel="noopener">natural anchor text</a>

    Handles nested tags like <a href="..."><strong>text</strong></a>
    """
    # Pattern to capture: <a, href="old_url", other attrs, >content</a>
    # Uses .*? to handle nested tags (non-greedy match to first </a>)
    pattern = rf'<a\s+([^>]*?)href=["\']({re.escape(old_url)})["\']([^>]*)>(.*?)</a>'

    def replacement(match):
        before_href = match.group(1).strip()
        after_href = match.group(3).strip()

        # Rebuild attributes, excluding old hreflang if present
        attrs = []
        if before_href:
            # Remove existing hreflang from before
            before_href = re.sub(r'hreflang=["\'][^"\']*["\']\s*', '', before_href).strip()
            if before_href:
                attrs.append(before_href)
        if after_href:
            # Remove existing hreflang from after
            after_href = re.sub(r'hreflang=["\'][^"\']*["\']\s*', '', after_href).strip()
            if after_href:
                attrs.append(after_href)

        # Build new tag
        attr_str = ' '.join(attrs)
        if attr_str:
            return f'<a href="{new_url}" {attr_str}>{anchor_text}</a>'
        else:
            return f'<a href="{new_url}">{anchor_text}</a>'

    return re.sub(pattern, replacement, content, flags=re.IGNORECASE)


def remove_dead_link(content: str, dead_url: str) -> str:
    """
    Remove anchor tag but keep the text (strips nested tags too).

    Before: <a href="https://dead-url.com" target="_blank"><strong>Some Text</strong></a>
    After:  Some Text
    """
    # Match anchor with any nested content
    pattern = rf'<a\s+[^>]*href=["\']({re.escape(dead_url)})["\'][^>]*>(.*?)</a>'

    def strip_tags(match):
        inner = match.group(2)
        # Strip any nested HTML tags, keep text
        return re.sub(r'<[^>]+>', '', inner)

    return re.sub(pattern, strip_tags, content, flags=re.IGNORECASE)


def extract_link_context(content: str, url: str) -> Dict[str, str]:
    """
    Extract the sentence containing a link and the anchor text.

    Returns:
        Dict with 'sentence' and 'anchor_text' keys
    """
    # Find the anchor tag with this URL
    anchor_pattern = rf'<a\s+[^>]*href=["\']({re.escape(url)})["\'][^>]*>(.*?)</a>'
    anchor_match = re.search(anchor_pattern, content, re.IGNORECASE | re.DOTALL)

    if not anchor_match:
        return {"sentence": "", "anchor_text": ""}

    anchor_text = anchor_match.group(2)
    # Strip any nested HTML tags from anchor text
    anchor_text = re.sub(r'<[^>]+>', '', anchor_text)

    # Find the sentence containing the anchor
    # Look for text between <p> tags or sentence boundaries
    anchor_start = anchor_match.start()
    anchor_end = anchor_match.end()

    # Try to find paragraph boundaries first
    p_start = content.rfind('<p>', 0, anchor_start)
    p_end = content.find('</p>', anchor_end)

    if p_start != -1 and p_end != -1:
        sentence = content[p_start:p_end + 4]  # Include </p>
    else:
        # Fall back to finding sentence boundaries (. ! ?)
        # Look backwards for sentence start
        text_before = content[:anchor_start]
        sentence_start = max(
            text_before.rfind('. ') + 2,
            text_before.rfind('! ') + 2,
            text_before.rfind('? ') + 2,
            text_before.rfind('<p>') + 3,
            0
        )

        # Look forwards for sentence end
        text_after = content[anchor_end:]
        sentence_end_rel = min(
            (text_after.find('. ') + 1) if text_after.find('. ') != -1 else len(text_after),
            (text_after.find('! ') + 1) if text_after.find('! ') != -1 else len(text_after),
            (text_after.find('? ') + 1) if text_after.find('? ') != -1 else len(text_after),
            (text_after.find('</p>')) if text_after.find('</p>') != -1 else len(text_after),
        )

        sentence = content[sentence_start:anchor_end + sentence_end_rel]

    return {
        "sentence": sentence.strip(),
        "anchor_text": anchor_text.strip(),
    }


def replace_source_citation(content: Any, old_url: str, new_url: str, source_name: str) -> Any:
    """
    Replace URL in Sources field.

    Handles both formats:
    - String: "[1]: https://old-url.com - Old description"
    - List[Source]: [{"title": "...", "url": "..."}]
    """
    # Handle List[Source] format (ArticleOutput schema)
    if isinstance(content, list):
        result = []
        for item in content:
            if isinstance(item, dict) and item.get("url") == old_url:
                result.append({"title": source_name, "url": new_url})
            else:
                result.append(item)
        return result

    # Handle string format
    if not isinstance(content, str):
        return content

    # First try [N]: format
    pattern = rf'(\[\d+\]:\s*){re.escape(old_url)}(\s*-\s*)[^\n]+'
    result = re.sub(pattern, lambda m: f'{m.group(1)}{new_url}{m.group(2)}{source_name}', content)

    # If no change, try plain URL replacement
    if result == content and old_url in content:
        result = content.replace(old_url, new_url)

    return result


def remove_source_citation(content: Any, dead_url: str) -> Any:
    """
    Remove a dead URL from Sources field.

    Handles both formats:
    - String: "[1]: https://url.com - desc" (removes line, keeps gaps)
    - List[Source]: [{"title": "...", "url": "..."}] (removes item)

    NOTE: Does NOT renumber citations - would break in-text refs like "[2]"
    """
    # Handle List[Source] format
    if isinstance(content, list):
        return [item for item in content
                if not (isinstance(item, dict) and item.get("url") == dead_url)]

    # Handle string format
    if not isinstance(content, str):
        return content

    # Try [N]: format - remove entire line
    pattern = rf'\[\d+\]:\s*{re.escape(dead_url)}[^\n]*\n?'
    result = re.sub(pattern, '', content)

    # If no change, try plain URL removal
    if result == content and dead_url in content:
        result = content.replace(dead_url, '[removed]')

    return result.strip()


def extract_anchor_context(content: str, url: str) -> str:
    """
    Extract the sentence/context around an anchor tag containing the URL.

    Returns the full anchor tag with surrounding text for context.
    Handles nested tags like <a href="..."><strong>text</strong></a>
    """
    # Try to find anchor tag with this URL (.*? handles nested tags)
    pattern = rf'[^.]*<a\s+[^>]*href=["\']({re.escape(url)})["\'][^>]*>.*?</a>[^.]*\.'
    match = re.search(pattern, content, flags=re.IGNORECASE)
    if match:
        return match.group(0).strip()

    # Fallback: just return some context around the URL
    idx = content.find(url)
    if idx >= 0:
        start = max(0, idx - 50)
        end = min(len(content), idx + len(url) + 50)
        return content[start:end]

    return ""


def smart_replace_url(
    content: str,
    field_name: str,
    old_url: str,
    new_url: str,
    source_name: str,
    anchor_text: str = ""
) -> str:
    """
    Smart URL replacement based on field type.

    - For HTML fields: Replace full anchor tag with natural anchor text
    - For Sources: Replace with source name
    - For other fields: Simple URL replacement
    """
    if is_html_field(field_name):
        # HTML content - replace anchor tag with natural anchor text
        text_to_use = anchor_text or source_name
        new_content = replace_anchor_tag(content, old_url, new_url, text_to_use)
        # If anchor tag replacement didn't work, fall back to simple replace
        if new_content == content and old_url in content:
            new_content = content.replace(old_url, new_url)
        return new_content

    elif field_name == "Sources":
        # Sources field - replace with source name (not anchor_text)
        return replace_source_citation(content, old_url, new_url, source_name)

    else:
        # Simple replacement for other fields
        return content.replace(old_url, new_url)


def smart_remove_dead_url(content: str, field_name: str, dead_url: str) -> str:
    """
    Remove dead URL from content based on field type.

    - For HTML fields: Remove anchor tag, keep text
    - For Sources: Remove citation line
    - For video_url/video_title: Clear to empty string
    - For other fields: Replace URL with [removed]
    """
    if is_html_field(field_name):
        return remove_dead_link(content, dead_url)

    elif field_name == "Sources":
        return remove_source_citation(content, dead_url)

    elif field_name in ("video_url", "video_title"):
        # Video fields should be cleared, not replaced with [removed]
        return ""

    else:
        return content.replace(dead_url, "[removed]")


# =============================================================================
# Core Logic
# =============================================================================

async def run_stage_4(input_data: Stage4Input) -> Stage4Output:
    """
    Run Stage 4: URL Verification.

    Args:
        input_data: Stage4Input with article and verification options

    Returns:
        Stage4Output with verified article and URL report

    Raises:
        ValueError: If keyword is empty
    """
    # Validate keyword
    if not input_data.keyword or not input_data.keyword.strip():
        raise ValueError("keyword cannot be empty - required for AI content relevance checks")

    logger.info("Stage 4: URL Verification")
    logger.info(f"  Keyword: {input_data.keyword}")
    logger.info(f"  Skip domains: {input_data.skip_domains}")

    ai_calls = 0
    article = copy.deepcopy(input_data.article)

    # -----------------------------------------
    # Step 1: Extract URLs from article
    # -----------------------------------------
    # Extract all URLs once, then filter for skip_domains
    extractor = URLExtractor(skip_domains=[])  # No skip filter for extraction
    all_urls = extractor.extract_urls(article)
    all_url_field_map = extractor.get_url_field_map(article)

    # Apply skip_domains filter (reuse URLExtractor's skip logic pattern)
    skip_domains_set = set(d.lower() for d in input_data.skip_domains)

    def should_skip_domain(url: str) -> bool:
        try:
            domain = urlparse(url).netloc.lower()
            return any(domain == sd or domain.endswith("." + sd) for sd in skip_domains_set)
        except Exception:
            return False

    urls = {url for url in all_urls if not should_skip_domain(url)}
    url_field_map = {url: fields for url, fields in all_url_field_map.items() if url in urls}

    skipped_count = len(all_urls) - len(urls)
    logger.info(f"  Found {len(urls)} URLs to verify ({skipped_count} skipped)")

    if not urls:
        return Stage4Output(
            article=article,
            total_urls=0,
            valid_urls=0,
            dead_urls=0,
            replaced_urls=0,
            removed_urls=0,
            skipped_urls=skipped_count,  # May have skipped URLs even if none to verify
            url_results=[],
            replacements=[],
            ai_calls=0,
        )

    # -----------------------------------------
    # Step 2: HTTP check for accessibility
    # -----------------------------------------
    logger.info("  Running HTTP checks...")
    checker = HTTPChecker(
        timeout=input_data.timeout_seconds,
        max_concurrent=input_data.max_concurrent_http
    )
    http_results = await checker.check_urls(urls)

    # Categorize results
    alive_urls, dead_urls = checker.categorize_results(http_results)
    logger.info(f"  HTTP results: {len(alive_urls)} alive, {len(dead_urls)} dead")

    # Build initial verification results from HTTP checks
    url_results: List[URLVerificationResult] = []
    http_result_map: Dict[str, HTTPCheckResult] = {r.url: r for r in http_results}

    for url in urls:
        http_result = http_result_map.get(url)
        if http_result:
            url_results.append(URLVerificationResult(
                url=url,
                status=URLStatus.VALID if http_result.is_alive else URLStatus.DEAD,
                http_code=http_result.status_code,
                final_url=http_result.final_url,
                error=http_result.error,
            ))

    # -----------------------------------------
    # Step 3: Content verification (before replacements)
    # -----------------------------------------
    irrelevant_urls: List[str] = []
    verifier: Optional[URLVerifier] = None  # Reuse for both verification and replacement

    if input_data.verify_content and alive_urls:
        logger.info("  Verifying content relevance (batched)...")
        sample_urls = list(alive_urls)[:input_data.max_content_verify]

        try:
            verifier = URLVerifier()
            content_results = await verifier.verify_urls_batch(
                urls=sample_urls,
                keyword=input_data.keyword,
                max_urls=input_data.max_urls_per_batch
            )
            ai_calls += 1  # Increment after successful call

            # Update results and collect irrelevant URLs
            for url, content_data in content_results.items():
                for result in url_results:
                    if result.url == url:
                        result.content_relevant = content_data.get("content_relevant")
                        result.content_summary = content_data.get("content_summary")
                        if not content_data.get("content_relevant"):
                            result.status = URLStatus.IRRELEVANT
                            irrelevant_urls.append(url)

            if irrelevant_urls:
                logger.info(f"  Found {len(irrelevant_urls)} irrelevant URLs")

        except Exception as e:
            logger.warning(f"  Content verification failed: {e}")

    # -----------------------------------------
    # Step 4: Find replacements for dead/irrelevant URLs
    # -----------------------------------------
    replacements: List[URLReplacement] = []

    # Combine dead URLs + irrelevant URLs (if enabled)
    urls_to_replace = list(dead_urls)
    if input_data.replace_irrelevant and irrelevant_urls:
        urls_to_replace.extend(irrelevant_urls)
        logger.info(f"  Including {len(irrelevant_urls)} irrelevant URLs for replacement")

    if urls_to_replace and input_data.find_replacements:
        logger.info(f"  Finding replacements for {len(urls_to_replace)} URLs...")

        try:
            # Build context map: url -> surrounding sentence
            url_contexts = {}
            for url in urls_to_replace:
                for field, content in article.items():
                    if isinstance(content, str) and url in content:
                        ctx = extract_anchor_context(content, url)
                        if ctx:
                            url_contexts[url] = ctx
                            break

            if verifier is None:
                verifier = URLVerifier()
            replacement_map = await verifier.find_replacements_batch(
                dead_urls=urls_to_replace,
                keyword=input_data.keyword,
                url_contexts=url_contexts,
                max_urls=input_data.max_urls_per_batch
            )
            ai_calls += 1  # Increment after successful call

            # Verify replacement URLs are alive (if enabled)
            verified_replacements = replacement_map
            if input_data.verify_replacement_urls and replacement_map:
                new_urls = {r["new_url"] for r in replacement_map.values() if r.get("new_url")}
                if new_urls:
                    logger.info(f"    Verifying {len(new_urls)} replacement URLs...")
                    repl_results = await checker.check_urls(new_urls)
                    dead_repls = {r.url for r in repl_results if not r.is_alive}
                    if dead_repls:
                        logger.warning(f"    Skipping {len(dead_repls)} dead replacement URLs")
                        verified_replacements = {
                            k: v for k, v in replacement_map.items()
                            if v.get("new_url") not in dead_repls
                        }

            # Apply replacements
            for old_url, repl_data in verified_replacements.items():
                new_url = repl_data.get("new_url")
                if not new_url:
                    continue

                # Find fields containing this URL
                fields = url_field_map.get(old_url, [])

                source_name = repl_data.get("source_name", "Source")
                anchor_text = repl_data.get("anchor_text", "")

                for field in fields:
                    # Skip video_url - should only contain YouTube URLs, not replacements
                    if field == "video_url":
                        continue

                    # Special handling for Sources (list of dicts)
                    if field == "Sources":
                        sources = article.get("Sources", [])
                        if isinstance(sources, list):
                            for source in sources:
                                if isinstance(source, dict) and source.get("url") == old_url:
                                    source["url"] = new_url
                                    source["title"] = source_name
                                    replacements.append(URLReplacement(
                                        field_name=field,
                                        old_url=old_url,
                                        new_url=new_url,
                                        source_name=source_name,
                                        reason=repl_data.get("reason", "URL replaced"),
                                    ))
                                    logger.info(f"    Replaced: {old_url[:50]}... -> {new_url[:50]}... in Sources")
                        continue

                    content = article.get(field, "")
                    if old_url in content:
                        # Smart replacement: natural anchor text for HTML, source name for Sources
                        article[field] = smart_replace_url(
                            content=content,
                            field_name=field,
                            old_url=old_url,
                            new_url=new_url,
                            source_name=source_name,
                            anchor_text=anchor_text
                        )

                        replacements.append(URLReplacement(
                            field_name=field,
                            old_url=old_url,
                            new_url=new_url,
                            source_name=source_name,
                            reason=repl_data.get("reason", "URL replaced"),
                        ))

                        logger.info(f"    Replaced: {old_url[:50]}... -> {new_url[:50]}...")

                # Update verification result
                for result in url_results:
                    if result.url == old_url:
                        result.status = URLStatus.REPLACED
                        result.replacement_url = new_url
                        result.replacement_source = repl_data.get("source_name")
                        result.replacement_reason = repl_data.get("reason")

            logger.info(f"  Applied {len(replacements)} replacements")

        except Exception as e:
            logger.warning(f"  Replacement search failed: {e}")

    # -----------------------------------------
    # Step 4b: Remove unreplaceable dead/irrelevant URLs
    # -----------------------------------------
    removed_count = 0
    urls_to_remove = list(dead_urls)
    if input_data.replace_irrelevant:
        urls_to_remove.extend(irrelevant_urls)

    if input_data.remove_dead_urls and urls_to_remove:
        # Find URLs that weren't replaced
        replaced_old_urls = {r.old_url for r in replacements}
        unreplaceable_urls = [u for u in urls_to_remove if u not in replaced_old_urls]

        if unreplaceable_urls:
            logger.info(f"  Removing {len(unreplaceable_urls)} unreplaceable URLs...")

            # Collect HTML field removals for AI rewriting
            html_removals = []
            non_html_removals = []

            for bad_url in unreplaceable_urls:
                fields = url_field_map.get(bad_url, [])

                for field in fields:
                    # Special handling for Sources (list of dicts)
                    if field == "Sources":
                        sources = article.get("Sources", [])
                        if isinstance(sources, list):
                            original_len = len(sources)
                            article["Sources"] = [s for s in sources if not (isinstance(s, dict) and s.get("url") == bad_url)]
                            if len(article["Sources"]) < original_len:
                                removed_count += 1
                                logger.info(f"    Removed: {bad_url[:50]}... from Sources")
                        continue

                    content = article.get(field, "")
                    if bad_url in content:
                        if is_html_field(field):
                            # Collect for AI rewriting
                            context = extract_link_context(content, bad_url)
                            if context["sentence"]:
                                html_removals.append({
                                    "field": field,
                                    "url": bad_url,
                                    "sentence": context["sentence"],
                                    "anchor_text": context["anchor_text"],
                                })
                            else:
                                # Fallback: just strip the link
                                non_html_removals.append((field, bad_url))
                        else:
                            non_html_removals.append((field, bad_url))

            # AI-assisted rewriting for HTML fields
            if html_removals and verifier:
                logger.info(f"    AI rewriting {len(html_removals)} sentences with dead links...")
                try:
                    rewrites = await verifier.rewrite_for_removals_batch(
                        removals=html_removals,
                        keyword=input_data.keyword,
                    )
                    ai_calls += 1

                    # Apply rewrites
                    for removal in html_removals:
                        url = removal["url"]
                        field = removal["field"]
                        original_sentence = removal["sentence"]

                        rewrite = rewrites.get(url, {})
                        rewritten = rewrite.get("rewritten_sentence", "")

                        content = article.get(field, "")
                        if rewritten and original_sentence in content:
                            article[field] = content.replace(original_sentence, rewritten)
                            removed_count += 1
                            logger.info(f"    Rewrote: {url[:50]}... in {field}")
                        else:
                            # Fallback: just strip the link
                            article[field] = smart_remove_dead_url(content, field, url)
                            removed_count += 1
                            logger.info(f"    Stripped: {url[:50]}... from {field}")

                except Exception as e:
                    logger.warning(f"    AI rewrite failed, falling back to strip: {e}")
                    # Fallback: strip all HTML removals
                    for removal in html_removals:
                        content = article.get(removal["field"], "")
                        if removal["url"] in content:
                            article[removal["field"]] = smart_remove_dead_url(content, removal["field"], removal["url"])
                            removed_count += 1
                            logger.info(f"    Stripped: {removal['url'][:50]}... from {removal['field']}")
            elif html_removals:
                # No verifier, just strip
                for removal in html_removals:
                    content = article.get(removal["field"], "")
                    if removal["url"] in content:
                        article[removal["field"]] = smart_remove_dead_url(content, removal["field"], removal["url"])
                        removed_count += 1
                        logger.info(f"    Stripped: {removal['url'][:50]}... from {removal['field']}")

            # Handle non-HTML removals (video_url, etc.)
            for field, bad_url in non_html_removals:
                content = article.get(field, "")
                if bad_url in content:
                    article[field] = smart_remove_dead_url(content, field, bad_url)
                    removed_count += 1
                    logger.info(f"    Removed: {bad_url[:50]}... from {field}")

                    # Also clear video_title when clearing video_url
                    if field == "video_url":
                        article["video_title"] = ""

            # Update verification results
            for bad_url in unreplaceable_urls:
                for result in url_results:
                    if result.url == bad_url:
                        result.status = URLStatus.REMOVED

    # -----------------------------------------
    # Build Output
    # -----------------------------------------
    # Use HTTP check counts (per field descriptions: "passed verification" / "failed 4xx/5xx")
    # Final state (IRRELEVANT, REPLACED, REMOVED) is in url_results for detailed analysis

    output = Stage4Output(
        article=article,
        total_urls=len(urls),
        valid_urls=len(alive_urls),      # HTTP 2xx/3xx responses
        dead_urls=len(dead_urls),         # HTTP 4xx/5xx/timeout
        replaced_urls=len(replacements),
        removed_urls=removed_count,
        skipped_urls=skipped_count,
        url_results=url_results,
        replacements=replacements,
        ai_calls=ai_calls,
    )

    logger.info(f"Stage 4 complete. {len(replacements)} replaced, {removed_count} removed, {ai_calls} AI calls")

    return output


# =============================================================================
# JSON Interface (Micro-API)
# =============================================================================

async def run_from_json(input_json: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run Stage 4 from JSON input, return JSON output.

    Micro-API interface for integration with other stages or services.

    Args:
        input_json: Dictionary with Stage4Input fields

    Returns:
        Dictionary with Stage4Output fields
    """
    input_data = Stage4Input(**input_json)
    output = await run_stage_4(input_data)
    return output.model_dump()


async def run_from_file(input_path: str, output_path: Optional[str] = None) -> Dict[str, Any]:
    """
    Run Stage 4 from JSON file, optionally save output to file.

    Args:
        input_path: Path to input JSON file
        output_path: Optional path to save output JSON

    Returns:
        Dictionary with Stage4Output fields
    """
    # Read input
    with open(input_path, "r") as f:
        input_json = json.load(f)

    # Run
    result = await run_from_json(input_json)

    # Save output if path provided
    if output_path:
        with open(output_path, "w") as f:
            json.dump(result, f, indent=2)
        logger.info(f"Output saved to {output_path}")

    return result


# =============================================================================
# CLI
# =============================================================================

def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        description="Stage 4: URL Verification - Verify and fix broken links"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        required=True,
        help="Input JSON file path (Stage 2/3 output with article)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output JSON file path"
    )
    parser.add_argument(
        "--keyword", "-k",
        type=str,
        help="Primary keyword (overrides input file)"
    )
    parser.add_argument(
        "--skip-domains",
        type=str,
        nargs="+",
        default=["unsplash.com", "images.unsplash.com"],
        help="Domains to skip verification"
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="HTTP request timeout in seconds"
    )
    parser.add_argument(
        "--no-content-verify",
        action="store_true",
        help="Skip content relevance verification"
    )
    parser.add_argument(
        "--no-replacements",
        action="store_true",
        help="Skip finding replacements for dead URLs"
    )
    parser.add_argument(
        "--no-verify-replacements",
        action="store_true",
        help="Skip HTTP verification of replacement URLs"
    )
    parser.add_argument(
        "--no-remove-dead",
        action="store_true",
        help="Don't remove dead URLs when no replacement found"
    )
    parser.add_argument(
        "--no-replace-irrelevant",
        action="store_true",
        help="Don't replace irrelevant URLs (only dead URLs)"
    )
    parser.add_argument(
        "--max-urls-per-batch",
        type=int,
        default=10,
        help="Max URLs to process per AI batch call"
    )
    parser.add_argument(
        "--max-content-verify",
        type=int,
        default=10,
        help="Max URLs to verify content relevance"
    )
    parser.add_argument(
        "--max-concurrent",
        type=int,
        default=10,
        help="Max concurrent HTTP requests"
    )

    args = parser.parse_args()

    async def run():
        # Read input file
        with open(args.input, "r") as f:
            input_json = json.load(f)

        # Handle different input formats
        # Could be Stage4Input format or raw article output
        if "article" in input_json:
            # Already in Stage4Input format
            stage4_input = input_json
        else:
            # Assume it's raw article output, wrap it
            stage4_input = {
                "article": input_json,
                "keyword": args.keyword or input_json.get("primary_keyword", ""),
            }

        # Override from CLI args
        if args.keyword:
            stage4_input["keyword"] = args.keyword
        if args.skip_domains:
            stage4_input["skip_domains"] = args.skip_domains
        if args.timeout:
            stage4_input["timeout_seconds"] = args.timeout
        stage4_input["verify_content"] = not args.no_content_verify
        stage4_input["find_replacements"] = not args.no_replacements
        stage4_input["verify_replacement_urls"] = not args.no_verify_replacements
        stage4_input["remove_dead_urls"] = not args.no_remove_dead
        stage4_input["replace_irrelevant"] = not args.no_replace_irrelevant
        stage4_input["max_urls_per_batch"] = args.max_urls_per_batch
        stage4_input["max_content_verify"] = args.max_content_verify
        stage4_input["max_concurrent_http"] = args.max_concurrent

        # Run
        result = await run_from_json(stage4_input)

        # Save output if path provided
        if args.output:
            with open(args.output, "w") as f:
                json.dump(result, f, indent=2)
            logger.info(f"Output saved to {args.output}")

        # Print summary
        print("\n=== Stage 4 Results ===")
        print(f"Total URLs: {result['total_urls']}")
        print(f"Valid: {result['valid_urls']}")
        print(f"Dead: {result['dead_urls']}")
        print(f"Replaced: {result['replaced_urls']}")
        print(f"Removed: {result['removed_urls']}")
        print(f"Skipped: {result['skipped_urls']}")
        print(f"AI Calls: {result['ai_calls']}")

        if result['replacements']:
            print("\nReplacements:")
            for repl in result['replacements']:
                print(f"  [{repl['field_name']}] {repl['old_url'][:40]}...")
                print(f"    -> {repl['new_url'][:50]}...")

    asyncio.run(run())


if __name__ == "__main__":
    main()
