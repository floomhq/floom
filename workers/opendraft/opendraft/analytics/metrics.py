"""
Core metrics calculations for draft quality analysis.

All functions are pure - text in, metrics out. No side effects.
"""

import re
from typing import Dict, Any


def calculate_ttr(text: str, window_size: int = 1000) -> float:
    """
    Calculate Moving Average Type-Token Ratio (MATTR) for vocabulary diversity.

    For long documents, standard TTR decreases naturally as word count grows.
    MATTR calculates TTR over sliding windows and averages, giving a length-
    independent measure of vocabulary diversity.

    Academic target: 0.35-0.45

    Args:
        text: Input text
        window_size: Size of sliding window (default 1000 words)

    Returns:
        MATTR as float between 0.0 and 1.0
    """
    # Extract words (alphanumeric, lowercased)
    words = re.findall(r'\b[a-zA-Z]+\b', text.lower())

    if not words:
        return 0.0

    # For short texts, use standard TTR
    if len(words) <= window_size:
        unique_words = set(words)
        return len(unique_words) / len(words)

    # Calculate MATTR: average TTR over sliding windows
    ttr_values = []
    for i in range(len(words) - window_size + 1):
        window = words[i:i + window_size]
        unique = len(set(window))
        ttr_values.append(unique / window_size)

    # Return average MATTR
    return sum(ttr_values) / len(ttr_values)


def calculate_sentence_variety(text: str) -> Dict[str, Any]:
    """
    Analyze sentence length distribution.

    Good academic writing has varied sentence lengths:
    - Short (< 12 words): 20-35% - punchy, clear
    - Medium (12-25 words): 40-55% - standard
    - Long (> 25 words): 15-30% - complex ideas

    Args:
        text: Input text

    Returns:
        Dict with percentages and variety_score (0-100)
    """
    # Split into sentences
    sentences = re.split(r'[.!?]+', text)
    sentences = [s.strip() for s in sentences if s.strip()]

    if not sentences:
        return {
            'short_pct': 0.0,
            'medium_pct': 0.0,
            'long_pct': 0.0,
            'variety_score': 0.0,
            'sentence_count': 0,
        }

    # Categorize by word count
    short = 0  # < 12 words
    medium = 0  # 12-25 words
    long = 0  # > 25 words

    for sentence in sentences:
        word_count = len(sentence.split())
        if word_count < 12:
            short += 1
        elif word_count <= 25:
            medium += 1
        else:
            long += 1

    total = len(sentences)
    short_pct = (short / total) * 100
    medium_pct = (medium / total) * 100
    long_pct = (long / total) * 100

    # Variety score: how close to ideal distribution?
    # Ideal: 25% short, 50% medium, 25% long
    # Penalize deviation from ideal
    ideal_short = 27.5  # midpoint of 20-35
    ideal_medium = 47.5  # midpoint of 40-55
    ideal_long = 22.5  # midpoint of 15-30

    deviation = (
        abs(short_pct - ideal_short) +
        abs(medium_pct - ideal_medium) +
        abs(long_pct - ideal_long)
    ) / 3

    # Max deviation is ~33 (all one category), score 0-100
    variety_score = max(0, 100 - (deviation * 3))

    return {
        'short_pct': round(short_pct, 1),
        'medium_pct': round(medium_pct, 1),
        'long_pct': round(long_pct, 1),
        'variety_score': round(variety_score, 1),
        'sentence_count': total,
    }


def calculate_citation_density(text: str) -> Dict[str, Any]:
    """
    Calculate citation density per paragraph.

    Academic target: 2+ citations per paragraph.

    Args:
        text: Input text with {cite_XXX} placeholders or (Author, Year) citations

    Returns:
        Dict with density metrics
    """
    # Count citations (both placeholder and compiled formats)
    cite_placeholders = len(re.findall(r'\{cite_\w+\}', text))
    cite_parenthetical = len(re.findall(r'\([A-Z][a-z]+(?:\s+et\s+al\.?)?,?\s+\d{4}\)', text))
    total_citations = cite_placeholders + cite_parenthetical

    # Count paragraphs (double newline separated, non-empty)
    paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]
    # Filter out headings-only paragraphs
    content_paragraphs = [p for p in paragraphs if not p.startswith('#') and len(p) > 100]

    paragraph_count = len(content_paragraphs) or 1

    density = total_citations / paragraph_count

    return {
        'total_citations': total_citations,
        'paragraph_count': paragraph_count,
        'density': round(density, 2),
        'meets_target': density >= 2.0,
    }


def count_thesis_statements(text: str) -> Dict[str, Any]:
    """
    Count thesis restatements in the text.

    Academic best practice: 2-3 thesis statements max
    (introduction + conclusion, maybe one reminder).

    Args:
        text: Input text

    Returns:
        Dict with count and assessment
    """
    patterns = [
        # Original explicit patterns
        r'this\s+paper\s+argues?',
        r'this\s+study\s+argues?',
        r'the\s+central\s+argument',
        r'this\s+(?:paper|study)\s+demonstrates?',
        r'we\s+argue\s+that',
        r'the\s+thesis\s+of\s+this',
        r'this\s+analysis\s+shows?\s+that',
        # V1-ported patterns: implicit thesis restatements
        r'as\s+established\s+earlier',
        r'the\s+finding[s]?\s+we\s+discussed',
        r'our\s+analysis\s+confirms\s+(?:the\s+)?(?:core\s+)?premise',
        r'this\s+reveals\s+the\s+central\s+issue',
        r'as\s+(?:we\s+)?previously\s+noted',
        r'returning\s+to\s+(?:our|the)\s+(?:main|central)\s+(?:point|argument)',
        r'the\s+core\s+insight\s+(?:here\s+)?is',
        r'this\s+(?:finding|result)\s+supports\s+(?:our|the)\s+(?:main|central)',
        r'consistent\s+with\s+(?:our|the)\s+(?:central|main)\s+(?:thesis|argument)',
    ]

    total = 0
    matches = []

    for pattern in patterns:
        found = re.findall(pattern, text, re.IGNORECASE)
        total += len(found)
        matches.extend(found)

    status = 'good'
    if total > 5:
        status = 'excessive'
    elif total > 3:
        status = 'high'
    elif total < 1:
        status = 'missing'

    return {
        'count': total,
        'status': status,
        'examples': matches[:5],
        'recommendation': 'Reduce thesis restatements' if total > 3 else None,
    }


def detect_advocacy_patterns(text: str) -> Dict[str, Any]:
    """
    Detect prescriptive/advocacy language inappropriate for academic tone.

    Academic writing argues with evidence, not prescriptions.

    Args:
        text: Input text

    Returns:
        Dict with findings and recommendations
    """
    patterns = [
        # Original patterns
        (r'\bmust\s+be\s+adopted\b', 'prescriptive', 'merits consideration'),
        (r'\bwe\s+advocate\b', 'advocacy', 'the evidence suggests'),
        (r'\bundeniably\b', 'overconfident', 'notably'),
        (r'\bunquestionably\b', 'overconfident', 'the evidence indicates'),
        (r'\bobviously\b', 'overconfident', 'notably'),
        (r'\bindisputably\b', 'overconfident', 'strongly supported'),
        (r'\bdemands\s+that\b', 'prescriptive', 'suggests that'),
        (r'\bthe\s+only\s+solution\b', 'absolute', 'a key solution'),
        (r'\bis\s+the\s+best\b', 'superlative', 'is among the most effective'),
        (r'\bproves\s+conclusively\b', 'overconfident', 'provides strong support'),
        (r'\bwithout\s+(?:a\s+)?doubt\b', 'overconfident', 'with high confidence'),
        # V1-ported patterns: additional advocacy/prescriptive language
        (r'\bdemands\s+immediate\b', 'prescriptive', 'merits timely'),
        (r'\bcritical\s+need\s+to\b', 'prescriptive', 'opportunity to'),
        (r'\bessential\s+that\b', 'prescriptive', 'valuable if'),
        (r'\bevery\s+(?:\w+\s+)?should\b', 'prescriptive', 'organizations may'),
        (r'\bclearly\s+the\s+best\b', 'superlative', 'a strong option'),
        (r'\bfundamentally\s+wrong\b', 'absolute', 'may be problematic'),
        (r'\babsolutely\s+(?:necessary|essential|critical)\b', 'prescriptive', 'highly valuable'),
        (r'\bno\s+(?:one\s+)?(?:can|could)\s+deny\b', 'overconfident', 'evidence supports'),
        (r'\bit\s+is\s+imperative\b', 'prescriptive', 'it would be valuable'),
        (r'\bwe\s+must\s+(?:act|take\s+action)\b', 'advocacy', 'action may be warranted'),
        (r'\bfailure\s+to\s+(?:act|address)\b', 'prescriptive', 'if unaddressed'),
        (r'\burgently\s+(?:need|require)s?\b', 'prescriptive', 'would benefit from'),
        (r'\bnon-negotiable\b', 'absolute', 'important'),
        (r'\bself-evident\b', 'overconfident', 'apparent'),
        (r'\bbeyond\s+question\b', 'overconfident', 'well-supported'),
    ]

    findings = []
    total_issues = 0

    for pattern, category, replacement in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        if matches:
            total_issues += len(matches)
            findings.append({
                'pattern': matches[0],
                'category': category,
                'count': len(matches),
                'suggestion': replacement,
            })

    return {
        'total_issues': total_issues,
        'findings': findings,
        'status': 'pass' if total_issues == 0 else 'needs_review',
    }


def calculate_word_count(text: str) -> Dict[str, Any]:
    """
    Calculate word count and related metrics.

    Args:
        text: Input text

    Returns:
        Dict with word count, character count, reading time
    """
    words = text.split()
    word_count = len(words)
    char_count = len(text)

    # Average reading speed: 200 words per minute
    reading_time_min = word_count / 200

    return {
        'word_count': word_count,
        'char_count': char_count,
        'reading_time_min': round(reading_time_min, 1),
    }


def detect_repetition(text: str, phrase_length: int = 5, min_repeats: int = 4) -> Dict[str, Any]:
    """
    Detect repeated phrases in text.

    Args:
        text: Input text
        phrase_length: Number of words to consider as a phrase
        min_repeats: Minimum repetitions to flag

    Returns:
        Dict with repeated phrases and counts
    """
    words = text.lower().split()

    if len(words) < phrase_length * min_repeats:
        return {'repeated_phrases': [], 'total_repeated': 0, 'status': 'pass'}

    # Stopwords to filter out
    stopwords = {'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'is', 'are', 'was', 'were', 'that', 'this'}

    # Markdown/formatting artifacts to skip
    markdown_artifacts = {'|', ':---', '---', '```', '<!--', '-->', '---:', ':---:'}

    phrase_counts: Dict[str, int] = {}

    for i in range(len(words) - phrase_length + 1):
        phrase = ' '.join(words[i:i + phrase_length])
        phrase_words = phrase.split()

        # Skip phrases with just stopwords
        if all(w in stopwords for w in phrase_words):
            continue

        # Skip phrases containing markdown table/formatting artifacts
        if any(w in markdown_artifacts or w.startswith(':---') or w.endswith('---:') for w in phrase_words):
            continue

        phrase_counts[phrase] = phrase_counts.get(phrase, 0) + 1

    repeated = [
        {'phrase': phrase, 'count': count}
        for phrase, count in phrase_counts.items()
        if count >= min_repeats
    ]

    # Sort by count descending
    repeated.sort(key=lambda x: -x['count'])

    return {
        'repeated_phrases': repeated[:10],  # Top 10
        'total_repeated': len(repeated),
        'status': 'pass' if len(repeated) == 0 else 'needs_review',
    }
