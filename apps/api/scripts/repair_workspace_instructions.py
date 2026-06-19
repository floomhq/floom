#!/usr/bin/env python3
"""One-time repair for JSON-corrupted workspace instructions (N3-1, 2026-06-03).

ROOT CAUSE
    The OSS ``PUT /workspace`` handler stored the raw request body verbatim as
    ``workspace.md``. The Downstream host (and some clients) PUT a JSON envelope
    ``{"content": "# ..."}`` instead of raw ``text/markdown``. The JSON string was
    therefore stored literally as the instruction BODY and then prepended to every
    agent's system prompt — corrupting all agent runs and the /assistant page.

    The endpoint is now tolerant (it unwraps the envelope on write), but any
    workspace.md that was ALREADY corrupted before that fix shipped still holds the
    literal ``{"content": "..."}`` string. This script unwraps it in place.

WHAT IT DOES
    Detects when the stored workspace.md content is a JSON envelope
    ``{"content": <str>}`` (single key, string value) and rewrites the file with the
    inner markdown. Uses the SAME ``unwrap_workspace_body`` helper as the live write
    path, so legit markdown that merely starts with ``{`` is never mangled.

USAGE
    # Dry-run (default): report whether the file is corrupted, change nothing.
    python scripts/repair_workspace_instructions.py

    # Apply the repair in place (run during a deploy window).
    python scripts/repair_workspace_instructions.py --apply

    # Point at an explicit path (defaults to the resolved WORKSPACE_MD_PATH).
    python scripts/repair_workspace_instructions.py --path /opt/workeros/workspace.md --apply

IDEMPOTENT
    A second run finds nothing to unwrap (the file is already raw markdown) and is a
    no-op. Safe to re-run after any restore.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Make the apps/api package importable when run as a standalone script.
_API_DIR = Path(__file__).resolve().parents[1]
if str(_API_DIR) not in sys.path:
    sys.path.insert(0, str(_API_DIR))

from chat_service import WORKSPACE_MD_PATH, unwrap_workspace_body  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--path",
        default=str(WORKSPACE_MD_PATH),
        help="Path to workspace.md (default: resolved WORKSPACE_MD_PATH)",
    )
    ap.add_argument(
        "--apply",
        action="store_true",
        help="Actually rewrite the file (default: report only / dry-run)",
    )
    args = ap.parse_args()

    path = Path(args.path)
    if not path.is_file():
        print(f"workspace.md not found: {path} — nothing to repair.")
        return 0

    current = path.read_text()
    repaired = unwrap_workspace_body(current)

    if repaired == current:
        print(f"OK: {path} is not a JSON envelope. No repair needed (idempotent no-op).")
        return 0

    print(f"CORRUPTED: {path} holds a JSON envelope.")
    print(f"  before (first 120 chars): {current[:120]!r}")
    print(f"  after  (first 120 chars): {repaired[:120]!r}")

    if not args.apply:
        print("\n[DRY-RUN] no changes written. Re-run with --apply during a deploy window.")
        return 0

    path.write_text(repaired)
    print(f"\nRepaired {path}. Unwrapped {len(current)} -> {len(repaired)} chars.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
