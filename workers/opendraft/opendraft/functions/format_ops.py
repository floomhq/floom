"""Formatting operations for Gemini function calling."""

import logging
import re
from pathlib import Path
from typing import Any, Dict, Optional

from google import genai
from google.genai import types

from opendraft.citations.compiler import CitationCompiler
from opendraft.citations.database import CitationDatabase
from opendraft.analytics import score_draft, compare_scores
from opendraft.analytics.metrics import calculate_sentence_variety, calculate_citation_density

logger = logging.getLogger(__name__)

# Load voice_polish prompt for LLM refinement
_VOICE_POLISH_PROMPT: Optional[str] = None

def _get_voice_polish_prompt() -> str:
    """Load the voice_polish prompt lazily."""
    global _VOICE_POLISH_PROMPT
    if _VOICE_POLISH_PROMPT is None:
        prompt_path = Path(__file__).parent.parent / "prompts" / "voice_polish.md"
        if prompt_path.exists():
            _VOICE_POLISH_PROMPT = prompt_path.read_text(encoding='utf-8')
        else:
            _VOICE_POLISH_PROMPT = "Refine this academic text for quality."
    return _VOICE_POLISH_PROMPT

# --- Deterministic cleanup patterns ---

# Filler transitions to strip from sentence starts
_FILLER_STARTS = [
    r"Furthermore,\s*",
    r"Moreover,\s*",
    r"Additionally,\s*",
    r"It is worth noting that\s*",
    r"It should be noted that\s*",
    r"Importantly,\s*",
    r"It is important to note that\s*",
    r"In addition,\s*",
    r"Notably,\s*",
]

# Empty intensifiers before adjectives
_INTENSIFIERS = re.compile(
    r"\b(very|extremely|highly)\s+(?=[a-z])",
    re.IGNORECASE,
)

# Meta-commentary patterns (whole sentences starting with these)
_META_PATTERNS = [
    r"This section discusses\s+[^.]+\.\s*",
    r"This subsection examines\s+[^.]+\.\s*",
    r"This section explores\s+[^.]+\.\s*",
    r"This section provides\s+[^.]+\.\s*",
    r"This subsection provides\s+[^.]+\.\s*",
    r"This section reviews\s+[^.]+\.\s*",
    r"In this section,\s+we\s+[^.]+\.\s*",
    r"The following section\s+[^.]+\.\s*",
    r"The following subsection\s+[^.]+\.\s*",
]

# Verbose phrase → concise replacement
_VERBOSE_PHRASES = [
    (r"\bin order to\b", "to"),
    (r"\bdue to the fact that\b", "because"),
    (r"\ba large number of\b", "many"),
    (r"\bthe vast majority of\b", "most"),
    (r"\bat the present time\b", "now"),
    (r"\bin the event that\b", "if"),
    (r"\bhas the ability to\b", "can"),
    (r"\bprior to\b", "before"),
    (r"\bsubsequent to\b", "after"),
    (r"\bwith regard to\b", "regarding"),
    (r"\bwith respect to\b", "regarding"),
    (r"\bin spite of the fact that\b", "although"),
    (r"\bfor the purpose of\b", "to"),
    (r"\bis able to\b", "can"),
    (r"\ba significant number of\b", "many"),
    (r"\bin light of\b", "given"),
    (r"\bon the basis of\b", "based on"),
    (r"\bas a consequence of\b", "because of"),
]

# Common synonym chains to collapse
_SYNONYM_CHAINS = [
    (r"\bimportant,\s*essential,\s*and\s*paramount\b", "essential"),
    (r"\bcomprehensive,\s*thorough,\s*and\s*exhaustive\b", "thorough"),
    (r"\bcrucial,\s*vital,\s*and\s*critical\b", "critical"),
    (r"\bsignificant,\s*substantial,\s*and\s*considerable\b", "substantial"),
    (r"\brapid,\s*swift,\s*and\s*fast\b", "rapid"),
    (r"\bvast,\s*extensive,\s*and\s*far-reaching\b", "extensive"),
    (r"\brobust,\s*resilient,\s*and\s*durable\b", "robust"),
]

# Mid-document thesis restatements to neutralize (sentence-start only)
# Only matches patterns at sentence boundaries to preserve mid-sentence thesis
# statements like "The answer, as this paper argues, lies in..."
_THESIS_RESTATEMENTS = [
    # Sentence-start: "As this paper argues, X" → "As discussed, X"
    (r"(?<=\.\s)As\s+this\s+(?:paper|study)\s+argues?,?\s*", "As discussed, "),
    # Sentence-start: "This paper has argued that X" → "The analysis shows that X"
    (r"(?<=\.\s)This\s+(?:paper|study)\s+has\s+argued\s+that\b", "The analysis shows that"),
    # Sentence-start: "We argue that X" → "The evidence suggests that X"
    (r"(?<=\.\s)We\s+argue\s+that\b", "The evidence suggests that"),
    # Sentence-start: "The central argument..." → "A key finding..."
    (r"(?<=\.\s)The\s+central\s+argument\s+of\s+this\s+(?:paper|study)\b", "A key finding"),
    # Sentence-start: "This study demonstrates that" → "The analysis reveals that"
    (r"(?<=\.\s)This\s+study\s+demonstrates\s+that\b", "The analysis reveals that"),
    # V1-ported patterns: implicit thesis restatements
    (r"(?<=\.\s)As\s+established\s+earlier,?\s*", "As noted, "),
    (r"(?<=\.\s)The\s+findings?\s+we\s+discussed\b", "The earlier findings"),
    (r"(?<=\.\s)Our\s+analysis\s+confirms\s+(?:the\s+)?(?:core\s+)?premise\b", "The analysis indicates"),
    (r"(?<=\.\s)This\s+reveals\s+the\s+central\s+issue\b", "This highlights the issue"),
    (r"(?<=\.\s)As\s+(?:we\s+)?previously\s+noted,?\s*", "As noted, "),
    (r"(?<=\.\s)Returning\s+to\s+(?:our|the)\s+(?:main|central)\s+(?:point|argument)\b", "Building on this"),
    (r"(?<=\.\s)The\s+core\s+insight\s+(?:here\s+)?is\b", "A key observation is"),
    (r"(?<=\.\s)This\s+(?:finding|result)\s+supports\s+(?:our|the)\s+(?:main|central)\b", "This finding aligns with the"),
    (r"(?<=\.\s)Consistent\s+with\s+(?:our|the)\s+(?:central|main)\s+(?:thesis|argument)\b", "In line with the analysis"),
]

# --- V1 PORTS: Vocabulary Diversification (from entropy.md) ---
# Rotates overused words through synonyms to increase lexical diversity
# Format: (pattern, [list of synonyms to rotate through])
_VOCAB_DIVERSITY = [
    # "mechanism" → rotate through synonyms
    (r"\bmechanism\b", ["process", "pathway", "driver", "dynamic", "factor"]),
    # "vulnerability" → rotate through synonyms
    (r"\bvulnerability\b", ["susceptibility", "risk factor", "exposure", "sensitivity"]),
    # "significant" (when not "statistically significant") → rotate
    (r"\bsignificant\b(?!\s+(?:at|p\s*[<>=]|difference|effect))",
     ["substantial", "considerable", "notable", "marked", "meaningful"]),
    # "demonstrate" → rotate
    (r"\bdemonstrates?\b", ["shows", "reveals", "indicates", "illustrates", "establishes"]),
    # "utilize" → always "use"
    (r"\butilize[sd]?\b", ["use", "uses", "used"]),
    # "facilitate" → rotate
    (r"\bfacilitate[sd]?\b", ["enables", "supports", "helps", "allows"]),
    # "comprehensive" → rotate
    (r"\bcomprehensive\b", ["thorough", "extensive", "detailed", "wide-ranging"]),
    # "robust" → rotate
    (r"\brobust\b", ["strong", "reliable", "solid", "stable"]),
    # "paradigm" (unless citing Kuhn) → rotate
    (r"\bparadigm\b(?!\s+shift)", ["framework", "model", "approach", "perspective"]),
]

# --- V1 PORTS: Claim Calibration (from polish.md) ---
# Replaces overconfident claims with calibrated academic hedging
# Patterns designed to preserve grammatical correctness
_CLAIM_CALIBRATION = [
    # Absolute claims → hedged (with context-aware replacements)
    (r"\bis\s+indisputable\b", "is strongly supported"),
    (r"\bindisputable\s+evidence\b", "strong evidence"),
    (r"\bundeniable\b", "well-established"),
    (r"\bunquestionable\b", "well-documented"),
    (r"\bproves\s+conclusively\s+that\b", "provides strong support for the conclusion that"),
    (r"\bprove\s+conclusively\s+that\b", "provide strong support for the conclusion that"),
    (r"\bwithout\s+(?:a\s+)?doubt\b", "with high confidence"),
    (r"\bis\s+the\s+only\b", "is a primary"),
    (r"\bthe\s+only\s+solution\b", "a key solution"),
    (r"\bthe\s+only\s+approach\b", "a key approach"),
    (r"\bis\s+the\s+best\b", "is among the most effective"),
    (r"\bis\s+revolutionary\b", "represents a significant advancement"),
    (r"\brevolutionary\s+approach\b", "innovative approach"),
    (r"\bparadigm\s+shift\b", "significant development"),
    (r"\bis\s+always\b(?!\s+(?:been|had|have))", "is consistently"),
    (r"\bis\s+never\b(?!\s+(?:been|had|have))", "is rarely"),
    (r"\bis\s+perfect\b", "is highly accurate"),
    (r"\bsolves\s+the\s+problem\b", "addresses the challenge"),
    (r"\bproves\s+that\b", "supports the finding that"),
    (r"\bprove\s+that\b", "support the finding that"),
    (r"\bobviously\b", "notably"),
    (r"\bclearly\s+shows\b", "indicates"),
    (r"\bclearly\s+show\b", "indicate"),
    # V1-ported patterns: additional advocacy/prescriptive calibration
    (r"\bdemands\s+immediate\b", "merits timely"),
    (r"\bcritical\s+need\s+to\b", "opportunity to"),
    (r"\bessential\s+that\b", "valuable if"),
    (r"\bevery\s+(\w+)\s+should\b", r"organizations may"),
    (r"\bclearly\s+the\s+best\b", "a strong option"),
    (r"\bfundamentally\s+wrong\b", "potentially problematic"),
    (r"\babsolutely\s+(?:necessary|essential|critical)\b", "highly valuable"),
    (r"\bno\s+(?:one\s+)?(?:can|could)\s+deny\b", "evidence supports"),
    (r"\bit\s+is\s+imperative\b", "it would be valuable"),
    (r"\bwe\s+must\s+(?:act|take\s+action)\b", "action may be warranted"),
    (r"\bfailure\s+to\s+(?:act|address)\b", "if unaddressed"),
    (r"\burgently\s+(?:need|require)s?\b", "would benefit from"),
    (r"\bnon-negotiable\b", "important"),
    (r"\bself-evident\b", "apparent"),
    (r"\bbeyond\s+question\b", "well-supported"),
    (r"\bindisputably\b", "strongly supported"),
    (r"\bwe\s+advocate\s+for\b", "we propose"),
    (r"\bwe\s+advocate\b", "the evidence suggests"),
]


class FormatOps:
    """Formatting operations bound to a CitationDatabase instance."""

    def __init__(self, db: CitationDatabase, workspace_ops=None):
        self.db = db
        self.workspace_ops = workspace_ops

    def word_count(self, text: str) -> int:
        return len(text.split())

    def word_count_file(self, filename: str) -> str:
        """Count words in a workspace file without passing content through Gemini args."""
        if not self.workspace_ops:
            return "Error: workspace_ops not configured"
        content = self.workspace_ops.read_file(filename)
        if not content or content.startswith("File '"):
            return f"Error: could not read {filename}"
        count = len(content.split())
        return f"{filename}: {count} words"

    @staticmethod
    def _apply_basic_cleanup(text: str) -> str:
        """Apply the 3 most common filler removals (used in compile_draft too)."""
        for pattern in [r"Furthermore,\s*", r"Moreover,\s*", r"Additionally,\s*"]:
            text = re.sub(
                r"(?m)(^|\.\s+)" + pattern,
                lambda m: m.group(1),
                text,
            )
        return text

    @staticmethod
    def _apply_full_cleanup(text: str) -> dict:
        """Apply all deterministic cleanup patterns. Returns dict with cleaned text and stats."""
        stats = {"fillers": 0, "intensifiers": 0, "verbose": 0, "meta": 0, "synonyms": 0}

        # 1. Strip filler transitions at sentence start
        for pattern in _FILLER_STARTS:
            before = text
            text = re.sub(
                r"(?m)(^|\.\s+)" + pattern,
                lambda m: m.group(1),
                text,
            )
            if text != before:
                stats["fillers"] += 1

        # 2. Remove empty intensifiers
        text, n = _INTENSIFIERS.subn(r"", text)
        stats["intensifiers"] = n

        # 3. Collapse synonym chains
        for pattern, replacement in _SYNONYM_CHAINS:
            before = text
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
            if text != before:
                stats["synonyms"] += 1

        # 4. Strip meta-commentary
        for pattern in _META_PATTERNS:
            before = text
            text = re.sub(pattern, "", text)
            if text != before:
                stats["meta"] += 1

        # 5. Compress verbose phrases
        for pattern, replacement in _VERBOSE_PHRASES:
            before = text
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
            if text != before:
                stats["verbose"] += 1

        # 6. Neutralize mid-document thesis restatements
        stats["thesis"] = 0
        for pattern, replacement in _THESIS_RESTATEMENTS:
            before = text
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
            if text != before:
                stats["thesis"] += 1

        # 7. Vocabulary diversification (V1 entropy.md port)
        # Rotates overused words through synonyms to increase lexical diversity
        stats["vocab_diversified"] = 0
        for pattern, synonyms in _VOCAB_DIVERSITY:
            matches = list(re.finditer(pattern, text, flags=re.IGNORECASE))
            if len(matches) > 3:  # Only diversify if overused (>3 occurrences)
                # Keep first 2 occurrences, rotate rest through synonyms
                for i, match in enumerate(matches[2:], start=0):
                    synonym = synonyms[i % len(synonyms)]
                    # Preserve original case
                    if match.group().istitle():
                        synonym = synonym.title()
                    elif match.group().isupper():
                        synonym = synonym.upper()
                    # Replace this specific occurrence (work backwards to preserve positions)
                # Actually, simpler approach - do replacements from end to start
        # Re-implement with simpler logic
        for pattern, synonyms in _VOCAB_DIVERSITY:
            matches = list(re.finditer(pattern, text, flags=re.IGNORECASE))
            if len(matches) > 3:
                # Replace from end to preserve string positions
                for i, match in enumerate(reversed(matches[2:])):
                    idx = len(matches) - 3 - i  # Index in the list of matches to replace
                    synonym = synonyms[idx % len(synonyms)]
                    # Preserve case
                    if match.group().istitle():
                        synonym = synonym.title()
                    elif match.group().isupper():
                        synonym = synonym.upper()
                    text = text[:match.start()] + synonym + text[match.end():]
                    stats["vocab_diversified"] += 1

        # 8. Claim calibration (V1 polish.md port)
        # Replaces overconfident claims with calibrated academic hedging
        stats["claims_calibrated"] = 0
        for pattern, replacement in _CLAIM_CALIBRATION:
            before = text
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
            if text != before:
                stats["claims_calibrated"] += len(re.findall(pattern, before, flags=re.IGNORECASE))

        # 9. Remove duplicate ## References headings (keep last one only)
        refs_splits = re.split(r"\n##\s+References\s*\n", text)
        if len(refs_splits) > 2:
            # Keep everything before the first ## References + everything after the last one
            # with only one ## References heading
            text = refs_splits[0]
            for part in refs_splits[1:-1]:
                text += "\n" + part
            text += "\n## References\n" + refs_splits[-1]

        # 10. Clean up double whitespace left by removals
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = re.sub(r"  +", " ", text)

        return {"text": text, "stats": stats}

    def clean_draft(self, input_filename: str = "draft.md", output_filename: str = "draft_clean.md") -> str:
        """Apply deterministic prose cleanup to a draft file.

        Applies 10-step cleanup:
        1. Filler transitions (Furthermore, Moreover, etc.)
        2. Empty intensifiers (very, extremely, highly)
        3. Synonym chains
        4. Meta-commentary (This section discusses...)
        5. Verbose phrases (in order to → to)
        6. Thesis restatements
        7. Vocabulary diversification (rotates overused words through synonyms)
        8. Claim calibration (replaces overconfident language with hedging)
        9. Duplicate References headings
        10. Whitespace cleanup

        Also runs quality analytics before/after to measure improvement.

        Reads and writes server-side — no need to pass content through Gemini args.
        """
        if not self.workspace_ops:
            return "Error: workspace_ops not configured"

        content = self.workspace_ops.read_file(input_filename)
        if not content or content.startswith("File '"):
            return f"Error: could not read {input_filename}"

        # --- ANALYTICS: Score BEFORE cleanup ---
        score_before = score_draft(content)
        logger.info("Quality score BEFORE cleanup: %.1f", score_before['overall_score'])

        words_before = len(content.split())
        result = self._apply_full_cleanup(content)
        cleaned = result["text"]
        stats = result["stats"]
        words_after = len(cleaned.split())

        self.workspace_ops.write_file(output_filename, cleaned)

        # --- ANALYTICS: Score AFTER cleanup ---
        score_after = score_draft(cleaned)
        comparison = compare_scores(score_before, score_after)
        logger.info("Quality score AFTER cleanup: %.1f (delta: %+.1f)", score_after['overall_score'], comparison['overall_delta'])

        summary_parts = []
        if stats["fillers"]:
            summary_parts.append(f"{stats['fillers']} fillers")
        if stats["intensifiers"]:
            summary_parts.append(f"{stats['intensifiers']} intensifiers")
        if stats["verbose"]:
            summary_parts.append(f"{stats['verbose']} verbose phrases")
        if stats["meta"]:
            summary_parts.append(f"{stats['meta']} meta-commentary")
        if stats["synonyms"]:
            summary_parts.append(f"{stats['synonyms']} synonym chains")
        if stats.get("thesis"):
            summary_parts.append(f"{stats['thesis']} thesis restatements")
        if stats.get("vocab_diversified"):
            summary_parts.append(f"{stats['vocab_diversified']} words diversified")
        if stats.get("claims_calibrated"):
            summary_parts.append(f"{stats['claims_calibrated']} claims calibrated")

        removals = ", ".join(summary_parts) if summary_parts else "no issues found"

        # Build analytics summary
        analytics_summary = (
            f"\n\n📊 QUALITY ANALYTICS:\n"
            f"  Before: {score_before['overall_score']:.1f}% | After: {score_after['overall_score']:.1f}% | Delta: {comparison['overall_delta']:+.1f}%\n"
            f"  TTR: {score_before['raw_metrics']['ttr']:.3f} → {score_after['raw_metrics']['ttr']:.3f}\n"
            f"  Sentence variety: {score_before['component_scores']['sentence_variety']:.0f}% → {score_after['component_scores']['sentence_variety']:.0f}%\n"
            f"  Citation density: {score_before['raw_metrics']['citation_density']['density']:.1f} → {score_after['raw_metrics']['citation_density']['density']:.1f}\n"
            f"  Gate status: {'PASS ✓' if score_after['passes_gate'] else 'NEEDS LLM REFINE'}"
        )

        return (
            f"Cleaned draft: {words_before} → {words_after} words. "
            f"Removed {removals}. Saved to {output_filename}."
            f"{analytics_summary}"
        )

    def score_quality(self, filename: str = "draft.md") -> str:
        """Score a draft's quality without modifying it.

        Returns comprehensive quality metrics including:
        - Overall score (0-100)
        - TTR (vocabulary diversity)
        - Sentence variety distribution
        - Citation density
        - Thesis restatement count
        - Advocacy language detection

        Use this to check quality before/after modifications.
        """
        if not self.workspace_ops:
            return "Error: workspace_ops not configured"

        content = self.workspace_ops.read_file(filename)
        if not content or content.startswith("File '"):
            return f"Error: could not read {filename}"

        score = score_draft(content)

        result = (
            f"📊 QUALITY SCORE for {filename}:\n\n"
            f"Overall: {score['overall_score']:.1f}% {'✓ PASSES GATE' if score['passes_gate'] else '✗ NEEDS WORK'}\n\n"
            f"Component Scores:\n"
        )

        for metric, value in score['component_scores'].items():
            result += f"  {metric}: {value:.1f}%\n"

        result += "\nRaw Metrics:\n"
        result += f"  TTR (vocabulary): {score['raw_metrics']['ttr']:.4f}\n"
        result += f"  Word count: {score['raw_metrics']['word_count']['word_count']:,}\n"
        result += f"  Citation density: {score['raw_metrics']['citation_density']['density']:.2f} per ¶\n"
        result += f"  Thesis count: {score['raw_metrics']['thesis_count']['count']}\n"
        result += f"  Advocacy issues: {score['raw_metrics']['advocacy']['total_issues']}\n"

        if score['recommendations']:
            result += "\nRecommendations:\n"
            for rec in score['recommendations'][:5]:
                result += f"  • {rec['issue']} → {rec['action']}\n"

        return result

    def compile_draft(self, output_filename: str = "draft.md") -> str:
        """Read all section_*.md files from workspace, combine into a single draft.

        Reads files in order (section_1.md, section_2.md, ...) and writes the
        combined content to output_filename. Also merges any expansion files
        (section_Nb.md, section_N_expansion.md, etc.) into their parent sections.
        This avoids passing full draft text through Gemini's function call arguments.
        """
        if not self.workspace_ops:
            return "Error: workspace_ops not configured"

        files = self.workspace_ops.list_files()
        if isinstance(files, list) and files == ["(workspace is empty)"]:
            return "Error: no files in workspace"

        # Find main section files and their expansions
        main_sections = {}  # section_num -> main filename
        expansion_files = {}  # section_num -> list of expansion filenames

        for f in files:
            # Match main section files: section_1.md, section_2.md, etc.
            main_match = re.match(r'section_(\d+)\.md$', f)
            if main_match:
                num = int(main_match.group(1))
                main_sections[num] = f
                continue

            # Match expansion files: section_2b.md, section_2_expansion.md, etc.
            exp_match = re.match(r'section_(\d+)[_b]', f)
            if exp_match and f.endswith('.md'):
                num = int(exp_match.group(1))
                if num not in expansion_files:
                    expansion_files[num] = []
                expansion_files[num].append(f)

        if not main_sections:
            return "Error: no section_*.md files found in workspace"

        # Sort section numbers
        section_nums = sorted(main_sections.keys())

        # Combine sections
        parts = []
        total_words = 0
        skipped = []
        merged_count = 0

        for num in section_nums:
            filename = main_sections[num]
            content = self.workspace_ops.read_file(filename)
            if content and not content.startswith("File '"):
                section_text = content.strip()

                # Merge any expansion files for this section
                if num in expansion_files:
                    for exp_file in sorted(expansion_files[num]):
                        exp_content = self.workspace_ops.read_file(exp_file)
                        if exp_content and not exp_content.startswith("File '"):
                            # Remove duplicate section headers from expansion files
                            exp_text = exp_content.strip()
                            # Remove section headers including "(Part N: ...)" variants
                            # Matches: "# Section 1:", "## 1.2 Title (Part 2: ...)", etc.
                            exp_text = re.sub(
                                r'^#{1,3}\s+'
                                r'(?:Section\s+\d+[:\s]|\d+(?:\.\d+)*\.?\s+[^(\n]*\(Part\s+\d+)'
                                r'[^\n]*\n',
                                '', exp_text, count=1, flags=re.MULTILINE
                            )
                            section_text += "\n\n" + exp_text
                            merged_count += 1
                            logger.info("Merged %s into section %s", exp_file, num)

                # Normalize lone # headings to ## (h1 → h2) since # is reserved for the title
                section_text = re.sub(r'^(#)\s+(\d+\.)', r'## \2', section_text, count=1, flags=re.MULTILINE)
                parts.append(section_text)
                total_words += len(section_text.split())
            else:
                skipped.append(filename)
                logger.warning("Section file %s is empty or unreadable, skipping", filename)

        if not parts:
            return "Error: all section files were empty"

        combined = "\n\n".join(parts)
        # Strip remaining "(Part N: ...)" suffixes from headers that survived merging
        combined = re.sub(
            r'(^#{1,3}\s+\d+(?:\.\d+)*\.?\s+[^(\n]+)\s*\(Part\s+\d+[^)]*\)',
            r'\1', combined, flags=re.MULTILINE
        )
        # Strip residual word targets from headings and HTML comments
        combined = re.sub(r'(\#{1,4}\s+.*?)\s*\(\d+\s*words?\)', r'\1', combined)
        combined = re.sub(r'\s*<!--\s*target:\s*\d+\s*words?\s*-->', '', combined)
        # Apply basic filler cleanup so validator/refiner receive cleaner text
        combined = self._apply_basic_cleanup(combined)

        # --- QUALITY GATE: Check sentence variety and citation density ---
        variety = calculate_sentence_variety(combined)
        citations = calculate_citation_density(combined)

        # Track state for retry limiting (max 1 block before allowing through)
        MAX_BLOCKS = 1
        state = getattr(self.workspace_ops, 'state', None)
        block_count = getattr(state, 'compile_block_count', 0) if state else 0

        # If we've already hit max blocks, skip quality checks entirely
        if block_count >= MAX_BLOCKS:
            logger.warning("Quality gate: bypassing checks after %s previous blocks", MAX_BLOCKS)
        else:
            # Check sentence variety - need at least 40% non-short sentences
            non_short_pct = variety['medium_pct'] + variety['long_pct']
            if non_short_pct < 40:
                block_reason = "sentence_variety"
                block_msg = (
                    f"⚠️ COMPILE BLOCKED: Sentence variety too low.\n"
                    f"Current: {variety['short_pct']:.0f}% short, {variety['medium_pct']:.0f}% medium, {variety['long_pct']:.0f}% long\n"
                    f"Required: At least 40% medium+long sentences.\n"
                    f"Fix: Rewrite sections with longer analytical sentences (15-35 words)."
                )

                # Log and track the block
                logger.warning("Quality gate blocked compile_draft: %s (attempt %s/%s)", block_reason, block_count + 1, MAX_BLOCKS)

                if state:
                    state.compile_block_count = block_count + 1
                    state.compile_block_reasons.append(block_reason)
                    if 'quality_gate_blocks' not in state.run_metadata:
                        state.run_metadata['quality_gate_blocks'] = []
                    state.run_metadata['quality_gate_blocks'].append({
                        'reason': block_reason,
                        'metrics': {'short_pct': variety['short_pct'], 'medium_pct': variety['medium_pct'], 'long_pct': variety['long_pct']},
                        'attempt': block_count + 1,
                    })

                return block_msg

            # Check citation density - need at least 1.0 per paragraph
            if citations['density'] < 1.0:
                block_reason = "citation_density"
                block_msg = (
                    f"⚠️ COMPILE BLOCKED: Citation density too low.\n"
                    f"Current: {citations['density']:.2f} citations per paragraph\n"
                    f"Required: At least 1.0 citations per paragraph.\n"
                    f"Fix: Add more citations to body paragraphs using citation_db_query()."
                )

                # Log and track the block
                logger.warning("Quality gate blocked compile_draft: %s (attempt %s/%s)", block_reason, block_count + 1, MAX_BLOCKS)

                if state:
                    state.compile_block_count = block_count + 1
                    state.compile_block_reasons.append(block_reason)
                    if 'quality_gate_blocks' not in state.run_metadata:
                        state.run_metadata['quality_gate_blocks'] = []
                    state.run_metadata['quality_gate_blocks'].append({
                        'reason': block_reason,
                        'metrics': {'density': citations['density'], 'total_citations': citations['total_citations'], 'paragraph_count': citations['paragraph_count']},
                        'attempt': block_count + 1,
                    })

                return block_msg

        self.workspace_ops.state.write_file(output_filename, combined)
        logger.info("Compiled %s sections into %s: %s words", len(parts), output_filename, total_words)
        result = f"Compiled {len(parts)} sections into {output_filename}. Total: {total_words} words."
        if skipped:
            result += f" Warning: {len(skipped)} section(s) were empty: {', '.join(skipped)}"
        # Check if word count meets minimum target
        MIN_WORDS = 21000
        if total_words < MIN_WORDS:
            result += f" ⚠️ BELOW TARGET: {total_words} words is {MIN_WORDS - total_words} words short of the 21,000 minimum. Consider expanding sections before finalizing."
        return result

    def compile_citations(self, draft_text: str) -> str:
        """Replace {cite_XXX} placeholders with formatted citations."""
        compiler = CitationCompiler(self.db)
        compiled, missing = compiler.compile_citations(draft_text)
        if missing:
            compiled += f"\n\n[Note: {len(missing)} missing citations: {', '.join(missing[:5])}]"
        return compiled

    def generate_bibliography(self) -> str:
        """Generate complete reference list."""
        compiler = CitationCompiler(self.db)
        return compiler.generate_bibliography()

    def finalize_draft(self, input_filename: str = "draft.md", output_filename: str = "final_draft.md") -> str:
        """Read draft from workspace, compile citations, append bibliography, write final draft.

        Also prepends frontmatter.md if it exists, and strips any existing
        References section from the body before appending the generated one.
        """
        if not self.workspace_ops:
            return "Error: workspace_ops not configured"
        draft = self.workspace_ops.read_file(input_filename)
        if not draft or draft.startswith("File '"):
            return f"Error: could not read {input_filename}"

        # Prepend frontmatter.md if it exists and draft doesn't already have YAML frontmatter
        if not draft.lstrip().startswith("---"):
            frontmatter = self.workspace_ops.read_file("frontmatter.md")
            if frontmatter and not frontmatter.startswith("File '"):
                draft = frontmatter.strip() + "\n\n" + draft

        # Strip residual word targets from headings and HTML comments
        draft = re.sub(r'(\#{1,4}\s+.*?)\s*\(\d+\s*words?\)', r'\1', draft)
        draft = re.sub(r'\s*<!--\s*target:\s*\d+\s*words?\s*-->', '', draft)

        # Strip any existing ## References section from the body before appending generated one
        draft = re.sub(r"\n##\s+References\s*\n[\s\S]*$", "", draft).rstrip()

        compiler = CitationCompiler(self.db)
        compiled, missing = compiler.compile_citations(draft)
        bibliography = compiler.generate_bibliography()

        final = compiled
        if bibliography:
            # bibliography already includes "\n\n## References\n\n" heading
            final += "\n\n---" + bibliography

        self.workspace_ops.write_file(output_filename, final)
        word_count = len(final.split())

        result = f"Finalized draft saved to {output_filename}. Word count: {word_count}."
        if missing:
            result += f" Missing citations: {', '.join(missing[:10])}"
        return result

    def detect_repetition(self, filename: str = "draft.md") -> Dict[str, Any]:
        """Detect thesis restatement and repeated phrases.

        Returns warnings only - does not block the pipeline.
        """
        if not self.workspace_ops:
            return {"error": "workspace_ops not configured"}
        content = self.workspace_ops.read_file(filename)
        if not content or content.startswith("File '"):
            return {"error": f"could not read {filename}"}

        warnings = []

        # Count thesis restatements
        thesis_patterns = [
            r'this\s+paper\s+argues?',
            r'the\s+central\s+argument',
            r'this\s+study\s+demonstrates?',
            r'we\s+argue\s+that',
        ]
        thesis_count = sum(len(re.findall(p, content, re.I)) for p in thesis_patterns)
        if thesis_count > 3:
            warnings.append({
                "type": "thesis_repetition",
                "count": thesis_count,
                "message": f"Thesis restated {thesis_count} times (expected 2-3)"
            })

        # Check for repeated phrases (same 5+ word sequence appearing 3+ times)
        words = content.lower().split()
        if len(words) > 100:
            phrase_counts = {}
            for i in range(len(words) - 4):
                phrase = " ".join(words[i:i+5])
                phrase_counts[phrase] = phrase_counts.get(phrase, 0) + 1
            repeated = [(p, c) for p, c in phrase_counts.items() if c >= 3]
            if repeated:
                warnings.append({
                    "type": "repeated_phrases",
                    "count": len(repeated),
                    "examples": [p for p, _ in sorted(repeated, key=lambda x: -x[1])[:3]]
                })

        return {
            "filename": filename,
            "warnings": warnings,
            "status": "pass" if not warnings else "needs_review"
        }

    def detect_advocacy_language(self, filename: str = "draft.md") -> Dict[str, Any]:
        """Detect prescriptive language inappropriate for academic tone.

        Returns warnings only - does not block the pipeline.
        """
        if not self.workspace_ops:
            return {"error": "workspace_ops not configured"}
        content = self.workspace_ops.read_file(filename)
        if not content or content.startswith("File '"):
            return {"error": f"could not read {filename}"}

        patterns = [
            (r'\bmust\s+be\s+adopted\b', "prescriptive"),
            (r'\bwe\s+advocate\b', "advocacy"),
            (r'\bundeniably\b', "overconfident"),
            (r'\bunquestionably\b', "overconfident"),
            (r'\bindisputably\b', "overconfident"),
            (r'\bobviously\b', "presumptive"),
            (r'\bclearly\s+must\b', "prescriptive"),
            (r'\bshould\s+immediately\b', "prescriptive"),
            (r'\bdemands?\s+that\s+we\b', "advocacy"),
        ]
        findings = []
        for pattern, category in patterns:
            matches = re.findall(pattern, content, re.I)
            if matches:
                findings.append({
                    "pattern": pattern.replace(r'\b', '').replace(r'\s+', ' '),
                    "category": category,
                    "count": len(matches)
                })

        return {
            "filename": filename,
            "findings": findings,
            "total_issues": sum(f["count"] for f in findings),
            "status": "pass" if not findings else "needs_review"
        }

    def llm_refine(
        self,
        input_filename: str = "draft_clean.md",
        output_filename: str = "draft_refined.md"
    ) -> str:
        """Apply LLM-based refinement to improve draft quality.

        Uses the voice_polish prompt to improve vocabulary diversity, sentence variety,
        claim calibration, and academic tone. Processes sections individually to avoid
        size limits, then combines them.

        Only call this if the quality gate FAILED (score < 85%) after clean_draft().
        """
        if not self.workspace_ops:
            return "Error: workspace_ops not configured"

        content = self.workspace_ops.read_file(input_filename)
        if not content or content.startswith("File '"):
            return f"Error: could not read {input_filename}"

        # Score before
        score_before = score_draft(content)
        if score_before['passes_gate']:
            return (
                f"Quality gate already PASSED ({score_before['overall_score']:.1f}%). "
                "LLM refinement is not needed."
            )

        # Split into sections by ## headings
        sections = re.split(r'(^##\s+.+$)', content, flags=re.MULTILINE)

        # Reconstruct section pairs: (heading, content)
        refined_parts = []
        i = 0

        # Handle any content before first ## heading
        if sections and not sections[0].startswith('##'):
            # Don't refine frontmatter/abstract, keep as-is
            refined_parts.append(sections[0])
            i = 1

        # Process remaining sections
        try:
            from opendraft.config import get_config
            config = get_config()
            client = genai.Client(api_key=config.google_api_key)

            voice_prompt = _get_voice_polish_prompt()

            while i < len(sections):
                if sections[i].startswith('##'):
                    heading = sections[i]
                    section_content = sections[i + 1] if i + 1 < len(sections) else ""
                    i += 2

                    # Skip References section
                    if 'References' in heading:
                        refined_parts.append(heading + section_content)
                        continue

                    # Only refine sections with substantial content
                    if len(section_content.split()) < 50:
                        refined_parts.append(heading + section_content)
                        continue

                    # Call Gemini to refine this section
                    try:
                        response = client.models.generate_content(
                            model="gemini-3-flash-preview",
                            contents=f"{voice_prompt}\n\n---\n\n{section_content}",
                            config=types.GenerateContentConfig(
                                temperature=0.3,  # Low temp for consistency
                                max_output_tokens=4096,
                            ),
                        )
                        refined_text = response.text if response.text else section_content
                        refined_parts.append(heading + "\n\n" + refined_text.strip())
                        logger.info("LLM refined section: %s", heading.strip())
                    except Exception as e:
                        logger.warning("LLM refine failed for section: %s", e)
                        refined_parts.append(heading + section_content)
                else:
                    refined_parts.append(sections[i])
                    i += 1

        except Exception as e:
            logger.error("LLM refine error: %s", e)
            return f"Error: LLM refinement failed - {e}"

        # Combine refined sections
        refined_content = "\n\n".join(refined_parts)

        # Score after
        score_after = score_draft(refined_content)
        comparison = compare_scores(score_before, score_after)

        # Write output
        self.workspace_ops.write_file(output_filename, refined_content)

        return (
            f"LLM refinement complete. Saved to {output_filename}.\n\n"
            f"📊 Quality: {score_before['overall_score']:.1f}% → {score_after['overall_score']:.1f}% "
            f"(delta: {comparison['overall_delta']:+.1f}%)\n"
            f"Gate status: {'PASS ✓' if score_after['passes_gate'] else 'Still below threshold'}"
        )
