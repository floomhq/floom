"""
Stage 2: Constants

Imports shared constants and adds stage-specific ones.
"""

import sys
from pathlib import Path

# Add parent to path for shared imports
_parent = Path(__file__).parent.parent
if str(_parent) not in sys.path:
    sys.path.insert(0, str(_parent))

try:
    from shared.constants import GEMINI_MODEL
except ImportError:
    GEMINI_MODEL = "gemini-3-flash-preview"

# Stage 2 specific constants
MAX_SECTIONS = 9
MAX_FAQS = 6
MAX_PAAS = 4
MAX_TAKEAWAYS = 3
MAX_TABLES = 2
