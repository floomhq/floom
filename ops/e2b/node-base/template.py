"""Build the shared WorkerOS Node E2B base template.

Usage:
    python ops/e2b/node-base/template.py
"""

from __future__ import annotations

import os

from e2b import Template, default_build_logger


COMMON_NODE_PACKAGES = [
    "axios",
    "dotenv",
]


def _int_env(*names: str, default: int) -> int:
    for name in names:
        value = os.environ.get(name)
        if value:
            return int(value)
    return default


def build_template() -> object:
    template = (
        Template()
        .from_node_image("lts")
        .apt_install(["git", "tar"])
        .npm_install(COMMON_NODE_PACKAGES)
    )
    return Template.build(
        template,
        alias=os.environ.get("WORKEROS_E2B_NODE_TEMPLATE_ALIAS", "workeros-node-base"),
        cpu_count=_int_env("WORKEROS_E2B_NODE_TEMPLATE_CPU_COUNT", "WORKEROS_E2B_TEMPLATE_CPU_COUNT", default=2),
        memory_mb=_int_env("WORKEROS_E2B_NODE_TEMPLATE_MEMORY_MB", "WORKEROS_E2B_TEMPLATE_MEMORY_MB", default=1024),
        skip_cache=(os.environ.get("SKIP_CACHE") or "").lower() in {"1", "true", "yes", "on"},
        on_build_logs=default_build_logger(),
    )


if __name__ == "__main__":
    info = build_template()
    print(info)
