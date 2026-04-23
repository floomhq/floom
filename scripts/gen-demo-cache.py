#!/usr/bin/env python3
"""Regenerate sample-cache.json for the 3 hero demo apps.

Runs each app's exact /p/<slug> sample input against gemini-3.1-pro-preview
(higher quality than live Flash) and writes the golden output into
`examples/<slug>/sample-cache.json`. The runtime default is Flash, so any
non-sample input still falls through to a live Flash call; the cache only
kicks in when the user clicks "Run with sample" or reproduces the sample
verbatim.

Why this exists:
  - Stage demos must feel instant. Pro runtime is 15-40s, Flash is 5-10s,
    cache hit is <500ms. Cache hit ships the Pro-quality golden.
  - Each app has its own `canonical_input` contract (see each main.py).
    This script imports that module so we never drift from runtime
    canonicalization.

Usage:
  GEMINI_API_KEY=... python3 scripts/gen-demo-cache.py            # all 3
  GEMINI_API_KEY=... python3 scripts/gen-demo-cache.py lead-scorer  # one
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GOLDEN_MODEL = "gemini-3.1-pro-preview"

# Exact sample inputs that appear pre-filled on /p/<slug>. MUST mirror
# apps/web/src/lib/app-examples.ts::LAUNCH_DEMO_EXAMPLES and the files
# under apps/web/public/examples/<slug>/.
LEAD_SCORER_ICP = (
    "B2B SaaS CFOs at 100-500 employee fintechs in EU. Looking for finance leaders "
    "at growth-stage companies with recent funding or hiring signals."
)
LEAD_SCORER_CSV = REPO_ROOT / "apps/web/public/examples/lead-scorer/sample-leads.csv"

COMPETITOR_URLS = "https://linear.app\nhttps://notion.so\nhttps://asana.com"
COMPETITOR_YOUR_PRODUCT = (
    "We sell B2B sales automation software to EU mid-market teams. "
    "AI-native, usage-based pricing, integrates with Salesforce and HubSpot."
)

RESUME_JD = (
    "Senior Backend Engineer (Remote EU). 5+ years building production Python services.\n"
    "Responsibilities: own the ingestion pipeline, design the scoring model, mentor two\n"
    "engineers. Stack: Python 3.12, FastAPI, Postgres, Redis, AWS. Nice-to-have: past\n"
    "experience with LLM products or high-throughput ETL."
)
RESUME_MUST_HAVES = (
    "5+ years Python\nProduction Postgres experience\nRemote-friendly timezone (UTC-3 to UTC+3)"
)
RESUME_ZIP = REPO_ROOT / "apps/web/public/examples/resume-screener/sample-cvs.zip"


def _import_app(slug: str):
    """Import examples/<slug>/main.py as a module. Clear any stale import
    from a prior loop iteration so each app sees its own SAMPLE_CACHE_PATH."""
    sys.path.insert(0, str(REPO_ROOT / "examples" / slug))
    if "main" in sys.modules:
        del sys.modules["main"]
    import main  # type: ignore
    # pop the path entry so the next import doesn't collide
    sys.path.pop(0)
    return main


def _write_cache(slug: str, hash_key: str, canonical_str: str, golden: dict) -> None:
    app_dir = REPO_ROOT / "examples" / slug
    stored = dict(golden)
    # Stored shape: cache_hit False (honest), model = GOLDEN_MODEL.
    # Runtime lookup overrides both to show "gemini-3.1-pro-preview (cached)".
    stored["cache_hit"] = False
    stored["model"] = GOLDEN_MODEL
    # For competitor-analyzer the model lives under meta{}, mirror there too.
    if isinstance(stored.get("meta"), dict):
        stored["meta"] = {**stored["meta"], "cache_hit": False, "model": GOLDEN_MODEL}

    cache_file = {
        "_comment": (
            f"Pre-generated golden responses for the /p/{slug} demo sample "
            "inputs. If the user submits the exact sample (canonical hash "
            "below matches), main.py returns this blob in <500ms. Any other "
            "input falls through to a live Gemini Flash call. Regenerate "
            "with `python3 scripts/gen-demo-cache.py` after changing the "
            "sample assets or canonical_input()."
        ),
        "generated_with": GOLDEN_MODEL,
        "entries": {hash_key: stored},
        "_debug": {"canonical": canonical_str},
    }

    cache_path = app_dir / "sample-cache.json"
    with open(cache_path, "w", encoding="utf-8") as f:
        json.dump(cache_file, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"  wrote {cache_path.relative_to(REPO_ROOT)} ({cache_path.stat().st_size} bytes)")


def gen_lead_scorer() -> None:
    print("[lead-scorer] generating golden with gemini-3.1-pro-preview")
    app = _import_app("lead-scorer")
    os.environ["GEMINI_MODEL"] = GOLDEN_MODEL
    golden = app.score(data=str(LEAD_SCORER_CSV), icp=LEAD_SCORER_ICP)
    h = app._input_hash(str(LEAD_SCORER_CSV), LEAD_SCORER_ICP)
    canonical = app.canonical_input(str(LEAD_SCORER_CSV), LEAD_SCORER_ICP)
    print(f"  scored {golden.get('scored', 0)}/{golden.get('total', 0)} rows")
    _write_cache("lead-scorer", h, canonical, golden)


def gen_competitor_analyzer() -> None:
    """Run the competitor-analyzer CLI in-process by invoking main()."""
    print("[competitor-analyzer] generating golden with gemini-3.1-pro-preview")
    app = _import_app("competitor-analyzer")
    os.environ["GEMINI_MODEL"] = GOLDEN_MODEL

    # competitor-analyzer is a main()-driven CLI. We invoke it by patching
    # argv + stdin, capturing the __FLOOM_RESULT__ line from stdout.
    import io as _io
    import contextlib

    payload = json.dumps({
        "action": "analyze",
        "inputs": {"urls": COMPETITOR_URLS, "your_product": COMPETITOR_YOUR_PRODUCT},
    })
    old_argv = sys.argv
    sys.argv = ["competitor-analyzer", payload]
    buf = _io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = app.main()
    finally:
        sys.argv = old_argv

    if rc != 0:
        raise RuntimeError(f"competitor-analyzer main() returned rc={rc}; output={buf.getvalue()[-500:]}")

    # Parse the __FLOOM_RESULT__ line.
    marker = "__FLOOM_RESULT__"
    for line in buf.getvalue().splitlines():
        if line.startswith(marker):
            result = json.loads(line[len(marker):])
            if not result.get("ok"):
                raise RuntimeError(f"run failed: {result.get('error')}")
            golden = result["outputs"]
            break
    else:
        raise RuntimeError("no __FLOOM_RESULT__ line in output")

    h = app._input_hash(COMPETITOR_URLS, COMPETITOR_YOUR_PRODUCT)
    canonical = app.canonical_input(COMPETITOR_URLS, COMPETITOR_YOUR_PRODUCT)
    meta = golden.get("meta", {})
    print(f"  analyzed {meta.get('analyzed', 0)}/{meta.get('analyzed', 0) + meta.get('failed', 0)} competitors")
    _write_cache("competitor-analyzer", h, canonical, golden)


def gen_resume_screener() -> None:
    print("[resume-screener] generating golden with gemini-3.1-pro-preview")
    app = _import_app("resume-screener")
    os.environ["GEMINI_MODEL"] = GOLDEN_MODEL
    golden = app.screen(
        cvs_zip=str(RESUME_ZIP),
        job_description=RESUME_JD,
        must_haves=RESUME_MUST_HAVES,
    )
    h = app._input_hash(str(RESUME_ZIP), RESUME_JD, RESUME_MUST_HAVES)
    canonical = app.canonical_input(str(RESUME_ZIP), RESUME_JD, RESUME_MUST_HAVES)
    print(f"  scored {golden.get('scored', 0)}/{golden.get('total', 0)} CVs")
    _write_cache("resume-screener", h, canonical, golden)


GENERATORS = {
    "lead-scorer": gen_lead_scorer,
    "competitor-analyzer": gen_competitor_analyzer,
    "resume-screener": gen_resume_screener,
}


def main() -> int:
    if not os.environ.get("GEMINI_API_KEY"):
        print("ERROR: GEMINI_API_KEY not set", file=sys.stderr)
        return 1
    targets = sys.argv[1:] or list(GENERATORS.keys())
    for slug in targets:
        fn = GENERATORS.get(slug)
        if fn is None:
            print(f"ERROR: unknown slug '{slug}'. Known: {', '.join(GENERATORS)}", file=sys.stderr)
            return 1
        fn()
    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
