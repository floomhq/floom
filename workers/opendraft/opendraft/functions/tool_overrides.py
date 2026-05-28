"""Merged override lookup for all tool declarations.

Domain files:
- overrides_research.py      Search, citations, workspace
- overrides_writing.py       Formatting, compilation, scoring, code
- overrides_statistics.py    Ingestion, analysis, data providers
- overrides_visualization.py Figures, qualitative analysis
"""

from opendraft.functions.overrides_research import OVERRIDES as _RESEARCH
from opendraft.functions.overrides_writing import OVERRIDES as _WRITING
from opendraft.functions.overrides_statistics import OVERRIDES as _STATISTICS
from opendraft.functions.overrides_visualization import OVERRIDES as _VISUALIZATION

TOOL_OVERRIDES = {**_RESEARCH, **_WRITING, **_STATISTICS, **_VISUALIZATION}
