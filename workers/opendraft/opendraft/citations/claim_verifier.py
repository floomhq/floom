"""Citation-Claim Semantic Verifier: verifies that citations match the claims they support."""

import re
import json
import logging
import hashlib
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Literal, Any
from concurrent.futures import ThreadPoolExecutor, as_completed

from google import genai
from google.genai import types

from opendraft.citations.database import CitationDatabase, Citation
from opendraft.config import get_config

logger = logging.getLogger(__name__)


@dataclass
class ClaimCitationPair:
    """A claim with its attached citation(s)."""
    claim: str
    citation_ids: List[str]
    section: str = ""
    context: str = ""


@dataclass
class CitationClaimVerdict:
    """Verdict for claim+citation semantic match."""
    claim: str
    citation_id: str
    citation_title: str
    verdict: Literal["RELEVANT", "IRRELEVANT", "UNCERTAIN"]
    confidence: float = 0.0
    reasoning: str = ""
    claim_topic: str = ""
    citation_topic: str = ""
    suggested_fix: str = ""  # What citation type would be appropriate (for IRRELEVANT)


@dataclass
class FIFOCache:
    """Simple FIFO cache with TTL for caching verification results."""
    max_size: int = 100
    ttl_seconds: int = 3600
    _cache: Dict[str, tuple] = field(default_factory=dict)
    _order: List[str] = field(default_factory=list)

    def _cache_key(self, claim: str, citation_id: str) -> str:
        """Generate cache key from claim and citation ID."""
        content = f"{claim.lower().strip()}:{citation_id}"
        return hashlib.md5(content.encode()).hexdigest()

    def get(self, claim: str, citation_id: str) -> Optional[CitationClaimVerdict]:
        """Get cached verdict if exists and not expired."""
        key = self._cache_key(claim, citation_id)
        if key in self._cache:
            verdict, timestamp = self._cache[key]
            if time.time() - timestamp < self.ttl_seconds:
                return verdict
            else:
                del self._cache[key]
                self._order.remove(key)
        return None

    def set(self, claim: str, citation_id: str, verdict: CitationClaimVerdict) -> None:
        """Cache a verdict."""
        key = self._cache_key(claim, citation_id)
        # Evict oldest if at capacity
        while len(self._cache) >= self.max_size and self._order:
            oldest_key = self._order.pop(0)
            self._cache.pop(oldest_key, None)
        self._cache[key] = (verdict, time.time())
        self._order.append(key)


# Prompts for extraction and judgment
EXTRACTION_PROMPT = """# CITATION-CLAIM EXTRACTOR

## Role
Extract claims from the text that have explicit {cite_XXX} markers attached.

## Input
Academic draft text with inline citations in format {cite_XXX}.

## Output Format
Return a JSON array:
```json
[
  {
    "claim": "The exact assertion being made (1-2 sentences max)",
    "citation_ids": ["cite_001"],
    "section": "Section name if identifiable",
    "context": "Brief surrounding context (10-20 words)"
  }
]
```

## Rules
1. Only extract claims with explicit {cite_XXX} markers
2. The claim should be the assertion being supported, not the entire sentence
3. If multiple citations support one claim, include all citation IDs
4. Extract max 25 claim-citation pairs (prioritize different sections)
5. Skip trivial claims like "X et al. studied this topic"
6. Include substantive claims that make factual assertions

## Example
Input: "Deep learning models consistently outperform traditional methods {cite_003}, achieving 95% accuracy on benchmark datasets."
Output: [{"claim": "Deep learning models consistently outperform traditional methods", "citation_ids": ["cite_003"], "section": "Results", "context": "achieving 95% accuracy on benchmark datasets"}]

## Text to Analyze
"""


JUDGE_PROMPT_TEMPLATE = """# CITATION RELEVANCE JUDGE

## Your Task
Determine if a citation semantically supports the claim it's attached to.

## Input
- **CLAIM**: "{claim}"
- **CITATION TITLE**: "{title}"
- **CITATION ABSTRACT**: "{abstract}"

## Output Format
Return ONLY valid JSON:
```json
{{
  "verdict": "RELEVANT" or "IRRELEVANT" or "UNCERTAIN",
  "confidence": 0.0 to 1.0,
  "reasoning": "2-3 sentence explanation with specific details from both claim and citation",
  "claim_topic": "What the claim is about (3-5 words)",
  "citation_topic": "What the citation is about (3-5 words)",
  "suggested_fix": "If IRRELEVANT: what type of citation would be appropriate (or null if RELEVANT/UNCERTAIN)"
}}
```

## Verdict Rules
- **RELEVANT**: The citation topic clearly relates to the claim topic. The citation could plausibly support this type of claim.
- **IRRELEVANT**: The topics are completely unrelated (e.g., psychology paper cited for satellite imagery claim).
- **UNCERTAIN**: Cannot determine relevance. Use this when:
  - The claim is too vague to judge (e.g., "recent studies show promising results")
  - Abstract is unavailable or uninformative
  - Topics are adjacent but connection is unclear
  - The claim doesn't make a specific factual assertion

## Confidence Calibration (IMPORTANT)
Do NOT default to 100% confidence. Use the full range:
- **95-100%**: Absolutely clear-cut case (child psychology cited for satellite imagery)
- **80-94%**: Strong match/mismatch with minor ambiguity
- **60-79%**: Moderate confidence, some reasonable doubt exists
- **40-59%**: Uncertain, could go either way
- **Below 40%**: Very uncertain, lean toward UNCERTAIN verdict

## Reasoning Requirements
Your reasoning MUST be 2-3 sentences and include:
1. What specific topic the claim addresses
2. What specific topic the citation covers
3. Why they do or don't align (with concrete details)

## Important
- Focus on TOPIC RELEVANCE, not whether the citation proves the specific claim
- A machine learning paper can be RELEVANT to a claim about AI accuracy even if specifics differ
- A child psychology paper is IRRELEVANT to a claim about satellite image classification
- Vague claims like "studies show X" without specifics should be UNCERTAIN
- When the claim lacks substance, use UNCERTAIN not RELEVANT
"""


class CitationClaimVerifier:
    """Verifies that citations semantically match the claims they support."""

    def __init__(
        self,
        citation_database: CitationDatabase,
        api_key: Optional[str] = None,
        model_name: str = "gemini-3-flash-preview",
        max_pairs: int = 25,
    ):
        """Initialize the verifier.

        Args:
            citation_database: The citation database to look up citations
            api_key: Google API key (uses config if not provided)
            model_name: Gemini model to use for extraction and judgment
            max_pairs: Maximum claim-citation pairs to extract
        """
        self.citation_lookup = {c.id: c for c in citation_database.citations}
        self.citation_db = citation_database
        self.model_name = model_name
        self.max_pairs = max_pairs
        self._cache = FIFOCache(max_size=100, ttl_seconds=3600)

        # Initialize Gemini client
        if api_key:
            self.client = genai.Client(api_key=api_key)
        else:
            config = get_config()
            self.client = genai.Client(api_key=config.google_api_key)

        # Tracking
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.api_calls = 0

    def _track_usage(self, response) -> None:
        """Extract and track token usage from a Gemini response."""
        self.api_calls += 1
        try:
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                metadata = response.usage_metadata
                if hasattr(metadata, 'prompt_token_count'):
                    self.total_input_tokens += metadata.prompt_token_count or 0
                if hasattr(metadata, 'candidates_token_count'):
                    self.total_output_tokens += metadata.candidates_token_count or 0
        except Exception as e:
            logger.debug("Could not extract token usage: %s", e)

    def _call_llm(self, prompt: str, max_retries: int = 3) -> str:
        """Call Gemini and return text response with retries."""
        for attempt in range(max_retries):
            try:
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=prompt,
                    config=types.GenerateContentConfig(
                        temperature=0.1,  # Low temperature for consistent extraction
                    ),
                )
                self._track_usage(response)
                return response.text or ""
            except Exception as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt
                    logger.warning("LLM call failed (attempt %s): %s. Retrying in %ss...", attempt + 1, e, wait_time)
                    time.sleep(wait_time)
                else:
                    logger.error("LLM call failed after %s attempts: %s", max_retries, e)
                    raise
        return ""

    def _parse_json_from_response(self, text: str) -> Any:
        """Parse JSON from LLM response, handling markdown code blocks."""
        # Strip markdown code blocks if present
        text = text.strip()
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

        try:
            return json.loads(text)
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse JSON: %s. Text: %s...", e, text[:200])
            return None

    def extract_claims_with_citations(self, text: str) -> List[ClaimCitationPair]:
        """Extract claims that have {cite_XXX} markers using LLM.

        Args:
            text: The draft text to analyze

        Returns:
            List of ClaimCitationPair objects
        """
        # Quick check: does the text even have citations?
        citation_pattern = r'\{cite_\d+\}'
        if not re.search(citation_pattern, text):
            logger.info("No citations found in text, skipping extraction")
            return []

        # Truncate very long texts to avoid context limits
        max_chars = 50000
        if len(text) > max_chars:
            logger.info("Truncating text from %s to %s chars for extraction", len(text), max_chars)
            text = text[:max_chars]

        prompt = EXTRACTION_PROMPT + text
        response_text = self._call_llm(prompt)

        parsed = self._parse_json_from_response(response_text)
        if not parsed or not isinstance(parsed, list):
            logger.warning("Failed to parse extraction response as list")
            return []

        pairs = []
        for item in parsed[:self.max_pairs]:
            if not isinstance(item, dict):
                continue
            claim = item.get("claim", "").strip()
            citation_ids = item.get("citation_ids", [])
            if not claim or not citation_ids:
                continue

            # Validate citation IDs exist
            valid_ids = [cid for cid in citation_ids if cid in self.citation_lookup]
            if not valid_ids:
                logger.debug("Skipping claim with no valid citation IDs: %s", citation_ids)
                continue

            pairs.append(ClaimCitationPair(
                claim=claim,
                citation_ids=valid_ids,
                section=item.get("section", ""),
                context=item.get("context", ""),
            ))

        logger.info("Extracted %s claim-citation pairs", len(pairs))
        return pairs

    def _verify_single_pair(
        self,
        claim: str,
        citation: Citation,
    ) -> CitationClaimVerdict:
        """Verify one claim against its citation's title/abstract.

        Args:
            claim: The claim text
            citation: The Citation object

        Returns:
            CitationClaimVerdict with the judgment
        """
        # Check cache first
        cached = self._cache.get(claim, citation.id)
        if cached:
            logger.debug("Cache hit for %s", citation.id)
            return cached

        abstract = citation.abstract or "Not available"
        # Truncate very long abstracts
        if len(abstract) > 1000:
            abstract = abstract[:1000] + "..."

        prompt = JUDGE_PROMPT_TEMPLATE.format(
            claim=claim,
            title=citation.title,
            abstract=abstract,
        )

        response_text = self._call_llm(prompt)
        parsed = self._parse_json_from_response(response_text)

        if not parsed or not isinstance(parsed, dict):
            logger.warning("Failed to parse judgment for %s", citation.id)
            verdict = CitationClaimVerdict(
                claim=claim,
                citation_id=citation.id,
                citation_title=citation.title,
                verdict="UNCERTAIN",
                confidence=0.0,
                reasoning="Failed to parse LLM response",
            )
        else:
            verdict_str = parsed.get("verdict", "UNCERTAIN").upper()
            if verdict_str not in ("RELEVANT", "IRRELEVANT", "UNCERTAIN"):
                verdict_str = "UNCERTAIN"

            confidence = parsed.get("confidence", 0.5)
            if not isinstance(confidence, (int, float)):
                confidence = 0.5
            confidence = max(0.0, min(1.0, float(confidence)))

            verdict = CitationClaimVerdict(
                claim=claim,
                citation_id=citation.id,
                citation_title=citation.title,
                verdict=verdict_str,
                confidence=confidence,
                reasoning=parsed.get("reasoning", ""),
                claim_topic=parsed.get("claim_topic", ""),
                citation_topic=parsed.get("citation_topic", ""),
                suggested_fix=parsed.get("suggested_fix", "") or "",
            )

        # Cache the result
        self._cache.set(claim, citation.id, verdict)
        return verdict

    def verify_pairs(
        self,
        pairs: List[ClaimCitationPair],
        max_workers: int = 5,
    ) -> List[CitationClaimVerdict]:
        """Verify each claim+citation pair.

        Args:
            pairs: List of claim-citation pairs to verify
            max_workers: Maximum parallel workers for verification

        Returns:
            List of CitationClaimVerdict objects
        """
        if not pairs:
            return []

        # Flatten pairs to individual (claim, citation) tuples
        verification_tasks = []
        for pair in pairs:
            for citation_id in pair.citation_ids:
                citation = self.citation_lookup.get(citation_id)
                if citation:
                    verification_tasks.append((pair.claim, citation, pair.section))

        if not verification_tasks:
            logger.warning("No valid verification tasks after flattening")
            return []

        logger.info("Verifying %s claim-citation pairs...", len(verification_tasks))

        results = []

        # Use parallel execution with rate limiting
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {}
            for claim, citation, section in verification_tasks:
                future = executor.submit(self._verify_single_pair, claim, citation)
                futures[future] = (claim, citation, section)

            for future in as_completed(futures):
                claim, citation, section = futures[future]
                try:
                    verdict = future.result()
                    results.append(verdict)
                except Exception as e:
                    logger.error("Verification failed for %s: %s", citation.id, e)
                    results.append(CitationClaimVerdict(
                        claim=claim,
                        citation_id=citation.id,
                        citation_title=citation.title,
                        verdict="UNCERTAIN",
                        confidence=0.0,
                        reasoning=f"Verification error: {str(e)[:100]}",
                    ))

        logger.info("Verified %s pairs", len(results))
        return results

    def format_report(self, results: List[CitationClaimVerdict]) -> str:
        """Format verification results as a markdown report.

        Args:
            results: List of verification verdicts

        Returns:
            Markdown-formatted report string
        """
        if not results:
            return "# Citation-Claim Verification Report\n\n**No claim-citation pairs found to verify.**\n"

        # Count verdicts
        relevant = [r for r in results if r.verdict == "RELEVANT"]
        irrelevant = [r for r in results if r.verdict == "IRRELEVANT"]
        uncertain = [r for r in results if r.verdict == "UNCERTAIN"]

        total = len(results)
        relevant_pct = (len(relevant) / total * 100) if total > 0 else 0
        irrelevant_pct = (len(irrelevant) / total * 100) if total > 0 else 0
        uncertain_pct = (len(uncertain) / total * 100) if total > 0 else 0

        lines = [
            "# Citation-Claim Verification Report",
            "",
            f"**Pairs Checked:** {total}",
            f"**Relevant:** {len(relevant)} ({relevant_pct:.0f}%)",
            f"**Mismatched:** {len(irrelevant)} ({irrelevant_pct:.0f}%)",
            f"**Uncertain:** {len(uncertain)} ({uncertain_pct:.0f}%)",
            "",
        ]

        # Mismatched citations (most important)
        if irrelevant:
            lines.extend([
                "---",
                "",
                "## MISMATCHED CITATIONS",
                "",
            ])
            for i, verdict in enumerate(irrelevant, 1):
                lines.extend([
                    f"**Issue {i}: Irrelevant Citation**",
                    f"- **Claim:** \"{verdict.claim[:100]}{'...' if len(verdict.claim) > 100 else ''}\"",
                    f"- **Citation:** {verdict.citation_id} - \"{verdict.citation_title[:80]}{'...' if len(verdict.citation_title) > 80 else ''}\"",
                    f"- **Problem:** {verdict.reasoning}",
                    f"- **Claim topic:** {verdict.claim_topic}",
                    f"- **Citation topic:** {verdict.citation_topic}",
                    f"- **Confidence:** {verdict.confidence * 100:.0f}%",
                ])
                if verdict.suggested_fix:
                    lines.append(f"- **Suggested fix:** {verdict.suggested_fix}")
                lines.append("")

        # Uncertain citations
        if uncertain:
            lines.extend([
                "---",
                "",
                "## UNCERTAIN CITATIONS",
                "",
                "*These citations could not be definitively verified (often due to missing abstracts).*",
                "",
            ])
            for verdict in uncertain[:10]:  # Limit to first 10
                lines.append(
                    f"- {verdict.citation_id}: \"{verdict.citation_title[:60]}...\" → \"{verdict.claim[:50]}...\" ({verdict.reasoning[:50]})"
                )
            if len(uncertain) > 10:
                lines.append(f"- ... and {len(uncertain) - 10} more")
            lines.append("")

        # Verified citations (brief summary)
        if relevant:
            lines.extend([
                "---",
                "",
                "## VERIFIED CITATIONS",
                "",
            ])
            for verdict in relevant[:15]:  # Limit to first 15
                claim_preview = verdict.claim[:40] + "..." if len(verdict.claim) > 40 else verdict.claim
                lines.append(
                    f"- {verdict.citation_id}: \"{verdict.citation_title[:50]}...\" supports \"{claim_preview}\""
                )
            if len(relevant) > 15:
                lines.append(f"- ... and {len(relevant) - 15} more verified citations")
            lines.append("")

        # Cost tracking
        lines.extend([
            "---",
            "",
            "## Verification Statistics",
            "",
            f"- API calls: {self.api_calls}",
            f"- Input tokens: {self.total_input_tokens:,}",
            f"- Output tokens: {self.total_output_tokens:,}",
        ])

        return "\n".join(lines)


def run_citation_claim_verification(
    draft_text: str,
    citation_db: CitationDatabase,
    api_key: Optional[str] = None,
    max_pairs: int = 25,
) -> Dict[str, Any]:
    """Convenience function to run full verification pipeline.

    Args:
        draft_text: The draft text to verify
        citation_db: The citation database
        api_key: Optional API key
        max_pairs: Maximum pairs to extract

    Returns:
        Dict with 'report', 'results', and 'stats'
    """
    verifier = CitationClaimVerifier(
        citation_database=citation_db,
        api_key=api_key,
        max_pairs=max_pairs,
    )

    # Extract pairs
    pairs = verifier.extract_claims_with_citations(draft_text)

    if not pairs:
        return {
            "report": "# Citation-Claim Verification Report\n\n**No claim-citation pairs found to verify.**\n",
            "results": [],
            "stats": {
                "total_pairs": 0,
                "relevant": 0,
                "irrelevant": 0,
                "uncertain": 0,
            },
        }

    # Verify pairs
    results = verifier.verify_pairs(pairs)

    # Format report
    report = verifier.format_report(results)

    # Calculate stats
    relevant = sum(1 for r in results if r.verdict == "RELEVANT")
    irrelevant = sum(1 for r in results if r.verdict == "IRRELEVANT")
    uncertain = sum(1 for r in results if r.verdict == "UNCERTAIN")

    return {
        "report": report,
        "results": results,
        "stats": {
            "total_pairs": len(results),
            "relevant": relevant,
            "irrelevant": irrelevant,
            "uncertain": uncertain,
            "api_calls": verifier.api_calls,
            "input_tokens": verifier.total_input_tokens,
            "output_tokens": verifier.total_output_tokens,
        },
    }
