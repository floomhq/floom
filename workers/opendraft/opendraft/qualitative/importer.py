"""Excel/CSV importer for qualitative data."""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

logger = logging.getLogger(__name__)


class QualitativeImporter:
    """
    Import qualitative data from Excel/CSV files.

    Handles:
    - Interview transcripts
    - Survey open-ended responses
    - Focus group data
    - Field notes

    Validates and structures data for qualitative analysis pipeline.
    """

    def __init__(self, workspace_dir: Path):
        self.workspace_dir = workspace_dir

    def import_file(
        self,
        filename: str,
        text_column: str,
        id_column: Optional[str] = None,
        metadata_columns: Optional[List[str]] = None,
        sheet_name: Optional[str] = None,
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """
        Import qualitative data from Excel or CSV.

        Args:
            filename: File name in workspace (xlsx, xls, or csv)
            text_column: Column containing text data to analyze
            id_column: Column with participant/document IDs (optional)
            metadata_columns: Additional columns to preserve (optional)
            sheet_name: For Excel files, which sheet to read (optional)

        Returns:
            Tuple of (DataFrame, metadata_dict)
        """
        filepath = self.workspace_dir / filename

        if not filepath.exists():
            raise FileNotFoundError(f"File not found: {filepath}")

        # Read file based on extension
        ext = filepath.suffix.lower()
        if ext == '.csv':
            df = pd.read_csv(filepath)
        elif ext in ['.xlsx', '.xls']:
            try:
                df = pd.read_excel(filepath, sheet_name=sheet_name or 0)
            except ImportError as e:
                if 'openpyxl' in str(e).lower():
                    raise ImportError(
                        "openpyxl is required for reading Excel files. "
                        "Install it with: pip install openpyxl"
                    ) from e
                raise
        else:
            raise ValueError(f"Unsupported file type: {ext}. Use .csv, .xlsx, or .xls")

        # Validate text column exists
        if text_column not in df.columns:
            raise ValueError(
                f"Text column '{text_column}' not found. "
                f"Available columns: {list(df.columns)}"
            )

        # Generate IDs if not provided
        if id_column:
            if id_column not in df.columns:
                raise ValueError(f"ID column '{id_column}' not found")
            df['source_id'] = df[id_column].astype(str)
        else:
            df['source_id'] = [f"doc_{i+1:04d}" for i in range(len(df))]

        # Standardize text column name
        df['text'] = df[text_column].fillna('').astype(str)

        # Drop empty rows
        original_count = len(df)
        df = df[df['text'].str.strip() != '']
        dropped = original_count - len(df)
        if dropped > 0:
            logger.info("Dropped %s empty rows", dropped)

        # Build metadata dict
        metadata = {
            'source_file': filename,
            'total_documents': len(df),
            'text_column': text_column,
            'id_column': id_column,
            'columns': list(df.columns),
        }

        # Calculate text statistics
        df['word_count'] = df['text'].str.split().str.len()
        metadata['total_words'] = df['word_count'].sum()
        metadata['avg_words_per_doc'] = df['word_count'].mean()
        metadata['min_words'] = df['word_count'].min()
        metadata['max_words'] = df['word_count'].max()

        # Preserve metadata columns if specified
        if metadata_columns:
            valid_meta = [c for c in metadata_columns if c in df.columns]
            if valid_meta:
                metadata['metadata_columns'] = valid_meta
                # Create metadata summary
                for col in valid_meta:
                    unique_vals = df[col].nunique()
                    metadata[f'{col}_unique'] = unique_vals

        logger.info(
            "Imported %s documents from %s (%s words total)",
            len(df), filename, metadata['total_words']
        )

        return df, metadata

    def import_interviews(
        self,
        filename: str,
        text_column: str = 'transcript',
        id_column: str = 'participant_id',
        **kwargs
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """
        Import interview transcripts with interview-specific defaults.

        Standard interview format:
        - participant_id: Unique identifier (P1, P2, etc.)
        - transcript: Full interview text
        - Optional: date, duration, interviewer, demographics
        """
        return self.import_file(
            filename,
            text_column=text_column,
            id_column=id_column,
            **kwargs
        )

    def import_survey_responses(
        self,
        filename: str,
        text_columns: List[str],
        id_column: str = 'response_id',
        **kwargs
    ) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """
        Import survey open-ended responses.

        Concatenates multiple text columns into one for analysis.
        """
        filepath = self.workspace_dir / filename

        if not filepath.exists():
            raise FileNotFoundError(f"File not found: {filepath}")

        ext = filepath.suffix.lower()
        if ext == '.csv':
            df = pd.read_csv(filepath)
        else:
            df = pd.read_excel(filepath, sheet_name=kwargs.get('sheet_name', 0))

        # Validate text columns
        missing = [c for c in text_columns if c not in df.columns]
        if missing:
            raise ValueError(f"Columns not found: {missing}")

        # Concatenate text columns
        df['text'] = df[text_columns].fillna('').astype(str).agg(' '.join, axis=1)

        # Generate IDs
        if id_column and id_column in df.columns:
            df['source_id'] = df[id_column].astype(str)
        else:
            df['source_id'] = [f"resp_{i+1:04d}" for i in range(len(df))]

        # Drop empty
        df = df[df['text'].str.strip() != '']

        # Calculate stats
        df['word_count'] = df['text'].str.split().str.len()

        metadata = {
            'source_file': filename,
            'total_documents': len(df),
            'text_columns': text_columns,
            'id_column': id_column,
            'total_words': df['word_count'].sum(),
            'avg_words_per_doc': df['word_count'].mean(),
        }

        return df, metadata

    def validate_data(self, df: pd.DataFrame) -> List[str]:
        """
        Validate imported data for qualitative analysis.

        Returns list of warnings (empty if valid).
        """
        warnings = []

        # Check for required columns
        if 'text' not in df.columns:
            warnings.append("Missing 'text' column")
        if 'source_id' not in df.columns:
            warnings.append("Missing 'source_id' column")

        if warnings:
            return warnings  # Can't continue validation

        # Check for empty documents
        empty_count = (df['text'].str.strip() == '').sum()
        if empty_count > 0:
            warnings.append(f"{empty_count} documents have empty text")

        # Check for duplicate IDs
        dup_ids = df['source_id'].duplicated().sum()
        if dup_ids > 0:
            warnings.append(f"{dup_ids} duplicate source IDs found")

        # Check minimum document count
        if len(df) < 5:
            warnings.append(f"Only {len(df)} documents - may be too few for analysis")

        # Check average document length
        avg_words = df['text'].str.split().str.len().mean()
        if avg_words < 10:
            warnings.append(f"Average document length is very short ({avg_words:.1f} words)")

        return warnings

    def get_summary(self, df: pd.DataFrame, metadata: Dict[str, Any]) -> str:
        """
        Generate a summary report of imported data.
        """
        lines = [
            "## Import Summary",
            "",
            f"**Source:** {metadata.get('source_file', 'Unknown')}",
            f"**Documents:** {len(df)}",
            f"**Total words:** {metadata.get('total_words', 0):,}",
            "",
            "### Document Statistics",
            "",
            "| Metric | Value |",
            "|--------|-------|",
            f"| Average words | {metadata.get('avg_words_per_doc', 0):.1f} |",
            f"| Min words | {metadata.get('min_words', 0)} |",
            f"| Max words | {metadata.get('max_words', 0)} |",
        ]

        # Add unique source count
        if 'source_id' in df.columns:
            unique_sources = df['source_id'].nunique()
            lines.append(f"| Unique sources | {unique_sources} |")

        # Add metadata column summaries
        if 'metadata_columns' in metadata:
            lines.extend(["", "### Metadata Summary", ""])
            for col in metadata['metadata_columns']:
                unique = metadata.get(f'{col}_unique', 'N/A')
                lines.append(f"- **{col}**: {unique} unique values")

        # Validation warnings
        warnings = self.validate_data(df)
        if warnings:
            lines.extend(["", "### Warnings", ""])
            for w in warnings:
                lines.append(f"- ⚠️ {w}")
        else:
            lines.extend(["", "✓ Data validation passed"])

        return "\n".join(lines)

    def save_processed(
        self,
        df: pd.DataFrame,
        output_name: str = "processed_data.csv"
    ) -> str:
        """
        Save processed DataFrame to workspace.
        """
        output_path = self.workspace_dir / output_name
        df.to_csv(output_path, index=False)
        logger.info("Saved processed data to %s", output_path)
        return str(output_path)
