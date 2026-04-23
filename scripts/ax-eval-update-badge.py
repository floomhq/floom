#!/usr/bin/env python3
"""Update the AX badge in README.md.

Reads NEW_BADGE from the environment and either replaces the existing AX badge
anchor or inserts it immediately after the 'Live at floom.dev' badge.

Idempotent: safe to run when no AX badge exists yet (inserts it) and when one
already exists (replaces it).
"""
import os
import re
import pathlib
import sys


def main() -> int:
    new_badge = os.environ.get("NEW_BADGE")
    if not new_badge:
        print("NEW_BADGE env var is required", file=sys.stderr)
        return 1

    readme = pathlib.Path("README.md")
    s = readme.read_text()

    ax_pattern = re.compile(
        r'<a href="[^"]*"><img src="https://img\.shields\.io/badge/AX-[^"]*" alt="[^"]*"/></a>'
    )
    if ax_pattern.search(s):
        s = ax_pattern.sub(new_badge, s)
    else:
        anchor = (
            '<a href="https://floom.dev"><img '
            'src="https://img.shields.io/badge/live-floom.dev-22c55e" '
            'alt="Live at floom.dev"/></a>'
        )
        if anchor in s:
            s = s.replace(anchor, anchor + "\n    " + new_badge)
        else:
            print(
                "warn: could not find 'Live at floom.dev' badge anchor; README not updated",
                file=sys.stderr,
            )

    readme.write_text(s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
