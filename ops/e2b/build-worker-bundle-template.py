"""Build an E2B template containing one WorkerOS worker bundle.

Example:
    python ops/e2b/build-worker-bundle-template.py \
      --worker-dir workers/novasearch-v5 \
      --cache-file data/e2b-template-cache.json

Then run the API with:
    WORKEROS_E2B_TEMPLATE_CACHE_FILE=data/e2b-template-cache.json

The worker must opt in with `exec.bundle_baked: true`; otherwise the runtime
will ignore the cache entry and continue using the normal upload path.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
API_DIR = REPO_ROOT / "apps" / "api"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

from models import WorkerConfig, parse_worker_manifest, worker_contract_to_worker_config  # noqa: E402
from runner_sandbox.e2b_bundle_template import (  # noqa: E402
    build_worker_bundle_template,
    configured_template_cache_file,
)


def _load_config(worker_dir: Path, worker_id: str | None) -> WorkerConfig:
    manifest_path = worker_dir / "worker.yml"
    raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{manifest_path} must contain a YAML mapping")
    manifest = parse_worker_manifest(raw)
    if isinstance(manifest, WorkerConfig):
        return manifest
    resolved_worker_id = worker_id or str(raw.get("id") or raw.get("name") or worker_dir.name)
    return worker_contract_to_worker_config(manifest, resolved_worker_id)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-dir", required=True, type=Path)
    parser.add_argument("--worker-id")
    parser.add_argument("--alias")
    parser.add_argument("--cache-file", type=Path)
    parser.add_argument("--skip-cache", action="store_true")
    args = parser.parse_args()

    worker_dir = args.worker_dir.resolve()
    config = _load_config(worker_dir, args.worker_id)
    if not getattr(config.runtime, "bundle_baked", False):
        raise SystemExit("worker.yml must set exec.bundle_baked: true before building a bundle-baked template")

    cache_file = args.cache_file or configured_template_cache_file()
    cache_key, template_id = build_worker_bundle_template(
        worker_dir=worker_dir,
        config=config,
        alias=args.alias,
        cache_file=cache_file,
        skip_cache=args.skip_cache,
    )
    print(f"cache_key={cache_key}")
    print(f"template_id={template_id}")
    if cache_file:
        print(f"cache_file={cache_file}")
    else:
        print("Set WORKEROS_E2B_TEMPLATE_CACHE_JSON or pass --cache-file with the mapping above.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
