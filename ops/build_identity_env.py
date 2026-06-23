#!/usr/bin/env python3
"""Render build identity environment variables for deploy workers.

This script is intentionally provider-neutral. Floom deploy workers can use the
JSON output with Railway/Vercel APIs, or shell output when invoking local build
commands. It never reads or writes provider credentials.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from typing import Literal


OUTPUT_KEYS = (
    "WORKEROS_BUILD_SHA",
    "WORKEROS_BUILD_REF",
    "WORKEROS_BUILD_TIME",
    "WORKEROS_BUILD_SOURCE",
    "BUILD_SHA",
    "BUILD_TIME",
    "NEXT_PUBLIC_BUILD_SHA",
    "NEXT_PUBLIC_BUILD_REF",
    "NEXT_PUBLIC_BUILD_TIME",
    "NEXT_PUBLIC_BUILD_SOURCE",
)


def build_identity_env(
    *,
    sha: str,
    ref: str = "unknown",
    source: str = "floom-release-worker",
    build_time: str | None = None,
) -> dict[str, str]:
    clean_sha = sha.strip()
    if not clean_sha:
        raise ValueError("sha is required")
    clean_ref = ref.strip() or "unknown"
    clean_source = source.strip() or "floom-release-worker"
    timestamp = build_time or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    return {
        "WORKEROS_BUILD_SHA": clean_sha,
        "WORKEROS_BUILD_REF": clean_ref,
        "WORKEROS_BUILD_TIME": timestamp,
        "WORKEROS_BUILD_SOURCE": clean_source,
        "BUILD_SHA": clean_sha,
        "BUILD_TIME": timestamp,
        "NEXT_PUBLIC_BUILD_SHA": clean_sha,
        "NEXT_PUBLIC_BUILD_REF": clean_ref,
        "NEXT_PUBLIC_BUILD_TIME": timestamp,
        "NEXT_PUBLIC_BUILD_SOURCE": clean_source,
    }


def render_env(values: dict[str, str], fmt: Literal["json", "shell", "github-env"]) -> str:
    if fmt == "json":
        return json.dumps(values, indent=2, sort_keys=True) + "\n"
    if fmt == "github-env":
        return "".join(f"{key}={values[key]}\n" for key in OUTPUT_KEYS)
    if fmt == "shell":
        return "".join(f"{key}={_shell_quote(values[key])}\n" for key in OUTPUT_KEYS)
    raise ValueError(f"unknown format: {fmt}")


def _shell_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def main() -> int:
    parser = argparse.ArgumentParser(description="Render build identity env values.")
    parser.add_argument("--sha", required=True, help="Expected source git SHA.")
    parser.add_argument("--ref", default="unknown", help="Source branch/ref name.")
    parser.add_argument("--source", default="floom-release-worker", help="Identity writer.")
    parser.add_argument("--time", default=None, help="Build timestamp. Defaults to current UTC time.")
    parser.add_argument(
        "--format",
        choices=("json", "shell", "github-env"),
        default="json",
        help="Output format.",
    )
    args = parser.parse_args()
    print(
        render_env(
            build_identity_env(
                sha=args.sha,
                ref=args.ref,
                source=args.source,
                build_time=args.time,
            ),
            args.format,
        ),
        end="",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
