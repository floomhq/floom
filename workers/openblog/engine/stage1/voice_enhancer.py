"""
Voice Enhancer - Refine Voice Persona from Real Blog Content

Analyzes actual blog content to enhance the initial voice_persona
extracted by OpenContext, grounding it in real writing examples.

Uses Gemini's URL Context tool to fetch blog content directly.
"""

import asyncio
import json
import logging
import random
import sys
from pathlib import Path
from typing import List, Optional, Dict, Any

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

from stage1_models import VoicePersona, LanguageStyle

try:
    from shared.gemini_client import GeminiClient
    from shared.prompt_loader import load_prompt
    from shared.constants import GEMINI_TIMEOUT_VOICE_ENHANCEMENT
except ImportError:
    GeminiClient = None
    load_prompt = None
    GEMINI_TIMEOUT_VOICE_ENHANCEMENT = 420  # 7 minutes fallback

logger = logging.getLogger(__name__)


def _get_voice_enhancement_prompt(
    initial_persona: VoicePersona,
    blog_urls: List[str],
) -> str:
    """
    Build the voice enhancement prompt.

    Args:
        initial_persona: Initial VoicePersona from OpenContext
        blog_urls: List of blog URLs to analyze (1-3 URLs)

    Returns:
        Formatted prompt string
    """
    # Format initial persona as JSON
    persona_json = initial_persona.model_dump_json(indent=2)

    # Format blog URLs as numbered list
    urls_list = "\n".join(f"{i+1}. {url}" for i, url in enumerate(blog_urls))

    if load_prompt is not None:
        try:
            return load_prompt(
                "stage1",
                "voice_enhancement",
                initial_voice_persona=persona_json,
                blog_urls=urls_list,
            )
        except FileNotFoundError:
            logger.warning("voice_enhancement.txt not found, using fallback prompt")

    # Fallback prompt
    return f"""Analyze these blog articles to refine the voice persona.

Initial Voice Persona:
{persona_json}

Blog Articles to Analyze (use URL Context tool to fetch each):
{urls_list}

Return an enhanced voice_persona JSON with concrete examples from real content."""


def _print_article_analysis(article_analysis: List[Dict[str, Any]]) -> None:
    """
    Print detailed article analysis to console for verification.

    Args:
        article_analysis: List of article analysis dicts from Gemini response
    """
    print("\n" + "=" * 80)
    print("📚 VOICE ENHANCEMENT - ARTICLE ANALYSIS")
    print("=" * 80)

    for i, article in enumerate(article_analysis, 1):
        print(f"\n{'─' * 80}")
        print(f"📄 ARTICLE {i}: {article.get('title', 'Unknown Title')}")
        print(f"{'─' * 80}")
        print(f"🔗 URL: {article.get('url', 'N/A')}")

        # Opening
        opening = article.get('opening_verbatim', '')
        if opening:
            print(f"\n📖 OPENING ({article.get('opening_type', 'unknown type')}):")
            print(f"   \"{opening[:500]}{'...' if len(opening) > 500 else ''}\"")

        # Closing
        closing = article.get('closing_verbatim', '')
        if closing:
            print(f"\n📝 CLOSING:")
            print(f"   \"{closing[:500]}{'...' if len(closing) > 500 else ''}\"")

        # Subheadings
        subheadings = article.get('subheadings_found', [])
        if subheadings:
            print(f"\n📋 SUBHEADINGS FOUND ({len(subheadings)}):")
            for sh in subheadings[:10]:
                print(f"   • {sh}")

        # Key phrases
        phrases = article.get('key_phrases_extracted', [])
        if phrases:
            print(f"\n💬 KEY PHRASES EXTRACTED ({len(phrases)}):")
            for phrase in phrases[:10]:
                print(f"   • \"{phrase}\"")

        # Stats
        print(f"\n📊 METRICS:")
        print(f"   • Word count: ~{article.get('word_count_estimate', 'N/A')}")
        print(f"   • Avg sentence length: {article.get('avg_sentence_length', 'N/A')} words")
        print(f"   • Uses lists: {article.get('uses_lists', 'N/A')}")
        print(f"   • Uses statistics: {article.get('uses_statistics', 'N/A')}")
        print(f"   • Tone: {article.get('tone_observed', 'N/A')}")

    print("\n" + "=" * 80)


def _print_enhanced_persona(persona: VoicePersona, result: Dict[str, Any]) -> None:
    """
    Print the enhanced voice persona details to console.

    Args:
        persona: The enhanced VoicePersona object
        result: Raw result dict (may contain additional fields)
    """
    print("\n" + "=" * 80)
    print("✨ ENHANCED VOICE PERSONA")
    print("=" * 80)

    print(f"\n👤 ICP PROFILE:")
    print(f"   {persona.icp_profile or 'Not specified'}")

    print(f"\n🎯 VOICE STYLE:")
    print(f"   {persona.voice_style or 'Not specified'}")

    print(f"\n📐 LANGUAGE STYLE:")
    ls = persona.language_style
    print(f"   • Formality: {ls.formality}")
    print(f"   • Complexity: {ls.complexity}")
    print(f"   • Sentence length: {ls.sentence_length}")
    print(f"   • Perspective: {ls.perspective}")
    if ls.avg_words_per_sentence:
        print(f"   • Avg words/sentence: {ls.avg_words_per_sentence}")
    if ls.reading_level:
        print(f"   • Reading level: {ls.reading_level}")

    if persona.example_phrases:
        print(f"\n💬 EXAMPLE PHRASES ({len(persona.example_phrases)}):")
        for phrase in persona.example_phrases:
            print(f"   • \"{phrase}\"")

    if persona.opening_styles:
        print(f"\n📖 OPENING STYLES ({len(persona.opening_styles)}):")
        for style in persona.opening_styles:
            print(f"   • {style}")

    if persona.transition_phrases:
        print(f"\n🔄 TRANSITION PHRASES ({len(persona.transition_phrases)}):")
        for phrase in persona.transition_phrases:
            print(f"   • \"{phrase}\"")

    if persona.closing_styles:
        print(f"\n📝 CLOSING STYLES ({len(persona.closing_styles)}):")
        for style in persona.closing_styles:
            print(f"   • {style}")

    if persona.technical_terms:
        print(f"\n🔧 TECHNICAL TERMS ({len(persona.technical_terms)}):")
        print(f"   {', '.join(persona.technical_terms)}")

    if persona.power_words:
        print(f"\n⚡ POWER WORDS ({len(persona.power_words)}):")
        print(f"   {', '.join(persona.power_words)}")

    if persona.headline_patterns:
        print(f"\n📰 HEADLINE PATTERNS ({len(persona.headline_patterns)}):")
        for pattern in persona.headline_patterns:
            print(f"   • {pattern}")

    if persona.subheading_styles:
        print(f"\n📋 SUBHEADING STYLES ({len(persona.subheading_styles)}):")
        for style in persona.subheading_styles:
            print(f"   • {style}")

    if persona.cta_phrases:
        print(f"\n🎬 CTA PHRASES ({len(persona.cta_phrases)}):")
        for cta in persona.cta_phrases:
            print(f"   • \"{cta}\"")

    if persona.do_list:
        print(f"\n✅ DO LIST ({len(persona.do_list)}):")
        for item in persona.do_list:
            print(f"   • {item}")

    if persona.dont_list:
        print(f"\n❌ DON'T LIST ({len(persona.dont_list)}):")
        for item in persona.dont_list:
            print(f"   • {item}")

    if persona.banned_words:
        print(f"\n🚫 BANNED WORDS ({len(persona.banned_words)}):")
        print(f"   {', '.join(persona.banned_words)}")

    # Additional observations
    print(f"\n📊 CONTENT PATTERNS:")
    if persona.paragraph_length:
        print(f"   • Paragraph length: {persona.paragraph_length}")
    if persona.uses_questions is not None:
        print(f"   • Uses rhetorical questions: {persona.uses_questions}")
    if persona.uses_lists is not None:
        print(f"   • Uses bullet/numbered lists: {persona.uses_lists}")
    if persona.uses_statistics is not None:
        print(f"   • Uses statistics/data: {persona.uses_statistics}")
    if persona.first_person_usage:
        print(f"   • First person usage: {persona.first_person_usage}")
    if persona.content_structure_pattern:
        print(f"   • Structure pattern: {persona.content_structure_pattern}")

    print("\n" + "=" * 80)


async def enhance_voice_persona(
    initial_persona: VoicePersona,
    blog_urls: List[str],
    gemini_client: Optional[GeminiClient] = None,
    api_key: Optional[str] = None,
    sample_size: int = 3,
    verbose: bool = True,
) -> VoicePersona:
    """
    Enhance voice persona by analyzing real blog content.

    Uses Gemini's URL Context tool to fetch and analyze blog articles,
    then refines the initial voice_persona with concrete examples.

    Args:
        initial_persona: Initial VoicePersona from OpenContext
        blog_urls: List of all available blog URLs
        gemini_client: Optional existing GeminiClient instance
        api_key: Gemini API key (only used if gemini_client not provided)
        sample_size: Number of blog posts to sample (default: 3)
        verbose: Print detailed extraction results to console (default: True)

    Returns:
        Enhanced VoicePersona with real examples

    Raises:
        Exception: If Gemini call fails (caller should handle gracefully)
    """
    if not blog_urls:
        logger.warning("No blog URLs provided for voice enhancement")
        return initial_persona

    # Sample URLs - prefer random selection
    sample_count = min(sample_size, len(blog_urls))
    sampled_urls = random.sample(blog_urls, sample_count)

    logger.info(f"Enhancing voice persona using {sample_count} blog URLs")

    if verbose:
        print("\n" + "=" * 80)
        print("🔍 VOICE ENHANCEMENT - ANALYZING BLOG CONTENT")
        print("=" * 80)
        print(f"\n📌 Analyzing {sample_count} blog articles:")
        for i, url in enumerate(sampled_urls, 1):
            print(f"   {i}. {url}")
        print("\n⏳ Fetching and analyzing content with Gemini...")

    # Create client if not provided
    if gemini_client is None:
        if GeminiClient is None:
            raise ImportError("shared.gemini_client not available")
        gemini_client = GeminiClient(api_key=api_key)

    # Build prompt
    prompt = _get_voice_enhancement_prompt(initial_persona, sampled_urls)

    # Call Gemini with URL Context (to fetch blog content)
    # Voice enhancement needs extra time - it fetches multiple blog URLs and does deep analysis
    result = await gemini_client.generate(
        prompt=prompt,
        use_url_context=True,
        use_google_search=False,  # Don't need search, just URL Context
        json_output=True,
        temperature=0.3,
        max_tokens=16384,  # Need more tokens for detailed analysis
        timeout=GEMINI_TIMEOUT_VOICE_ENHANCEMENT,  # 7 minutes - longer than default grounding timeout
    )

    logger.debug(f"Voice enhancement result keys: {result.keys() if isinstance(result, dict) else 'not a dict'}")

    # Print article analysis if available
    if verbose and isinstance(result, dict):
        article_analysis = result.get('article_analysis', [])
        if article_analysis:
            _print_article_analysis(article_analysis)
        else:
            print("\n⚠️  No article_analysis found in response")

    # Parse result into VoicePersona
    try:
        # Handle nested language_style
        if "language_style" in result and isinstance(result["language_style"], dict):
            result["language_style"] = LanguageStyle(**result["language_style"])

        # Remove article_analysis from result before creating VoicePersona
        # (it's not a field in the model)
        persona_data = {k: v for k, v in result.items() if k != 'article_analysis'}

        enhanced = VoicePersona(**persona_data)

        if verbose:
            _print_enhanced_persona(enhanced, result)

        logger.info("Voice persona enhanced successfully")
        return enhanced

    except Exception as e:
        logger.warning(f"Failed to parse enhanced voice persona: {e}")
        logger.warning("Returning initial voice persona unchanged")

        if verbose:
            print(f"\n❌ ERROR: Failed to parse enhanced persona: {e}")
            print("   Returning initial voice persona unchanged")

        return initial_persona


async def sample_and_enhance(
    initial_persona: VoicePersona,
    blog_urls: List[str],
    gemini_client: Optional[GeminiClient] = None,
    api_key: Optional[str] = None,
    sample_size: int = 3,
    min_blogs_required: int = 3,
    verbose: bool = True,
) -> tuple[VoicePersona, List[str], bool]:
    """
    Sample blog URLs and enhance voice persona.

    Convenience function that handles the full flow:
    1. Check if enough blog URLs are available
    2. Sample URLs
    3. Enhance voice persona
    4. Return results with metadata

    Args:
        initial_persona: Initial VoicePersona from OpenContext
        blog_urls: List of all available blog URLs
        gemini_client: Optional existing GeminiClient instance
        api_key: Gemini API key (only used if gemini_client not provided)
        sample_size: Number of blog posts to sample (default: 3)
        min_blogs_required: Minimum blogs needed to trigger enhancement (default: 3)
        verbose: Print detailed extraction results to console (default: True)

    Returns:
        Tuple of (enhanced_persona, sampled_urls, was_enhanced)
    """
    # Check if we have enough blogs
    if len(blog_urls) < min_blogs_required:
        logger.info(
            f"Not enough blog URLs for voice enhancement "
            f"({len(blog_urls)} < {min_blogs_required}), skipping"
        )
        return initial_persona, [], False

    # Sample URLs
    sample_count = min(sample_size, len(blog_urls))
    sampled_urls = random.sample(blog_urls, sample_count)

    try:
        enhanced = await enhance_voice_persona(
            initial_persona=initial_persona,
            blog_urls=sampled_urls,
            gemini_client=gemini_client,
            api_key=api_key,
            sample_size=sample_size,
            verbose=verbose,
        )
        return enhanced, sampled_urls, True

    except Exception as e:
        logger.warning(f"Voice enhancement failed: {e}")
        logger.warning("Continuing with initial voice persona")

        if verbose:
            print(f"\n❌ Voice enhancement failed: {e}")
            print("   Continuing with initial voice persona")

        return initial_persona, sampled_urls, False


# =============================================================================
# CLI for standalone testing
# =============================================================================

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python voice_enhancer.py <blog_url1> [blog_url2] [blog_url3]")
        print("\nExample:")
        print("  python voice_enhancer.py https://example.com/blog/post1 https://example.com/blog/post2")
        sys.exit(1)

    blog_urls = sys.argv[1:]

    # Create a basic initial persona for testing
    initial = VoicePersona(
        icp_profile="Test ICP",
        voice_style="Professional and informative",
    )

    async def main():
        print("\n🚀 Starting Voice Enhancement Test")
        print(f"   URLs to analyze: {len(blog_urls)}")

        enhanced, urls, was_enhanced = await sample_and_enhance(
            initial_persona=initial,
            blog_urls=blog_urls,
            min_blogs_required=1,  # Lower threshold for testing
            verbose=True,
        )

        print("\n" + "=" * 80)
        print("📋 FINAL RESULT SUMMARY")
        print("=" * 80)
        print(f"\n✅ Enhancement completed: {was_enhanced}")
        print(f"📄 URLs analyzed: {len(urls)}")

        # Also dump full JSON for inspection
        print("\n📦 FULL JSON OUTPUT:")
        print(json.dumps(enhanced.model_dump(), indent=2))

    asyncio.run(main())
