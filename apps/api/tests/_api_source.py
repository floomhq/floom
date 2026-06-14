"""Shared backend source corpus for source-inspection tests.

Several tests assert that a security/correctness invariant is present (or
absent) in the backend *source code* — e.g. "every /auth/* endpoint appears in
RATE_LIMIT_RULES", or "RunStatus.ERROR is referenced nowhere". Historically each
such test read ``main.py`` directly and searched its text.

As the backend is modularized (config -> ``core/``, route groups -> ``routers/``,
business logic -> ``services/``), that code legitimately moves out of
``main.py`` while the invariant must still hold *somewhere in the backend*.
``api_source()`` returns the concatenated source of every backend Python module
(excluding this test suite and the virtualenv), so an invariant check stays
location-robust: it passes as long as the code exists in the codebase, no matter
which module now hosts it.

Contract:
  - Positive checks (``"X" in api_source()``) verify the invariant exists somewhere
    in shipping backend code.
  - Negative checks (``"X" not in api_source()``) verify the pattern is absent from
    ALL shipping backend code — strictly stronger than checking one file, and
    safe because the corpus excludes ``tests/`` (so a pattern named only in test
    assertions does not count).
  - Window/regex slices over the returned string keep working because each
    file's contents stay contiguous within the concatenation.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]

# Directories that are never shipping backend source.
_EXCLUDED_TOP_LEVEL = {"venv", "tests", "__pycache__", ".git", "node_modules"}


@lru_cache(maxsize=1)
def api_source() -> str:
    """Return the concatenated text of all shipping backend Python modules."""
    parts: list[str] = []
    for path in sorted(API_DIR.rglob("*.py")):
        rel = path.relative_to(API_DIR)
        if rel.parts and rel.parts[0] in _EXCLUDED_TOP_LEVEL:
            continue
        if "__pycache__" in rel.parts:
            continue
        try:
            parts.append(path.read_text(encoding="utf-8"))
        except OSError:
            continue
    return "\n".join(parts)
