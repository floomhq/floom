"""Qualitative analysis pipeline: Import → Code → Analyze → Synthesize."""

import logging
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from opendraft.qualitative.database import (
    CodeDatabase,
    save_code_database,
    load_code_database,
)
from opendraft.qualitative.importer import QualitativeImporter
from opendraft.qualitative.agents import CoderAgent, AnalystAgent, SynthesizerAgent

logger = logging.getLogger(__name__)


@dataclass
class QualitativePipelineState:
    """State for the qualitative analysis pipeline."""

    workspace_dir: Path
    code_db: CodeDatabase = field(default_factory=CodeDatabase)
    documents: Optional[pd.DataFrame] = None
    import_metadata: Dict[str, Any] = field(default_factory=dict)

    # Pipeline progress
    current_phase: str = "init"
    coding_complete: bool = False
    analysis_complete: bool = False
    synthesis_complete: bool = False

    # Results
    analysis_results: str = ""
    synthesis_results: str = ""

    # Metadata
    started_at: str = field(default_factory=lambda: datetime.now().isoformat())
    completed_at: Optional[str] = None

    def save(self, filename: str = "pipeline_state.json") -> Path:
        """Save pipeline state to workspace."""
        import json
        import numpy as np

        def json_serializable(obj):
            """Convert numpy types to Python types for JSON serialization."""
            if isinstance(obj, dict):
                return {k: json_serializable(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [json_serializable(v) for v in obj]
            elif isinstance(obj, (np.integer, np.int64)):
                return int(obj)
            elif isinstance(obj, (np.floating, np.float64)):
                return float(obj)
            elif isinstance(obj, np.ndarray):
                return obj.tolist()
            return obj

        state_path = self.workspace_dir / filename
        state_dict = {
            "current_phase": self.current_phase,
            "coding_complete": self.coding_complete,
            "analysis_complete": self.analysis_complete,
            "synthesis_complete": self.synthesis_complete,
            "analysis_results": self.analysis_results,
            "synthesis_results": self.synthesis_results,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "import_metadata": json_serializable(self.import_metadata),
        }
        with open(state_path, 'w') as f:
            json.dump(state_dict, f, indent=2)

        # Also save code database
        save_code_database(self.code_db, self.workspace_dir / "code_database.json")

        return state_path


class QualitativePipeline:
    """
    Orchestrates the qualitative analysis workflow.

    Phases:
    1. Import: Load data from Excel/CSV
    2. Code: Apply codes to text segments (CoderAgent)
    3. Analyze: Identify patterns and themes (AnalystAgent)
    4. Synthesize: Write up findings (SynthesizerAgent)
    """

    def __init__(
        self,
        workspace_dir: Path,
        model_name: str = "gemini-3-flash-preview",
    ):
        self.workspace_dir = Path(workspace_dir)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.model_name = model_name
        self.state = QualitativePipelineState(workspace_dir=self.workspace_dir)

    def import_data(
        self,
        filename: str,
        text_column: str,
        id_column: Optional[str] = None,
        **kwargs
    ) -> pd.DataFrame:
        """
        Phase 1: Import data from file.

        Args:
            filename: Path to Excel or CSV file
            text_column: Column containing text to analyze
            id_column: Column with document/participant IDs
            **kwargs: Additional arguments for importer

        Returns:
            DataFrame with imported documents
        """
        self.state.current_phase = "import"
        logger.info("Importing data from %s", filename)

        importer = QualitativeImporter(self.workspace_dir)
        df, metadata = importer.import_file(
            filename,
            text_column=text_column,
            id_column=id_column,
            **kwargs
        )

        self.state.documents = df
        self.state.import_metadata = metadata

        # Validate
        warnings = importer.validate_data(df)
        if warnings:
            logger.warning("Import warnings: %s", warnings)
            metadata['warnings'] = warnings

        # Save processed data
        importer.save_processed(df, "processed_data.csv")

        logger.info("Imported %s documents (%s words)", len(df), metadata.get('total_words', 0))
        return df

    def run_coding(
        self,
        coding_instructions: Optional[str] = None,
        batch_size: int = 5,
    ) -> Dict[str, Any]:
        """
        Phase 2: Run coding on imported documents.

        Args:
            coding_instructions: Optional specific coding instructions
            batch_size: Number of documents to code per agent run

        Returns:
            Dict with coding results and statistics
        """
        if self.state.documents is None:
            raise ValueError("No documents imported. Call import_data() first.")

        self.state.current_phase = "coding"
        logger.info("Starting coding phase")

        coder = CoderAgent(self.state.code_db, model_name=self.model_name)

        # Prepare documents for coding
        docs = self.state.documents
        total_docs = len(docs)
        coded_docs = 0

        # Process in batches
        for i in range(0, total_docs, batch_size):
            batch = docs.iloc[i:i + batch_size]
            batch_texts = []
            for _, row in batch.iterrows():
                batch_texts.append(f"[{row['source_id']}]: {row['text']}")

            task = self._build_coding_task(batch_texts, coding_instructions)
            result = coder.run(task)

            coded_docs += len(batch)
            logger.info("Coded %s/%s documents", coded_docs, total_docs)

            if result['status'] != 'done':
                logger.warning("Coder stopped with status: %s", result['status'])

        self.state.coding_complete = True
        self.state.save()

        return {
            "status": "complete",
            "documents_coded": total_docs,
            "codes_created": len(self.state.code_db.codes),
            "segments_coded": len(self.state.code_db.segments),
        }

    def _build_coding_task(
        self,
        texts: List[str],
        instructions: Optional[str] = None
    ) -> str:
        """Build the coding task prompt."""
        task_parts = []

        if instructions:
            task_parts.append(f"## Coding Instructions\n{instructions}\n")

        # Include existing codes if any
        if self.state.code_db.codes:
            codes_list = self.state.code_db.list_codes()
            task_parts.append("## Existing Codebook")
            for c in codes_list[:20]:
                task_parts.append(f"- {c['code_id']}: {c['name']}")
            task_parts.append("")

        task_parts.append("## Documents to Code\n")
        task_parts.append("\n\n---\n\n".join(texts))

        task_parts.append("\n\n## Instructions")
        task_parts.append("1. Read each document carefully")
        task_parts.append("2. Create codes for recurring themes or concepts")
        task_parts.append("3. Apply codes to relevant text segments")
        task_parts.append("4. Add memos for notable observations")
        task_parts.append("5. When finished, respond with SIGNAL: DONE")

        return "\n".join(task_parts)

    def run_analysis(self) -> Dict[str, Any]:
        """
        Phase 3: Analyze coded data for patterns.

        Returns:
            Dict with analysis results
        """
        if not self.state.coding_complete:
            raise ValueError("Coding not complete. Call run_coding() first.")

        self.state.current_phase = "analysis"
        logger.info("Starting analysis phase")

        analyst = AnalystAgent(self.state.code_db, model_name=self.model_name)

        task = self._build_analysis_task()
        result = analyst.run(task)

        self.state.analysis_results = result['response']
        self.state.analysis_complete = True
        self.state.save()

        return {
            "status": result['status'],
            "iterations": result['iterations'],
            "analysis": result['response'],
        }

    def _build_analysis_task(self) -> str:
        """Build the analysis task prompt."""
        freq_table = self.state.code_db.get_code_frequency_table()

        task_parts = [
            "## Analysis Task",
            "",
            f"Analyze the coded qualitative data. There are {len(self.state.code_db.codes)} codes "
            f"applied to {len(self.state.code_db.segments)} text segments "
            f"from {len(self.state.code_db.get_sources_list())} sources.",
            "",
            "## Your Tasks",
            "1. Review the codebook and code frequencies",
            "2. Identify the most prevalent themes",
            "3. Examine code co-occurrences for patterns",
            "4. Look for differences across sources/participants",
            "5. Note any surprising or contradictory findings",
            "",
            "## Top Codes by Frequency",
        ]

        for row in freq_table[:10]:
            task_parts.append(f"- {row['name']}: {row['frequency']} uses ({row['percent']:.1f}%)")

        task_parts.append("")
        task_parts.append("Use the available functions to explore the data and provide a structured analysis.")
        task_parts.append("When complete, respond with SIGNAL: DONE")

        return "\n".join(task_parts)

    def run_synthesis(self, focus: Optional[str] = None) -> Dict[str, Any]:
        """
        Phase 4: Synthesize findings into a narrative.

        Args:
            focus: Optional specific focus for the synthesis

        Returns:
            Dict with synthesis results
        """
        if not self.state.analysis_complete:
            raise ValueError("Analysis not complete. Call run_analysis() first.")

        self.state.current_phase = "synthesis"
        logger.info("Starting synthesis phase")

        synthesizer = SynthesizerAgent(self.state.code_db, model_name=self.model_name)

        task = self._build_synthesis_task(focus)
        result = synthesizer.run(task)

        self.state.synthesis_results = result['response']
        self.state.synthesis_complete = True
        self.state.completed_at = datetime.now().isoformat()
        self.state.save()

        # Save synthesis to file
        output_path = self.workspace_dir / "findings.md"
        with open(output_path, 'w') as f:
            f.write(result['response'])
        logger.info("Saved synthesis to %s", output_path)

        return {
            "status": result['status'],
            "iterations": result['iterations'],
            "synthesis": result['response'],
            "output_path": str(output_path),
        }

    def _build_synthesis_task(self, focus: Optional[str] = None) -> str:
        """Build the synthesis task prompt."""
        task_parts = [
            "## Synthesis Task",
            "",
            "Write a findings section based on the coded qualitative data.",
            "",
        ]

        if focus:
            task_parts.append(f"## Focus Area\n{focus}\n")

        if self.state.analysis_results:
            task_parts.append("## Prior Analysis")
            task_parts.append(self.state.analysis_results[:2000])
            task_parts.append("")

        task_parts.extend([
            "## Writing Guidelines",
            "1. Organize by major themes identified in the analysis",
            "2. Include representative quotes for each theme",
            "3. Note the prevalence of each theme (how many participants/sources)",
            "4. Discuss any patterns or contradictions",
            "5. Write in academic qualitative research style",
            "",
            "Use get_segments_by_code to retrieve quotes for each theme.",
            "When complete, respond with SIGNAL: DONE",
        ])

        return "\n".join(task_parts)

    def run_full_pipeline(
        self,
        filename: str,
        text_column: str,
        id_column: Optional[str] = None,
        coding_instructions: Optional[str] = None,
        synthesis_focus: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Run the complete qualitative analysis pipeline.

        Args:
            filename: Data file to analyze
            text_column: Column with text data
            id_column: Column with document IDs
            coding_instructions: Optional coding guidance
            synthesis_focus: Optional focus for synthesis

        Returns:
            Dict with complete pipeline results
        """
        logger.info("Starting full qualitative pipeline")

        # Phase 1: Import
        self.import_data(filename, text_column, id_column)

        # Phase 2: Code
        self.run_coding(coding_instructions)

        # Phase 3: Analyze
        analysis_result = self.run_analysis()

        # Phase 4: Synthesize
        synthesis_result = self.run_synthesis(synthesis_focus)

        return {
            "status": "complete",
            "documents": len(self.state.documents),
            "codes": len(self.state.code_db.codes),
            "segments": len(self.state.code_db.segments),
            "analysis": analysis_result['analysis'][:500] + "...",
            "output_path": synthesis_result['output_path'],
        }

    def export_codebook(self, filename: str = "codebook.csv") -> Path:
        """Export the codebook to CSV."""
        codes = self.state.code_db.get_code_frequency_table()
        df = pd.DataFrame(codes)
        output_path = self.workspace_dir / filename
        df.to_csv(output_path, index=False)
        logger.info("Exported codebook to %s", output_path)
        return output_path

    def export_coded_segments(self, filename: str = "coded_segments.csv") -> Path:
        """Export all coded segments to CSV."""
        segments = []
        for seg in self.state.code_db.segments.values():
            code_names = [
                self.state.code_db.get_code(c).name
                for c in seg.codes
                if self.state.code_db.get_code(c)
            ]
            segments.append({
                "segment_id": seg.segment_id,
                "source_id": seg.source_id,
                "text": seg.text,
                "codes": "; ".join(code_names),
                "memo": seg.memo,
                "coded_at": seg.coded_at,
            })

        df = pd.DataFrame(segments)
        output_path = self.workspace_dir / filename
        df.to_csv(output_path, index=False)
        logger.info("Exported %s segments to %s", len(segments), output_path)
        return output_path

    @classmethod
    def load(cls, workspace_dir: Path) -> "QualitativePipeline":
        """Load a pipeline from saved state."""
        import json

        workspace_dir = Path(workspace_dir)
        pipeline = cls(workspace_dir)

        # Load code database
        db_path = workspace_dir / "code_database.json"
        if db_path.exists():
            pipeline.state.code_db = load_code_database(db_path)

        # Load state
        state_path = workspace_dir / "pipeline_state.json"
        if state_path.exists():
            with open(state_path) as f:
                state_dict = json.load(f)
            pipeline.state.current_phase = state_dict.get("current_phase", "init")
            pipeline.state.coding_complete = state_dict.get("coding_complete", False)
            pipeline.state.analysis_complete = state_dict.get("analysis_complete", False)
            pipeline.state.synthesis_complete = state_dict.get("synthesis_complete", False)
            pipeline.state.analysis_results = state_dict.get("analysis_results", "")
            pipeline.state.synthesis_results = state_dict.get("synthesis_results", "")
            pipeline.state.started_at = state_dict.get("started_at", "")
            pipeline.state.completed_at = state_dict.get("completed_at")
            pipeline.state.import_metadata = state_dict.get("import_metadata", {})

        # Load documents
        processed_path = workspace_dir / "processed_data.csv"
        if processed_path.exists():
            pipeline.state.documents = pd.read_csv(processed_path)

        return pipeline
