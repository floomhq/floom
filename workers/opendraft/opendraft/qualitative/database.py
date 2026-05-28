"""CodeDatabase: Storage and management of qualitative codes and coded segments."""

import json
import logging
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class Code:
    """A qualitative code with metadata."""
    code_id: str
    name: str
    description: str = ""
    parent_code: Optional[str] = None  # For hierarchical coding
    color: str = "#808080"  # Hex color for visualization
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())

    # Statistics (updated during coding)
    frequency: int = 0  # Number of segments coded
    sources: int = 0  # Number of unique sources/participants


@dataclass
class CodedSegment:
    """A text segment with applied codes."""
    segment_id: str
    source_id: str  # Participant/document ID
    text: str
    codes: List[str]  # List of code_ids
    start_pos: int = 0  # Character position in source
    end_pos: int = 0
    memo: str = ""  # Researcher notes
    coded_at: str = field(default_factory=lambda: datetime.now().isoformat())
    coded_by: str = "opendraft"  # For inter-coder reliability


class CodeDatabase:
    """
    Database for qualitative codes and coded segments.

    Supports:
    - Hierarchical code structure (parent/child codes)
    - Code application to text segments
    - Memos and annotations
    - Export for analysis
    """

    def __init__(self):
        self.codes: Dict[str, Code] = {}
        self.segments: Dict[str, CodedSegment] = {}
        self._next_code_num = 1
        self._next_segment_num = 1

    # --- Code Management ---

    def add_code(
        self,
        name: str,
        description: str = "",
        parent_code: Optional[str] = None,
        color: Optional[str] = None,
    ) -> str:
        """Add a new code to the database. Returns the code_id."""
        code_id = f"code_{self._next_code_num:03d}"
        self._next_code_num += 1

        # Validate parent exists if specified
        if parent_code and parent_code not in self.codes:
            logger.warning("Parent code %s not found, ignoring", parent_code)
            parent_code = None

        # Generate color if not provided
        if not color:
            # Use a simple color palette rotation
            colors = ["#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
                      "#1abc9c", "#e67e22", "#34495e", "#7f8c8d", "#27ae60"]
            color = colors[(self._next_code_num - 1) % len(colors)]

        self.codes[code_id] = Code(
            code_id=code_id,
            name=name,
            description=description,
            parent_code=parent_code,
            color=color,
        )

        logger.info("Added code %s: %s", code_id, name)
        return code_id

    def get_code(self, code_id: str) -> Optional[Code]:
        """Get a code by its ID."""
        return self.codes.get(code_id)

    def query_codes(self, keyword: str) -> List[Code]:
        """Search codes by name or description."""
        keyword_lower = keyword.lower()
        results = []
        for code in self.codes.values():
            if keyword_lower in code.name.lower() or keyword_lower in code.description.lower():
                results.append(code)
        return results

    def list_codes(self) -> List[Dict[str, Any]]:
        """List all codes with basic info."""
        return [
            {
                "code_id": c.code_id,
                "name": c.name,
                "parent": c.parent_code,
                "frequency": c.frequency,
            }
            for c in self.codes.values()
        ]

    def get_hierarchy(self) -> Dict[str, Any]:
        """Get codes organized in hierarchical structure."""
        # Find root codes (no parent)
        roots = [c for c in self.codes.values() if not c.parent_code]

        def build_tree(code: Code) -> Dict[str, Any]:
            children = [c for c in self.codes.values() if c.parent_code == code.code_id]
            return {
                "code_id": code.code_id,
                "name": code.name,
                "color": code.color,
                "frequency": code.frequency,
                "children": [build_tree(c) for c in children]
            }

        return {"codes": [build_tree(r) for r in roots]}

    def update_code(self, code_id: str, **kwargs) -> bool:
        """Update code attributes."""
        if code_id not in self.codes:
            return False
        code = self.codes[code_id]
        for key, value in kwargs.items():
            if hasattr(code, key):
                setattr(code, key, value)
        return True

    def delete_code(self, code_id: str, reassign_to: Optional[str] = None) -> bool:
        """Delete a code, optionally reassigning its segments."""
        if code_id not in self.codes:
            return False

        # Handle segments with this code
        for segment in self.segments.values():
            if code_id in segment.codes:
                segment.codes.remove(code_id)
                if reassign_to and reassign_to in self.codes:
                    segment.codes.append(reassign_to)

        # Handle child codes
        for code in self.codes.values():
            if code.parent_code == code_id:
                code.parent_code = None

        del self.codes[code_id]
        return True

    # --- Segment Coding ---

    def add_segment(
        self,
        source_id: str,
        text: str,
        codes: List[str],
        start_pos: int = 0,
        end_pos: int = 0,
        memo: str = "",
    ) -> str:
        """Add a coded segment. Returns the segment_id."""
        segment_id = f"seg_{self._next_segment_num:04d}"
        self._next_segment_num += 1

        # Validate codes exist
        valid_codes = [c for c in codes if c in self.codes]
        if len(valid_codes) < len(codes):
            invalid = set(codes) - set(valid_codes)
            logger.warning("Some codes not found, skipping: %s", invalid)

        self.segments[segment_id] = CodedSegment(
            segment_id=segment_id,
            source_id=source_id,
            text=text,
            codes=valid_codes,
            start_pos=start_pos,
            end_pos=end_pos or len(text),
            memo=memo,
        )

        # Update code frequencies
        sources_per_code: Dict[str, set] = {}
        for seg in self.segments.values():
            for code_id in seg.codes:
                if code_id not in sources_per_code:
                    sources_per_code[code_id] = set()
                sources_per_code[code_id].add(seg.source_id)

        for code_id in valid_codes:
            if code_id in self.codes:
                self.codes[code_id].frequency = sum(
                    1 for s in self.segments.values() if code_id in s.codes
                )
                self.codes[code_id].sources = len(sources_per_code.get(code_id, set()))

        return segment_id

    def get_segment(self, segment_id: str) -> Optional[CodedSegment]:
        """Get a segment by ID."""
        return self.segments.get(segment_id)

    def get_segments_by_code(self, code_id: str) -> List[CodedSegment]:
        """Get all segments with a specific code."""
        return [s for s in self.segments.values() if code_id in s.codes]

    def get_segments_by_source(self, source_id: str) -> List[CodedSegment]:
        """Get all segments from a specific source."""
        return [s for s in self.segments.values() if s.source_id == source_id]

    def update_segment_codes(self, segment_id: str, codes: List[str]) -> bool:
        """Update the codes applied to a segment."""
        if segment_id not in self.segments:
            return False
        valid_codes = [c for c in codes if c in self.codes]
        self.segments[segment_id].codes = valid_codes
        return True

    def add_memo(self, segment_id: str, memo: str) -> bool:
        """Add or update memo for a segment."""
        if segment_id not in self.segments:
            return False
        self.segments[segment_id].memo = memo
        return True

    # --- Analysis Helpers ---

    def get_code_frequency_table(self) -> List[Dict[str, Any]]:
        """Get frequency table of all codes."""
        return [
            {
                "code_id": c.code_id,
                "name": c.name,
                "frequency": c.frequency,
                "sources": c.sources,
                "percent": (c.frequency / len(self.segments) * 100) if self.segments else 0,
            }
            for c in sorted(self.codes.values(), key=lambda x: -x.frequency)
        ]

    def get_cooccurrence_matrix(self) -> Dict[str, Dict[str, int]]:
        """Get code co-occurrence matrix."""
        matrix: Dict[str, Dict[str, int]] = {}

        for code_id in self.codes:
            matrix[code_id] = {c: 0 for c in self.codes}

        for segment in self.segments.values():
            for i, code1 in enumerate(segment.codes):
                for code2 in segment.codes[i:]:
                    if code1 in matrix and code2 in matrix[code1]:
                        matrix[code1][code2] += 1
                        if code1 != code2:
                            matrix[code2][code1] += 1

        return matrix

    def get_sources_list(self) -> List[str]:
        """Get list of unique source IDs."""
        return list(set(s.source_id for s in self.segments.values()))

    # --- Serialization ---

    def to_dict(self) -> Dict[str, Any]:
        """Serialize database to dict."""
        return {
            "codes": {k: asdict(v) for k, v in self.codes.items()},
            "segments": {k: asdict(v) for k, v in self.segments.items()},
            "_next_code_num": self._next_code_num,
            "_next_segment_num": self._next_segment_num,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CodeDatabase":
        """Deserialize from dict."""
        db = cls()
        db._next_code_num = data.get("_next_code_num", 1)
        db._next_segment_num = data.get("_next_segment_num", 1)

        for code_id, code_data in data.get("codes", {}).items():
            db.codes[code_id] = Code(**code_data)

        for seg_id, seg_data in data.get("segments", {}).items():
            db.segments[seg_id] = CodedSegment(**seg_data)

        return db


def save_code_database(db: CodeDatabase, path: Path) -> None:
    """Save CodeDatabase to JSON file."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(db.to_dict(), f, indent=2, ensure_ascii=False)
    logger.info("Saved code database to %s", path)


def load_code_database(path: Path) -> CodeDatabase:
    """Load CodeDatabase from JSON file."""
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return CodeDatabase.from_dict(data)


# --- Memo System ---

@dataclass
class Memo:
    """A research memo for qualitative analysis."""
    memo_id: str
    title: str
    content: str
    memo_type: str = "analytical"  # analytical, methodological, theoretical, personal
    linked_codes: List[str] = field(default_factory=list)
    linked_segments: List[str] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())


class MemoDatabase:
    """
    Database for researcher memos.

    Supports:
    - Different memo types (analytical, methodological, theoretical, personal)
    - Linking memos to codes and segments
    - Search and retrieval
    """

    def __init__(self):
        self.memos: Dict[str, Memo] = {}
        self._next_memo_num = 1

    def add_memo(
        self,
        title: str,
        content: str,
        memo_type: str = "analytical",
        linked_codes: Optional[List[str]] = None,
        linked_segments: Optional[List[str]] = None,
    ) -> str:
        """Add a new memo. Returns memo_id."""
        memo_id = f"memo_{self._next_memo_num:03d}"
        self._next_memo_num += 1

        self.memos[memo_id] = Memo(
            memo_id=memo_id,
            title=title,
            content=content,
            memo_type=memo_type,
            linked_codes=linked_codes or [],
            linked_segments=linked_segments or [],
        )
        return memo_id

    def get_memo(self, memo_id: str) -> Optional[Memo]:
        """Get a memo by ID."""
        return self.memos.get(memo_id)

    def update_memo(self, memo_id: str, **kwargs) -> bool:
        """Update memo attributes."""
        if memo_id not in self.memos:
            return False
        memo = self.memos[memo_id]
        for key, value in kwargs.items():
            if hasattr(memo, key):
                setattr(memo, key, value)
        memo.updated_at = datetime.now().isoformat()
        return True

    def delete_memo(self, memo_id: str) -> bool:
        """Delete a memo."""
        if memo_id not in self.memos:
            return False
        del self.memos[memo_id]
        return True

    def list_memos(self, memo_type: Optional[str] = None) -> List[Dict[str, Any]]:
        """List all memos, optionally filtered by type."""
        memos = self.memos.values()
        if memo_type:
            memos = [m for m in memos if m.memo_type == memo_type]
        return [
            {
                "memo_id": m.memo_id,
                "title": m.title,
                "type": m.memo_type,
                "linked_codes": len(m.linked_codes),
                "linked_segments": len(m.linked_segments),
                "updated_at": m.updated_at,
            }
            for m in sorted(memos, key=lambda x: x.updated_at, reverse=True)
        ]

    def get_memos_for_code(self, code_id: str) -> List[Memo]:
        """Get all memos linked to a specific code."""
        return [m for m in self.memos.values() if code_id in m.linked_codes]

    def search_memos(self, keyword: str) -> List[Memo]:
        """Search memos by title or content."""
        keyword_lower = keyword.lower()
        return [
            m for m in self.memos.values()
            if keyword_lower in m.title.lower() or keyword_lower in m.content.lower()
        ]

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to dict."""
        return {
            "memos": {k: asdict(v) for k, v in self.memos.items()},
            "_next_memo_num": self._next_memo_num,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "MemoDatabase":
        """Deserialize from dict."""
        db = cls()
        db._next_memo_num = data.get("_next_memo_num", 1)
        for memo_id, memo_data in data.get("memos", {}).items():
            db.memos[memo_id] = Memo(**memo_data)
        return db


# --- Inter-Coder Reliability ---

def calculate_cohens_kappa(
    coder1_codes: Dict[str, List[str]],
    coder2_codes: Dict[str, List[str]],
    all_codes: List[str],
) -> Dict[str, Any]:
    """
    Calculate Cohen's Kappa for inter-coder reliability.

    Args:
        coder1_codes: Dict mapping segment_id to list of codes assigned by coder 1
        coder2_codes: Dict mapping segment_id to list of codes assigned by coder 2
        all_codes: List of all possible code_ids

    Returns:
        Dict with kappa, observed agreement, expected agreement, and interpretation
    """
    # Get common segments
    common_segments = set(coder1_codes.keys()) & set(coder2_codes.keys())

    if not common_segments:
        return {
            "kappa": 0.0,
            "observed_agreement": 0.0,
            "expected_agreement": 0.0,
            "interpretation": "No common segments to compare",
            "n_segments": 0,
        }

    # For each code, calculate agreement
    total_agreements = 0
    total_expected = 0
    n_comparisons = len(common_segments) * len(all_codes)

    for code_id in all_codes:
        coder1_has = 0
        coder2_has = 0
        both_have = 0
        neither_have = 0

        for seg_id in common_segments:
            c1_has = code_id in coder1_codes.get(seg_id, [])
            c2_has = code_id in coder2_codes.get(seg_id, [])

            if c1_has:
                coder1_has += 1
            if c2_has:
                coder2_has += 1
            if c1_has and c2_has:
                both_have += 1
            if not c1_has and not c2_has:
                neither_have += 1

        total_agreements += both_have + neither_have

        # Expected agreement by chance
        n = len(common_segments)
        if n > 0:
            p1_yes = coder1_has / n
            p2_yes = coder2_has / n
            expected = (p1_yes * p2_yes) + ((1 - p1_yes) * (1 - p2_yes))
            total_expected += expected * n

    # Calculate overall kappa
    observed = total_agreements / n_comparisons if n_comparisons > 0 else 0
    expected = total_expected / n_comparisons if n_comparisons > 0 else 0

    if expected == 1:
        kappa = 1.0
    else:
        kappa = (observed - expected) / (1 - expected) if (1 - expected) != 0 else 0

    # Interpretation
    if kappa < 0:
        interpretation = "Poor (less than chance)"
    elif kappa < 0.20:
        interpretation = "Slight agreement"
    elif kappa < 0.40:
        interpretation = "Fair agreement"
    elif kappa < 0.60:
        interpretation = "Moderate agreement"
    elif kappa < 0.80:
        interpretation = "Substantial agreement"
    else:
        interpretation = "Almost perfect agreement"

    return {
        "kappa": round(kappa, 3),
        "observed_agreement": round(observed, 3),
        "expected_agreement": round(expected, 3),
        "interpretation": interpretation,
        "n_segments": len(common_segments),
        "n_codes": len(all_codes),
    }


def calculate_percent_agreement(
    coder1_codes: Dict[str, List[str]],
    coder2_codes: Dict[str, List[str]],
) -> Dict[str, Any]:
    """
    Calculate simple percent agreement between coders.

    Args:
        coder1_codes: Dict mapping segment_id to list of codes
        coder2_codes: Dict mapping segment_id to list of codes

    Returns:
        Dict with percent agreement and details
    """
    common_segments = set(coder1_codes.keys()) & set(coder2_codes.keys())

    if not common_segments:
        return {
            "percent_agreement": 0.0,
            "exact_matches": 0,
            "partial_matches": 0,
            "total_segments": 0,
        }

    exact_matches = 0
    partial_matches = 0

    for seg_id in common_segments:
        codes1 = set(coder1_codes.get(seg_id, []))
        codes2 = set(coder2_codes.get(seg_id, []))

        if codes1 == codes2:
            exact_matches += 1
        elif codes1 & codes2:  # Any overlap
            partial_matches += 1

    n = len(common_segments)
    percent = (exact_matches / n * 100) if n > 0 else 0

    return {
        "percent_agreement": round(percent, 1),
        "exact_matches": exact_matches,
        "partial_matches": partial_matches,
        "total_segments": n,
    }
