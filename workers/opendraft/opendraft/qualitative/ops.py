"""Qualitative analysis operations.

Provides text analysis capabilities with auto-ingestion to ResearchStore.
"""

import logging
import re
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer, CountVectorizer
from sklearn.cluster import KMeans
from sklearn.decomposition import LatentDirichletAllocation

from opendraft.research import ResearchStore, IngestOps

logger = logging.getLogger(__name__)

# Common English stopwords (expanded list)
STOPWORDS = {
    'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', "you're",
    "you've", "you'll", "you'd", 'your', 'yours', 'yourself', 'yourselves', 'he',
    'him', 'his', 'himself', 'she', "she's", 'her', 'hers', 'herself', 'it', "it's",
    'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves', 'what', 'which',
    'who', 'whom', 'this', 'that', "that'll", 'these', 'those', 'am', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do',
    'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because',
    'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
    'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
    'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
    'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
    'only', 'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will',
    'just', 'don', "don't", 'should', "should've", 'now', 'd', 'll', 'm', 'o', 're',
    've', 'y', 'ain', 'aren', "aren't", 'couldn', "couldn't", 'didn', "didn't",
    'doesn', "doesn't", 'hadn', "hadn't", 'hasn', "hasn't", 'haven', "haven't",
    'isn', "isn't", 'ma', 'mightn', "mightn't", 'mustn', "mustn't", 'needn',
    "needn't", 'shan', "shan't", 'shouldn', "shouldn't", 'wasn', "wasn't", 'weren',
    "weren't", 'won', "won't", 'wouldn', "wouldn't", 'also', 'would', 'could',
    'one', 'two', 'like', 'really', 'think', 'know', 'thing', 'things', 'well',
    'get', 'got', 'going', 'go', 'come', 'say', 'said', 'make', 'made', 'see',
    'look', 'way', 'even', 'back', 'still', 'new', 'want', 'first', 'much', 'good',
    'yeah', 'yes', 'okay', 'ok', 'um', 'uh', 'er', 'ah', 'oh', 'hmm', 'right',
    'interviewer', 'participant', 'respondent', 'question', 'answer'
}


class QualitativeOps:
    """Qualitative analysis operations with ResearchStore integration."""

    def __init__(self, workspace_dir: Path, research_store: ResearchStore):
        self.workspace_dir = workspace_dir
        self.ingest = IngestOps(research_store)
        self.store = research_store

    def _load_csv(self, filename: str) -> pd.DataFrame:
        """Load CSV from workspace."""
        path = self.workspace_dir / filename
        if not path.exists():
            raise FileNotFoundError(f"File not found: {filename}")
        return pd.read_csv(path)

    def _clean_text(self, text: str) -> str:
        """Clean text for analysis."""
        if pd.isna(text):
            return ""
        text = str(text).lower()
        # Remove special characters but keep apostrophes
        text = re.sub(r"[^a-z\s']", " ", text)
        # Normalize whitespace
        text = re.sub(r"\s+", " ", text).strip()
        return text

    def _tokenize(self, text: str, remove_stopwords: bool = True) -> List[str]:
        """Tokenize text into words."""
        words = text.split()
        if remove_stopwords:
            words = [w for w in words if w not in STOPWORDS and len(w) > 2]
        return words

    # =========================================================================
    # WORD FREQUENCY ANALYSIS
    # =========================================================================

    def word_frequency(
        self,
        filename: str,
        text_column: str,
        top_n: int = 50,
        remove_stopwords: bool = True,
        min_word_length: int = 3,
    ) -> str:
        """Analyze word frequencies in text data.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            top_n: Number of top words to return (default 50)
            remove_stopwords: Remove common English stopwords (default True)
            min_word_length: Minimum word length to include (default 3)

        Returns:
            Formatted frequency table with counts and percentages
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found. Available: {list(df.columns)}"

        # Combine all text
        all_text = " ".join(df[text_column].dropna().astype(str))
        cleaned = self._clean_text(all_text)

        # Tokenize
        words = cleaned.split()
        if remove_stopwords:
            words = [w for w in words if w not in STOPWORDS]
        words = [w for w in words if len(w) >= min_word_length]

        if not words:
            return "No words found after filtering."

        # Count frequencies
        freq = Counter(words)
        total_words = len(words)
        top_words = freq.most_common(top_n)

        # Build table
        lines = [
            "## Word Frequency Analysis",
            "",
            f"**Total words analyzed**: {total_words:,}",
            f"**Unique words**: {len(freq):,}",
            f"**Stopwords removed**: {'Yes' if remove_stopwords else 'No'}",
            "",
            "| Rank | Word | Count | Percentage |",
            "|------|------|-------|------------|",
        ]

        for i, (word, count) in enumerate(top_words, 1):
            pct = count / total_words * 100
            lines.append(f"| {i} | {word} | {count:,} | {pct:.1f}% |")

        # Ingest as descriptives
        self.ingest.ingest_descriptives(
            variables=[
                {
                    "name": f"word_freq_{text_column}",
                    "n": total_words,
                    "unique": len(freq),
                }
            ]
        )

        return "\n".join(lines)

    # =========================================================================
    # QUOTE EXTRACTION
    # =========================================================================

    def extract_quotes(
        self,
        filename: str,
        text_column: str,
        keyword: str,
        context_words: int = 15,
        max_quotes: int = 20,
        id_column: Optional[str] = None,
    ) -> str:
        """Extract quotes containing a keyword with surrounding context.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            keyword: Word or phrase to search for
            context_words: Number of words before/after keyword (default 15)
            max_quotes: Maximum number of quotes to return (default 20)
            id_column: Optional column for participant/source ID

        Returns:
            List of quotes with source information
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found."

        keyword_lower = keyword.lower()
        quotes = []

        for idx, row in df.iterrows():
            text = str(row[text_column]) if pd.notna(row[text_column]) else ""
            text_lower = text.lower()

            # Find all occurrences
            start = 0
            while True:
                pos = text_lower.find(keyword_lower, start)
                if pos == -1:
                    break

                # Extract context
                words_before = text[:pos].split()[-context_words:]
                words_after = text[pos + len(keyword):].split()[:context_words]

                # Reconstruct quote
                before = " ".join(words_before)
                match = text[pos:pos + len(keyword)]
                after = " ".join(words_after)

                quote = f"...{before} **{match}** {after}..."

                # Get source ID
                source = ""
                if id_column and id_column in df.columns:
                    source = f"[{row[id_column]}]"
                else:
                    source = f"[Row {idx + 1}]"

                quotes.append({"quote": quote, "source": source, "row": idx})
                start = pos + 1

                if len(quotes) >= max_quotes:
                    break

            if len(quotes) >= max_quotes:
                break

        if not quotes:
            return f"No quotes found containing '{keyword}'."

        # Build output
        lines = [
            f"## Quotes containing '{keyword}'",
            "",
            f"**Found**: {len(quotes)} occurrences (showing up to {max_quotes})",
            "",
        ]

        for i, q in enumerate(quotes, 1):
            lines.append(f"{i}. {q['quote']} {q['source']}")
            lines.append("")

        return "\n".join(lines)

    # =========================================================================
    # THEMATIC ANALYSIS (AI-based)
    # =========================================================================

    def analyze_thematic(
        self,
        filename: str,
        text_column: str,
        n_themes: int = 5,
        method: str = "lda",
        n_words_per_theme: int = 10,
        id_column: Optional[str] = None,
    ) -> str:
        """Extract themes from text data using topic modeling.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            n_themes: Number of themes to extract (default 5)
            method: 'lda' (Latent Dirichlet Allocation) or 'kmeans' (default 'lda')
            n_words_per_theme: Top words per theme (default 10)
            id_column: Optional column for participant ID

        Returns:
            Thematic analysis results with themes, keywords, and example quotes
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found."

        # Prepare texts
        texts = df[text_column].dropna().astype(str).tolist()
        if len(texts) < n_themes:
            return f"Error: Need at least {n_themes} text entries, found {len(texts)}."

        # Clean texts
        cleaned_texts = [self._clean_text(t) for t in texts]

        if method == "lda":
            themes = self._lda_themes(cleaned_texts, texts, n_themes, n_words_per_theme)
        else:
            themes = self._kmeans_themes(cleaned_texts, texts, n_themes, n_words_per_theme)

        # Handle case where no themes could be extracted
        if not themes:
            return "Error: Could not extract themes. Text may be too similar, too short, or contain only stopwords."

        # Build output
        lines = [
            "## Thematic Analysis Results",
            "",
            f"**Method**: {'Latent Dirichlet Allocation (LDA)' if method == 'lda' else 'K-Means Clustering'}",
            f"**Themes identified**: {n_themes}",
            f"**Documents analyzed**: {len(texts)}",
            "",
        ]

        for i, theme in enumerate(themes, 1):
            lines.append(f"### Theme {i}: {theme['name']}")
            lines.append("")
            lines.append(f"**Keywords**: {', '.join(theme['keywords'])}")
            lines.append("")
            lines.append(f"**Prevalence**: {theme['frequency']} documents ({theme['percentage']:.1f}%)")
            lines.append("")
            if theme['quotes']:
                lines.append("**Example quotes**:")
                for q in theme['quotes'][:3]:
                    # Truncate long quotes
                    quote_text = q[:200] + "..." if len(q) > 200 else q
                    lines.append(f'> "{quote_text}"')
                lines.append("")

        # Ingest to research store
        theme_data = [
            {
                "name": t["name"],
                "description": f"Keywords: {', '.join(t['keywords'][:5])}",
                "frequency": t["frequency"],
                "quotes": t["quotes"][:3],
            }
            for t in themes
        ]

        self.ingest.ingest_themes(
            themes=theme_data,
            total_participants=len(texts),
            method="thematic",
        )

        return "\n".join(lines)

    def _generate_theme_names_batch(
        self,
        themes_data: List[Dict],
    ) -> List[str]:
        """Generate semantic theme names for multiple themes in a single API call.

        Args:
            themes_data: List of dicts with 'keywords' and 'quotes' for each theme

        Returns:
            List of theme names in the same order
        """
        try:
            from google import genai

            # Build prompt for all themes
            theme_descriptions = []
            for i, t in enumerate(themes_data, 1):
                keywords = t['keywords'][:5]
                quotes = [q[:150] for q in t['quotes'][:2]]
                theme_descriptions.append(
                    f"Theme {i}:\n  Keywords: {keywords}\n  Quotes: {quotes}"
                )

            prompt = f"""Generate short (2-4 word) descriptive theme names for these qualitative research themes.

{chr(10).join(theme_descriptions)}

Return ONLY the theme names, one per line, in order (Theme 1, Theme 2, etc.).
No numbering, no quotes, no explanations - just the theme names."""

            client = genai.Client()
            response = client.models.generate_content(
                model="gemini-3-flash-preview",
                contents=prompt,
            )

            # Parse response - one name per line
            lines = [ln.strip() for ln in response.text.strip().split('\n') if ln.strip()]
            names = []
            for i, line in enumerate(lines[:len(themes_data)]):
                # Clean up: remove quotes, numbering, limit length
                name = line.strip('"\'').strip()
                # Remove leading numbers like "1." or "Theme 1:"
                name = re.sub(r'^(Theme\s*)?\d+[.:]\s*', '', name, flags=re.IGNORECASE)
                words = name.split()
                if len(words) > 5:
                    name = " ".join(words[:4])
                names.append(name.title() if name else f"Theme {i+1}")

            # Pad with fallbacks if not enough names returned
            while len(names) < len(themes_data):
                idx = len(names)
                names.append(" & ".join(themes_data[idx]['keywords'][:3]).title())

            return names

        except Exception as e:
            # Fallback to keyword-based names
            logger.warning("AI batch theme naming failed: %s. Using fallback.", e)
            return [" & ".join(t['keywords'][:3]).title() for t in themes_data]

    def _lda_themes(
        self,
        cleaned_texts: List[str],
        original_texts: List[str],
        n_themes: int,
        n_words: int,
    ) -> List[Dict]:
        """Extract themes using LDA topic modeling."""
        # Create document-term matrix
        vectorizer = CountVectorizer(
            max_df=0.95,
            min_df=2,
            stop_words=list(STOPWORDS),
            max_features=1000,
        )

        try:
            dtm = vectorizer.fit_transform(cleaned_texts)
        except ValueError:
            # Fallback with less restrictive settings
            try:
                vectorizer = CountVectorizer(
                    max_df=0.99,
                    min_df=1,
                    stop_words=list(STOPWORDS),
                )
                dtm = vectorizer.fit_transform(cleaned_texts)
            except ValueError:
                # No terms remain - texts are too similar or too short
                return []

        feature_names = vectorizer.get_feature_names_out()

        # Fit LDA
        lda = LatentDirichletAllocation(
            n_components=n_themes,
            random_state=42,
            max_iter=20,
        )
        doc_topics = lda.fit_transform(dtm)

        # Extract themes - collect data first
        themes_data = []
        for topic_idx, topic in enumerate(lda.components_):
            top_word_indices = topic.argsort()[-n_words:][::-1]
            top_words = [feature_names[i] for i in top_word_indices]

            # Find documents belonging to this theme
            theme_docs = np.where(doc_topics.argmax(axis=1) == topic_idx)[0]
            theme_texts = [original_texts[i] for i in theme_docs[:5]]

            themes_data.append({
                "keywords": top_words,
                "frequency": len(theme_docs),
                "percentage": len(theme_docs) / len(original_texts) * 100,
                "quotes": theme_texts,
            })

        # Generate all theme names in a single batch API call
        theme_names = self._generate_theme_names_batch(themes_data)

        # Combine names with data
        themes = []
        for i, data in enumerate(themes_data):
            themes.append({
                "name": theme_names[i],
                "keywords": data["keywords"],
                "frequency": data["frequency"],
                "percentage": data["percentage"],
                "quotes": data["quotes"],
            })

        return themes

    def _kmeans_themes(
        self,
        cleaned_texts: List[str],
        original_texts: List[str],
        n_themes: int,
        n_words: int,
    ) -> List[Dict]:
        """Extract themes using TF-IDF + K-Means clustering."""
        # Create TF-IDF matrix
        vectorizer = TfidfVectorizer(
            max_df=0.95,
            min_df=2,
            stop_words=list(STOPWORDS),
            max_features=1000,
        )

        try:
            tfidf = vectorizer.fit_transform(cleaned_texts)
        except ValueError:
            try:
                vectorizer = TfidfVectorizer(
                    max_df=0.99,
                    min_df=1,
                    stop_words=list(STOPWORDS),
                )
                tfidf = vectorizer.fit_transform(cleaned_texts)
            except ValueError:
                # No terms remain - texts are too similar or too short
                return []

        feature_names = vectorizer.get_feature_names_out()

        # Cluster
        kmeans = KMeans(n_clusters=n_themes, random_state=42, n_init=10)
        clusters = kmeans.fit_predict(tfidf)

        # Extract themes - collect data first
        themes_data = []
        for cluster_idx in range(n_themes):
            # Get centroid
            centroid = kmeans.cluster_centers_[cluster_idx]
            top_word_indices = centroid.argsort()[-n_words:][::-1]
            top_words = [feature_names[i] for i in top_word_indices]

            # Find documents in cluster
            cluster_docs = np.where(clusters == cluster_idx)[0]
            cluster_texts = [original_texts[i] for i in cluster_docs[:5]]

            themes_data.append({
                "keywords": top_words,
                "frequency": len(cluster_docs),
                "percentage": len(cluster_docs) / len(original_texts) * 100,
                "quotes": cluster_texts,
            })

        # Generate all theme names in a single batch API call
        theme_names = self._generate_theme_names_batch(themes_data)

        # Combine names with data
        themes = []
        for i, data in enumerate(themes_data):
            themes.append({
                "name": theme_names[i],
                "keywords": data["keywords"],
                "frequency": data["frequency"],
                "percentage": data["percentage"],
                "quotes": data["quotes"],
            })

        return themes

    # =========================================================================
    # SENTIMENT ANALYSIS
    # =========================================================================

    def sentiment_analysis(
        self,
        filename: str,
        text_column: str,
        id_column: Optional[str] = None,
    ) -> str:
        """Analyze sentiment of text data.

        Uses a lexicon-based approach with positive/negative word lists.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            id_column: Optional column for source ID

        Returns:
            Sentiment analysis results with overall and per-document scores
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found."

        # Simple lexicon-based sentiment
        positive_words = {
            'good', 'great', 'excellent', 'amazing', 'wonderful', 'fantastic',
            'positive', 'happy', 'love', 'like', 'best', 'better', 'helpful',
            'nice', 'awesome', 'perfect', 'beautiful', 'enjoy', 'pleased',
            'satisfied', 'successful', 'effective', 'valuable', 'beneficial',
            'supportive', 'encouraging', 'inspiring', 'motivated', 'confident',
            'comfortable', 'easy', 'clear', 'useful', 'important', 'interesting',
            'excited', 'grateful', 'thankful', 'appreciated', 'impressed',
            'recommend', 'improved', 'progress', 'achievement', 'accomplished',
        }

        negative_words = {
            'bad', 'terrible', 'awful', 'horrible', 'poor', 'worst', 'hate',
            'dislike', 'negative', 'sad', 'angry', 'frustrated', 'disappointed',
            'difficult', 'hard', 'problem', 'issue', 'wrong', 'fail', 'failed',
            'failure', 'confused', 'confusing', 'unclear', 'unhelpful', 'useless',
            'boring', 'annoying', 'stressful', 'worried', 'anxious', 'fear',
            'concerned', 'uncomfortable', 'struggle', 'struggling', 'challenging',
            'overwhelming', 'exhausted', 'tired', 'painful', 'hurt', 'upset',
            'dissatisfied', 'lacking', 'missing', 'inadequate', 'insufficient',
        }

        results = []
        for idx, row in df.iterrows():
            text = str(row[text_column]) if pd.notna(row[text_column]) else ""
            words = self._clean_text(text).split()

            pos_count = sum(1 for w in words if w in positive_words)
            neg_count = sum(1 for w in words if w in negative_words)
            total_sentiment_words = pos_count + neg_count

            if total_sentiment_words > 0:
                score = (pos_count - neg_count) / total_sentiment_words
            else:
                score = 0

            if score > 0.1:
                label = "Positive"
            elif score < -0.1:
                label = "Negative"
            else:
                label = "Neutral"

            source = row[id_column] if id_column and id_column in df.columns else idx + 1

            results.append({
                "source": source,
                "score": score,
                "label": label,
                "positive": pos_count,
                "negative": neg_count,
                "word_count": len(words),
            })

        # Calculate summary
        scores = [r["score"] for r in results]
        labels = [r["label"] for r in results]

        n_positive = labels.count("Positive")
        n_negative = labels.count("Negative")
        n_neutral = labels.count("Neutral")

        mean_score = np.mean(scores)
        std_score = np.std(scores)

        # Build output
        lines = [
            "## Sentiment Analysis Results",
            "",
            f"**Documents analyzed**: {len(results)}",
            "",
            "### Overall Sentiment",
            "",
            "| Metric | Value |",
            "|--------|-------|",
            f"| Mean sentiment score | {mean_score:.3f} |",
            f"| Standard deviation | {std_score:.3f} |",
            f"| Positive documents | {n_positive} ({n_positive/len(results)*100:.1f}%) |",
            f"| Neutral documents | {n_neutral} ({n_neutral/len(results)*100:.1f}%) |",
            f"| Negative documents | {n_negative} ({n_negative/len(results)*100:.1f}%) |",
            "",
            "### Distribution",
            "",
            "| Sentiment | Count | Percentage |",
            "|-----------|-------|------------|",
            f"| Positive | {n_positive} | {n_positive/len(results)*100:.1f}% |",
            f"| Neutral | {n_neutral} | {n_neutral/len(results)*100:.1f}% |",
            f"| Negative | {n_negative} | {n_negative/len(results)*100:.1f}% |",
            "",
        ]

        # Show sample of each category
        for label in ["Positive", "Negative"]:
            samples = [r for r in results if r["label"] == label][:3]
            if samples:
                lines.append(f"### Sample {label} Responses")
                lines.append("")
                for s in samples:
                    lines.append(f"- Source {s['source']}: score = {s['score']:.2f}")
                lines.append("")

        # Ingest summary
        self.ingest.ingest_descriptives(
            variables=[
                {"name": "sentiment_score", "mean": mean_score, "sd": std_score, "n": len(results)},
                {"name": "positive_pct", "mean": n_positive/len(results)*100, "n": len(results)},
                {"name": "negative_pct", "mean": n_negative/len(results)*100, "n": len(results)},
            ]
        )

        return "\n".join(lines)

    # =========================================================================
    # CODE SEGMENTS
    # =========================================================================

    def code_segments(
        self,
        filename: str,
        text_column: str,
        codes: List[str],
        id_column: Optional[str] = None,
    ) -> str:
        """Apply qualitative codes to text segments.

        Searches for code-related keywords in each text segment
        and creates a coding matrix.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            codes: List of code names to apply
            id_column: Optional column for source ID

        Returns:
            Coding matrix showing which codes apply to each segment
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found."

        # Build keyword patterns for each code
        # Code names are used as keywords (split on underscores/spaces)
        code_patterns = {}
        for code in codes:
            keywords = re.split(r"[_\s]+", code.lower())
            code_patterns[code] = keywords

        # Code each segment
        coding_matrix = []
        for idx, row in df.iterrows():
            text = str(row[text_column]).lower() if pd.notna(row[text_column]) else ""
            source = row[id_column] if id_column and id_column in df.columns else idx + 1

            row_codes = {"source": source}
            for code, keywords in code_patterns.items():
                # Check if any keyword appears in text
                found = any(kw in text for kw in keywords if len(kw) > 2)
                row_codes[code] = 1 if found else 0

            coding_matrix.append(row_codes)

        # Calculate code frequencies
        code_counts = {code: sum(r[code] for r in coding_matrix) for code in codes}
        total_segments = len(coding_matrix)

        # Build output
        lines = [
            "## Qualitative Coding Results",
            "",
            f"**Segments coded**: {total_segments}",
            f"**Codes applied**: {len(codes)}",
            "",
            "### Code Frequencies",
            "",
            "| Code | Count | Percentage |",
            "|------|-------|------------|",
        ]

        for code in codes:
            count = code_counts[code]
            pct = count / total_segments * 100
            lines.append(f"| {code} | {count} | {pct:.1f}% |")

        lines.append("")
        lines.append("### Coding Matrix (first 20 segments)")
        lines.append("")

        # Table header
        header = "| Source | " + " | ".join(codes) + " |"
        separator = "|--------|" + "|".join(["---"] * len(codes)) + "|"
        lines.append(header)
        lines.append(separator)

        # Table rows
        for row in coding_matrix[:20]:
            row_str = f"| {row['source']} | "
            row_str += " | ".join("✓" if row[code] else "" for code in codes)
            row_str += " |"
            lines.append(row_str)

        if len(coding_matrix) > 20:
            lines.append(f"| ... | {len(coding_matrix) - 20} more rows ... |")

        # Ingest as themes (reusing theme structure)
        theme_data = [
            {
                "name": code,
                "description": f"Segments containing '{code}' keywords",
                "frequency": code_counts[code],
                "quotes": [],
            }
            for code in codes
        ]

        self.ingest.ingest_themes(
            themes=theme_data,
            total_participants=total_segments,
            method="content",
        )

        # Save coding matrix as CSV
        matrix_df = pd.DataFrame(coding_matrix)
        output_path = self.workspace_dir / f"coding_matrix_{filename}"
        matrix_df.to_csv(output_path, index=False)
        lines.append("")
        lines.append(f"*Full coding matrix saved to: coding_matrix_{filename}*")

        return "\n".join(lines)

    # =========================================================================
    # CONTENT ANALYSIS
    # =========================================================================

    def content_analysis(
        self,
        filename: str,
        text_column: str,
        categories: Dict[str, List[str]],
        id_column: Optional[str] = None,
    ) -> str:
        """Systematic content analysis with predefined categories.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            categories: Dict mapping category names to keyword lists
                       e.g., {"barriers": ["difficult", "challenge"], "facilitators": ["help", "support"]}
            id_column: Optional column for source ID

        Returns:
            Content analysis with category frequencies and examples
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found."

        # Analyze each category
        category_results = {}
        for cat_name, keywords in categories.items():
            cat_results = {
                "count": 0,
                "examples": [],
                "keyword_hits": Counter(),
            }

            for idx, row in df.iterrows():
                text = str(row[text_column]).lower() if pd.notna(row[text_column]) else ""

                for kw in keywords:
                    if kw.lower() in text:
                        cat_results["count"] += 1
                        cat_results["keyword_hits"][kw] += 1
                        if len(cat_results["examples"]) < 3:
                            # Extract snippet around keyword
                            pos = text.find(kw.lower())
                            start = max(0, pos - 50)
                            end = min(len(text), pos + len(kw) + 50)
                            snippet = text[start:end]
                            cat_results["examples"].append(f"...{snippet}...")
                        break  # Count document once per category

            category_results[cat_name] = cat_results

        total_docs = len(df)

        # Build output
        lines = [
            "## Content Analysis Results",
            "",
            f"**Documents analyzed**: {total_docs}",
            f"**Categories**: {len(categories)}",
            "",
            "### Category Frequencies",
            "",
            "| Category | Count | Percentage |",
            "|----------|-------|------------|",
        ]

        for cat_name, results in category_results.items():
            count = results["count"]
            pct = count / total_docs * 100
            lines.append(f"| {cat_name} | {count} | {pct:.1f}% |")

        lines.append("")

        for cat_name, results in category_results.items():
            lines.append(f"### {cat_name.title()}")
            lines.append("")

            # Top keywords
            if results["keyword_hits"]:
                top_kw = results["keyword_hits"].most_common(5)
                kw_str = ", ".join(f"'{k}' ({v})" for k, v in top_kw)
                lines.append(f"**Top keywords**: {kw_str}")
                lines.append("")

            # Examples
            if results["examples"]:
                lines.append("**Examples**:")
                for ex in results["examples"]:
                    lines.append(f'> "{ex}"')
                lines.append("")

        # Ingest
        theme_data = [
            {
                "name": cat_name,
                "description": f"Keywords: {', '.join(keywords[:5])}",
                "frequency": results["count"],
                "quotes": results["examples"],
            }
            for cat_name, (keywords, results) in zip(categories.keys(), zip(categories.values(), category_results.values()))
        ]

        self.ingest.ingest_themes(
            themes=theme_data,
            total_participants=total_docs,
            method="content",
        )

        return "\n".join(lines)

    # =========================================================================
    # WORD CLOUD GENERATION
    # =========================================================================

    def generate_wordcloud(
        self,
        filename: str,
        text_column: str,
        title: Optional[str] = None,
        max_words: int = 100,
        colormap: str = "viridis",
    ) -> str:
        """Generate a word cloud visualization from text data.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            title: Optional title for the figure
            max_words: Maximum number of words to include (default 100)
            colormap: Matplotlib colormap name (default 'viridis')

        Returns:
            Confirmation with figure path
        """
        try:
            from wordcloud import WordCloud
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
        except ImportError:
            return "Error: wordcloud package not installed. Run: pip install wordcloud"

        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found. Available: {list(df.columns)}"

        # Combine all text
        all_text = " ".join(df[text_column].dropna().astype(str))
        cleaned = self._clean_text(all_text)

        # Remove stopwords
        words = [w for w in cleaned.split() if w not in STOPWORDS and len(w) > 2]
        text_for_cloud = " ".join(words)

        if not text_for_cloud.strip():
            return "Error: No words remaining after filtering stopwords."

        # Create word cloud
        wc = WordCloud(
            width=800,
            height=400,
            max_words=max_words,
            colormap=colormap,
            background_color='white',
            stopwords=STOPWORDS,
            min_font_size=10,
        ).generate(text_for_cloud)

        # Create figure
        fig, ax = plt.subplots(figsize=(12, 6))
        ax.imshow(wc, interpolation='bilinear')
        ax.axis('off')

        fig_title = title or f"Word Cloud: {text_column}"
        ax.set_title(fig_title, fontsize=14, fontweight='bold', pad=10)

        plt.tight_layout()

        # Save to figures directory
        figures_dir = self.workspace_dir / "figures"
        figures_dir.mkdir(exist_ok=True)

        # Generate unique filename
        existing = list(figures_dir.glob("wordcloud_*.png"))
        fig_num = len(existing) + 1
        fig_filename = f"wordcloud_{fig_num:02d}.png"
        fig_path = figures_dir / fig_filename

        plt.savefig(fig_path, dpi=300, bbox_inches='tight', facecolor='white')
        plt.close(fig)

        # Register figure
        self.ingest.ingest_figure(
            filename=f"figures/{fig_filename}",
            number=fig_num,
            title=fig_title,
            caption=f"Word cloud visualization of {text_column}. Larger words indicate higher frequency.",
        )

        return f"Created word cloud: figures/{fig_filename}"

    # =========================================================================
    # N-GRAM ANALYSIS
    # =========================================================================

    def analyze_ngrams(
        self,
        filename: str,
        text_column: str,
        n: int = 2,
        top_n: int = 30,
        min_freq: int = 2,
    ) -> str:
        """Analyze n-gram (phrase) frequencies in text data.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            n: Size of n-grams (2=bigrams, 3=trigrams, default 2)
            top_n: Number of top n-grams to return (default 30)
            min_freq: Minimum frequency to include (default 2)

        Returns:
            Formatted n-gram frequency table
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found. Available: {list(df.columns)}"

        # Combine all text
        all_text = " ".join(df[text_column].dropna().astype(str))
        cleaned = self._clean_text(all_text)

        # Tokenize (keep stopwords for n-grams to maintain phrase context)
        words = cleaned.split()

        if len(words) < n:
            return f"Error: Text too short for {n}-gram analysis."

        # Generate n-grams using sliding window
        ngrams = []
        for i in range(len(words) - n + 1):
            ngram = tuple(words[i:i + n])
            # Filter: skip if all words are stopwords or any word is too short
            if not all(w in STOPWORDS for w in ngram):
                ngrams.append(ngram)

        if not ngrams:
            return "No n-grams found after filtering."

        # Count frequencies
        freq = Counter(ngrams)
        total_ngrams = len(ngrams)

        # Filter by minimum frequency
        filtered = [(ng, c) for ng, c in freq.most_common() if c >= min_freq]

        if not filtered:
            return f"No n-grams found with frequency >= {min_freq}."

        top_ngrams = filtered[:top_n]

        # Build table
        ngram_name = {2: "Bigram", 3: "Trigram"}.get(n, f"{n}-gram")
        lines = [
            f"## {ngram_name} Analysis",
            "",
            f"**Total {ngram_name.lower()}s analyzed**: {total_ngrams:,}",
            f"**Unique {ngram_name.lower()}s**: {len(freq):,}",
            f"**Minimum frequency filter**: {min_freq}",
            "",
            "| Rank | Phrase | Count | Percentage |",
            "|------|--------|-------|------------|",
        ]

        for i, (ngram, count) in enumerate(top_ngrams, 1):
            phrase = " ".join(ngram)
            pct = count / total_ngrams * 100
            lines.append(f"| {i} | {phrase} | {count:,} | {pct:.2f}% |")

        # Ingest as descriptives
        self.ingest.ingest_descriptives(
            variables=[
                {
                    "name": f"ngram_{n}_{text_column}",
                    "n": total_ngrams,
                    "unique": len(freq),
                }
            ]
        )

        return "\n".join(lines)

    # =========================================================================
    # CODE CO-OCCURRENCE ANALYSIS
    # =========================================================================

    def analyze_cooccurrence(
        self,
        filename: str,
        text_column: str,
        codes: List[str],
        min_cooccurrence: int = 1,
        id_column: Optional[str] = None,
    ) -> str:
        """Analyze code co-occurrence - which codes appear together in the same documents.

        Args:
            filename: CSV file in workspace
            text_column: Column containing text data
            codes: List of code names to analyze
            min_cooccurrence: Minimum co-occurrence count to display (default 1)
            id_column: Optional column for source ID

        Returns:
            Co-occurrence matrix as markdown table
        """
        try:
            df = self._load_csv(filename)
        except FileNotFoundError as e:
            return f"Error: {e}"

        if text_column not in df.columns:
            return f"Error: Column '{text_column}' not found."

        if len(codes) < 2:
            return "Error: Need at least 2 codes for co-occurrence analysis."

        # Build keyword patterns for each code
        code_patterns = {}
        for code in codes:
            keywords = re.split(r"[_\s]+", code.lower())
            code_patterns[code] = keywords

        # Code each document
        doc_codes = []
        for idx, row in df.iterrows():
            text = str(row[text_column]).lower() if pd.notna(row[text_column]) else ""
            present_codes = set()

            for code, keywords in code_patterns.items():
                if any(kw in text for kw in keywords if len(kw) > 2):
                    present_codes.add(code)

            doc_codes.append(present_codes)

        # Build co-occurrence matrix
        cooccurrence = {c1: {c2: 0 for c2 in codes} for c1 in codes}

        for present_codes in doc_codes:
            for c1 in present_codes:
                for c2 in present_codes:
                    if c1 != c2:
                        cooccurrence[c1][c2] += 1

        # Build output
        lines = [
            "## Code Co-occurrence Matrix",
            "",
            f"**Documents analyzed**: {len(df)}",
            f"**Codes**: {len(codes)}",
            "",
        ]

        # Table header
        header = "| | " + " | ".join(codes) + " |"
        separator = "|-|" + "|".join(["---"] * len(codes)) + "|"
        lines.append(header)
        lines.append(separator)

        # Table rows (only upper triangle for clarity)
        for i, c1 in enumerate(codes):
            row_values = []
            for j, c2 in enumerate(codes):
                if i == j:
                    row_values.append("-")
                elif j > i:
                    count = cooccurrence[c1][c2]
                    if count >= min_cooccurrence:
                        row_values.append(str(count))
                    else:
                        row_values.append("-")
                else:
                    # Lower triangle - mirror upper
                    count = cooccurrence[c2][c1]
                    if count >= min_cooccurrence:
                        row_values.append(str(count))
                    else:
                        row_values.append("-")

            lines.append(f"| {c1} | " + " | ".join(row_values) + " |")

        lines.append("")
        lines.append("*Note.* Values show number of documents where both codes appear.")

        # Find strongest associations
        pairs = []
        for i, c1 in enumerate(codes):
            for j, c2 in enumerate(codes):
                if j > i and cooccurrence[c1][c2] >= min_cooccurrence:
                    pairs.append((c1, c2, cooccurrence[c1][c2]))

        pairs.sort(key=lambda x: x[2], reverse=True)

        if pairs:
            lines.append("")
            lines.append("### Strongest Associations")
            lines.append("")
            for c1, c2, count in pairs[:5]:
                lines.append(f"- **{c1}** + **{c2}**: {count} documents")

        return "\n".join(lines)
