"""
Article Schema - Re-exports from shared/models.py for backward compatibility.

All models are now defined in shared/models.py for single source of truth.
"""

import sys
from pathlib import Path

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

# Re-export from shared
from shared.models import ArticleOutput, ComparisonTable, Source

__all__ = ["ArticleOutput", "ComparisonTable", "Source"]
