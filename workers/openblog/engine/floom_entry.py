#!/usr/bin/env python3
"""
floom_entry.py — Floom V0 entrypoint for openblog-generate.

Worker contract (from apps/worker/src/execute.ts):
  - Working directory : /home/user/floom
  - Inputs file       : /home/user/floom/inputs.json
                        { url: str, keywords: str, _files: {} }
  - Secrets           : injected as environment variables (GEMINI_API_KEY)
  - Entry invocation  : python3 floom_entry.py  (cwd = /home/user/floom)
  - Output paths      : relative to /home/user/floom  (as declared in floom.yaml)
  - Exit 0            : success; non-zero triggers entry_failed

This wrapper:
  1. Reads inputs.json
  2. Splits `keywords` on newlines
  3. Calls api.generate() which runs OpenBlog's full 5-stage pipeline
  4. Writes out/markdown.md  (type: markdown)
  5. Writes out/raw.json     (type: json)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Working-directory hygiene
# The worker sets cwd to WORK_DIR (/home/user/floom) before running us.
# Make sure the bundle root is on sys.path so all openblog modules resolve.
# ---------------------------------------------------------------------------
WORK_DIR = Path(__file__).resolve().parent
if str(WORK_DIR) not in sys.path:
    sys.path.insert(0, str(WORK_DIR))

# ---------------------------------------------------------------------------
# Read inputs
# ---------------------------------------------------------------------------
inputs_path = WORK_DIR / "inputs.json"
if not inputs_path.exists():
    print(f"ERROR: inputs.json not found at {inputs_path}", file=sys.stderr)
    sys.exit(1)

with inputs_path.open() as f:
    inputs = json.load(f)

url: str = (inputs.get("url") or "").strip()
keywords_raw: str = (inputs.get("keywords") or "").strip()

if not url:
    print("ERROR: input 'url' is required and was empty", file=sys.stderr)
    sys.exit(1)

if not keywords_raw:
    print("ERROR: input 'keywords' is required and was empty", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Verify the API key is present before the pipeline boots (fast-fail)
# ---------------------------------------------------------------------------
if not os.environ.get("GEMINI_API_KEY"):
    print("ERROR: GEMINI_API_KEY secret is not set", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Run the pipeline via api.generate()
# api.py re-exports run_pipeline and all stage modules through run_pipeline.py;
# calling generate() is the same entry point used by floom-docker v0.
# Keyword parsing (newline split, strip, dedup empty) is done inside generate().
# ---------------------------------------------------------------------------
print(f"openblog-generate: url={url!r}  keywords={keywords_raw!r}", flush=True)

from app import generate  # noqa: E402  (import after sys.path is set)

result = generate(url=url, keywords=keywords_raw)

# ---------------------------------------------------------------------------
# Write declared outputs
# ---------------------------------------------------------------------------
out_dir = WORK_DIR / "out"
out_dir.mkdir(parents=True, exist_ok=True)

# markdown output
markdown_text: str = result.get("markdown") or ""
(out_dir / "markdown.md").write_text(markdown_text, encoding="utf-8")

# raw JSON output  (drop the HTML preview — it can be large and isn't declared)
raw_payload = result.get("raw") or {}
(out_dir / "raw.json").write_text(
    json.dumps(raw_payload, ensure_ascii=False, indent=2),
    encoding="utf-8",
)

print(
    f"openblog-generate: done. "
    f"articles_total={raw_payload.get('articles_total', '?')}  "
    f"successful={raw_payload.get('articles_successful', '?')}  "
    f"duration={raw_payload.get('duration_seconds', '?'):.1f}s"
    if isinstance(raw_payload.get("duration_seconds"), (int, float))
    else f"openblog-generate: done. articles_total={raw_payload.get('articles_total', '?')}",
    flush=True,
)
sys.exit(0)
