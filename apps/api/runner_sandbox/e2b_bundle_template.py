"""Build E2B templates that contain a worker bundle.

This module is intentionally not on the run hot path. Operators can call it
from deploy automation for workers that opt in with ``exec.bundle_baked: true``.
Runs fall back to normal upload until the produced cache entry is present.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from models import WorkerConfig

from .e2b_driver import (
    _DEFAULT_TEMPLATE_CPU_COUNT,
    _default_template_resources,
    _e2b_template_for_config,
    _runtime_kind,
    _worker_resources,
    _worker_template_cache_key,
)


WORKER_TEMPLATE_WORKDIR = "/home/user/worker"


def should_include_bundle_path(path: Path, rel: Path) -> bool:
    if rel.parts and rel.parts[0] in {"inputs", ".pytest_cache", ".ruff_cache"}:
        return False
    if "__pycache__" in rel.parts:
        return False
    if rel.suffix in {".pyc", ".pyo"}:
        return False
    return path.is_file()


def stage_worker_bundle(worker_dir: Path, *, parent_dir: Path | None = None) -> Path:
    worker_dir = worker_dir.resolve()
    if not worker_dir.is_dir():
        raise FileNotFoundError(f"worker bundle directory not found: {worker_dir}")
    if parent_dir is None:
        parent_dir = Path(tempfile.mkdtemp(prefix="workeros-e2b-bundle."))
    staged = parent_dir / "worker"
    staged.mkdir(parents=True, exist_ok=True)
    for path in worker_dir.rglob("*"):
        rel = path.relative_to(worker_dir)
        if not should_include_bundle_path(path, rel):
            continue
        dest = staged / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
    return staged


def _base_builder(template_cls: Any, config: WorkerConfig | None):
    base_template = _e2b_template_for_config(config)
    if base_template:
        return template_cls().from_template(base_template)
    kind = _runtime_kind(config)
    if kind == "node":
        return template_cls().from_node_image("22").apt_install(["git", "tar"])
    return template_cls().from_python_image("3.11").apt_install(["git", "tar"])


def _template_id(info: Any) -> str:
    if isinstance(info, dict):
        for key in ("template_id", "id", "templateId"):
            value = info.get(key)
            if value:
                return str(value)
    for key in ("template_id", "id", "templateId"):
        value = getattr(info, key, None)
        if value:
            return str(value)
    text = str(info).strip()
    if not text:
        raise RuntimeError("E2B template build returned no template id")
    return text


def update_template_cache_file(cache_file: Path, cache_key: str, template_id: str) -> dict[str, str]:
    cache: dict[str, str] = {}
    if cache_file.exists():
        raw = cache_file.read_text(encoding="utf-8").strip()
        if raw:
            loaded = json.loads(raw)
            if not isinstance(loaded, dict):
                raise ValueError("template cache file must contain a JSON object")
            cache = {str(key): str(value) for key, value in loaded.items()}
    cache[cache_key] = template_id
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return cache


def build_worker_bundle_template(
    *,
    worker_dir: Path,
    config: WorkerConfig | None,
    alias: str | None = None,
    cache_file: Path | None = None,
    skip_cache: bool = False,
) -> tuple[str, str]:
    from e2b import Template, default_build_logger  # noqa: PLC0415

    cache_key = _worker_template_cache_key(worker_dir, config)
    memory_mb, cpu_count = _worker_resources(config)
    default_memory_mb, default_cpu_count = _default_template_resources(_runtime_kind(config))
    staging_parent = Path(tempfile.mkdtemp(prefix="workeros-e2b-bundle."))
    try:
        staged = stage_worker_bundle(worker_dir, parent_dir=staging_parent)
        staged_items = list(staged.iterdir())
        builder = (
            _base_builder(Template, config)
            .make_dir(WORKER_TEMPLATE_WORKDIR)
            .copy(staged_items, WORKER_TEMPLATE_WORKDIR, force_upload=True)
            .set_workdir(WORKER_TEMPLATE_WORKDIR)
        )
        info = Template.build(
            builder,
            alias=alias or f"workeros-worker-{cache_key[:12]}",
            cpu_count=cpu_count or default_cpu_count or _DEFAULT_TEMPLATE_CPU_COUNT,
            memory_mb=memory_mb or default_memory_mb,
            skip_cache=skip_cache,
            on_build_logs=default_build_logger(),
        )
    finally:
        shutil.rmtree(staging_parent, ignore_errors=True)

    template_id = _template_id(info)
    if cache_file is not None:
        update_template_cache_file(cache_file, cache_key, template_id)
    return cache_key, template_id


def configured_template_cache_file() -> Path | None:
    raw = (os.environ.get("WORKEROS_E2B_TEMPLATE_CACHE_FILE") or "").strip()
    return Path(raw) if raw else None
