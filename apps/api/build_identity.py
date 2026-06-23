"""Build/deploy identity helpers for release automation smoke checks."""

from __future__ import annotations

import os
from typing import Any


def _first_env(*names: str, default: str = "unknown") -> str:
    for name in names:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return default


def build_identity(*, service: str = "cloud-api") -> dict[str, Any]:
    """Return normalized deploy identity for API/worker release gates.

    Deploy workers should set WORKEROS_BUILD_SHA explicitly. Provider-specific
    variables are fallback compatibility only; smoke should compare build_sha
    to the expected promoted SHA and treat "unknown" as not verified.
    """

    return {
        "service": _first_env("WORKEROS_BUILD_SERVICE", default=service),
        "role": _first_env("WORKEROS_ROLE", default="all"),
        "deploy": _first_env("WORKEROS_DEPLOY", default="cloud"),
        "environment": _first_env(
            "WORKEROS_ENVIRONMENT",
            "RAILWAY_ENVIRONMENT_NAME",
            "VERCEL_ENV",
            default="unknown",
        ),
        "build_sha": _first_env(
            "WORKEROS_BUILD_SHA",
            "BUILD_SHA",
            "RAILWAY_GIT_COMMIT_SHA",
            "VERCEL_GIT_COMMIT_SHA",
            "GITHUB_SHA",
        ),
        "build_ref": _first_env(
            "WORKEROS_BUILD_REF",
            "RAILWAY_GIT_BRANCH",
            "VERCEL_GIT_COMMIT_REF",
            "GITHUB_REF_NAME",
        ),
        "build_time": _first_env("WORKEROS_BUILD_TIME", "BUILD_TIME"),
        "build_source": _first_env("WORKEROS_BUILD_SOURCE", default="unknown"),
    }
