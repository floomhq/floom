"""Excel/CSV exporter for qualitative analysis results."""

import logging
from pathlib import Path
from typing import Dict, Optional

import pandas as pd

from opendraft.qualitative.database import CodeDatabase

logger = logging.getLogger(__name__)


class QualitativeExporter:
    """
    Export qualitative analysis results to Excel/CSV.

    Generates standard qualitative research outputs:
    - Codebook with definitions and frequencies
    - Coded segments with quotes and codes
    - Code co-occurrence matrix
    - Summary statistics
    """

    def __init__(self, code_db: CodeDatabase, workspace_dir: Path):
        self.code_db = code_db
        self.workspace_dir = Path(workspace_dir)

    def export_codebook(
        self,
        filename: str = "codebook.xlsx",
        include_hierarchy: bool = True,
    ) -> Path:
        """
        Export codebook to Excel.

        Includes:
        - Code name and description
        - Parent code (for hierarchical codes)
        - Frequency and source count
        - Color (for visualization)
        """
        codes_data = []
        for code in self.code_db.codes.values():
            parent_name = ""
            if code.parent_code and code.parent_code in self.code_db.codes:
                parent_name = self.code_db.codes[code.parent_code].name

            codes_data.append({
                "Code ID": code.code_id,
                "Code Name": code.name,
                "Description": code.description,
                "Parent Code": parent_name if include_hierarchy else "",
                "Frequency": code.frequency,
                "Sources": code.sources,
                "Color": code.color,
                "Created": code.created_at,
            })

        df = pd.DataFrame(codes_data)
        df = df.sort_values("Frequency", ascending=False)

        output_path = self.workspace_dir / filename
        if filename.endswith('.xlsx'):
            df.to_excel(output_path, index=False, sheet_name="Codebook")
        else:
            df.to_csv(output_path, index=False)

        logger.info("Exported codebook (%s codes) to %s", len(df), output_path)
        return output_path

    def export_coded_segments(
        self,
        filename: str = "coded_segments.xlsx",
        include_memo: bool = True,
    ) -> Path:
        """
        Export all coded segments to Excel.

        Includes:
        - Source/participant ID
        - Text segment
        - Applied codes (semicolon-separated)
        - Memo/notes
        - Timestamp
        """
        segments_data = []
        for seg in self.code_db.segments.values():
            code_names = []
            for code_id in seg.codes:
                code = self.code_db.get_code(code_id)
                if code:
                    code_names.append(code.name)

            row = {
                "Segment ID": seg.segment_id,
                "Source ID": seg.source_id,
                "Text": seg.text,
                "Codes": "; ".join(code_names),
                "Code Count": len(seg.codes),
                "Coded At": seg.coded_at,
                "Coded By": seg.coded_by,
            }
            if include_memo:
                row["Memo"] = seg.memo

            segments_data.append(row)

        df = pd.DataFrame(segments_data)

        output_path = self.workspace_dir / filename
        if filename.endswith('.xlsx'):
            df.to_excel(output_path, index=False, sheet_name="Coded Segments")
        else:
            df.to_csv(output_path, index=False)

        logger.info("Exported %s coded segments to %s", len(df), output_path)
        return output_path

    def export_cooccurrence_matrix(
        self,
        filename: str = "cooccurrence.xlsx",
        min_cooccurrence: int = 1,
    ) -> Path:
        """
        Export code co-occurrence matrix to Excel.

        Matrix shows how often codes appear together in the same segment.
        """
        matrix = self.code_db.get_cooccurrence_matrix()

        # Build DataFrame with code names as labels
        code_names = {}
        for code_id in matrix.keys():
            code = self.code_db.get_code(code_id)
            code_names[code_id] = code.name if code else code_id

        # Create matrix with code names
        matrix_data = {}
        for code_id, row in matrix.items():
            name = code_names[code_id]
            matrix_data[name] = {}
            for other_id, count in row.items():
                other_name = code_names[other_id]
                if count >= min_cooccurrence:
                    matrix_data[name][other_name] = count
                else:
                    matrix_data[name][other_name] = 0

        df = pd.DataFrame(matrix_data)

        output_path = self.workspace_dir / filename
        if filename.endswith('.xlsx'):
            df.to_excel(output_path, sheet_name="Co-occurrence")
        else:
            df.to_csv(output_path)

        logger.info("Exported co-occurrence matrix to %s", output_path)
        return output_path

    def export_segments_by_code(
        self,
        code_id: str,
        filename: Optional[str] = None,
    ) -> Path:
        """
        Export all segments for a specific code.

        Useful for reviewing all quotes related to a theme.
        """
        code = self.code_db.get_code(code_id)
        if not code:
            raise ValueError(f"Code {code_id} not found")

        segments = self.code_db.get_segments_by_code(code_id)

        segments_data = []
        for seg in segments:
            other_codes = [
                self.code_db.get_code(c).name
                for c in seg.codes
                if c != code_id and self.code_db.get_code(c)
            ]
            segments_data.append({
                "Source ID": seg.source_id,
                "Text": seg.text,
                "Other Codes": "; ".join(other_codes),
                "Memo": seg.memo,
            })

        df = pd.DataFrame(segments_data)

        if filename is None:
            safe_name = code.name.replace(" ", "_").replace("/", "_")
            filename = f"segments_{safe_name}.xlsx"

        output_path = self.workspace_dir / filename
        if filename.endswith('.xlsx'):
            df.to_excel(output_path, index=False, sheet_name=code.name[:30])
        else:
            df.to_csv(output_path, index=False)

        logger.info("Exported %s segments for code '%s' to %s", len(df), code.name, output_path)
        return output_path

    def export_summary_stats(
        self,
        filename: str = "summary_stats.xlsx",
    ) -> Path:
        """
        Export summary statistics for the qualitative analysis.
        """
        # Overall stats
        overall = {
            "Metric": [
                "Total Codes",
                "Total Segments",
                "Total Sources",
                "Avg Codes per Segment",
                "Avg Segments per Source",
            ],
            "Value": [
                len(self.code_db.codes),
                len(self.code_db.segments),
                len(self.code_db.get_sources_list()),
                sum(len(s.codes) for s in self.code_db.segments.values()) / max(1, len(self.code_db.segments)),
                len(self.code_db.segments) / max(1, len(self.code_db.get_sources_list())),
            ],
        }
        overall_df = pd.DataFrame(overall)

        # Code frequency
        freq_df = pd.DataFrame(self.code_db.get_code_frequency_table())

        # Source coverage
        sources = self.code_db.get_sources_list()
        source_data = []
        for source_id in sources:
            segments = self.code_db.get_segments_by_source(source_id)
            codes_used = set()
            for seg in segments:
                codes_used.update(seg.codes)
            source_data.append({
                "Source ID": source_id,
                "Segments": len(segments),
                "Codes Used": len(codes_used),
            })
        source_df = pd.DataFrame(source_data)

        output_path = self.workspace_dir / filename
        if filename.endswith('.xlsx'):
            with pd.ExcelWriter(output_path, engine='openpyxl') as writer:
                overall_df.to_excel(writer, sheet_name='Overview', index=False)
                freq_df.to_excel(writer, sheet_name='Code Frequency', index=False)
                source_df.to_excel(writer, sheet_name='Source Coverage', index=False)
        else:
            # For CSV, just save the overview
            overall_df.to_csv(output_path, index=False)

        logger.info("Exported summary stats to %s", output_path)
        return output_path

    def export_full_analysis(
        self,
        base_name: str = "qualitative_analysis",
        format: str = "xlsx",
    ) -> Dict[str, Path]:
        """
        Export complete qualitative analysis to multiple files.

        Returns dict mapping file type to path.
        """
        ext = ".xlsx" if format == "xlsx" else ".csv"
        paths = {}

        paths["codebook"] = self.export_codebook(f"{base_name}_codebook{ext}")
        paths["segments"] = self.export_coded_segments(f"{base_name}_segments{ext}")
        paths["cooccurrence"] = self.export_cooccurrence_matrix(f"{base_name}_cooccurrence{ext}")
        paths["summary"] = self.export_summary_stats(f"{base_name}_summary{ext}")

        logger.info("Exported full analysis: %s", list(paths.keys()))
        return paths
