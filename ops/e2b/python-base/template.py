"""Build the shared WorkerOS Python E2B base template.

Usage:
    python ops/e2b/python-base/template.py

The build prints an account-scoped template id/alias. Put that value in
WORKEROS_E2B_PYTHON_TEMPLATE_ID and set WORKEROS_E2B_PYTHON_DEPS_BAKED=1 only
when these preinstalled packages cover the workers you want to run without
per-run pip install.
"""

from __future__ import annotations

import os

from e2b import Template, default_build_logger


COMMON_PYTHON_PACKAGES = [
    "boto3",
    "google-auth",
    "httpx",
    "litellm",
    "numpy",
    "openai",
    "python-dotenv",
    "requests",
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
        .from_python_image("3.11")
        .apt_install(["git", "tar"])
        .pip_install(COMMON_PYTHON_PACKAGES)
    )
    return Template.build(
        template,
        alias=os.environ.get("WORKEROS_E2B_PYTHON_TEMPLATE_ALIAS", "workeros-python-base"),
        cpu_count=_int_env("WORKEROS_E2B_PYTHON_TEMPLATE_CPU_COUNT", "WORKEROS_E2B_TEMPLATE_CPU_COUNT", default=2),
        memory_mb=_int_env("WORKEROS_E2B_PYTHON_TEMPLATE_MEMORY_MB", "WORKEROS_E2B_TEMPLATE_MEMORY_MB", default=2048),
        skip_cache=(os.environ.get("SKIP_CACHE") or "").lower() in {"1", "true", "yes", "on"},
        on_build_logs=default_build_logger(),
    )


if __name__ == "__main__":
    info = build_template()
    print(info)
