import json

import pytest

from ops.build_identity_env import build_identity_env, render_env


def test_build_identity_env_sets_runtime_and_next_public_values():
    values = build_identity_env(
        sha="abc123",
        ref="staging",
        source="cloud-staging-deploy-smoke",
        build_time="2026-06-23T20:00:00+00:00",
    )

    assert values["WORKEROS_BUILD_SHA"] == "abc123"
    assert values["BUILD_SHA"] == "abc123"
    assert values["NEXT_PUBLIC_BUILD_SHA"] == "abc123"
    assert values["WORKEROS_BUILD_REF"] == "staging"
    assert values["NEXT_PUBLIC_BUILD_REF"] == "staging"
    assert values["WORKEROS_BUILD_SOURCE"] == "cloud-staging-deploy-smoke"
    assert values["NEXT_PUBLIC_BUILD_SOURCE"] == "cloud-staging-deploy-smoke"
    assert values["WORKEROS_BUILD_TIME"] == "2026-06-23T20:00:00+00:00"
    assert values["NEXT_PUBLIC_BUILD_TIME"] == "2026-06-23T20:00:00+00:00"


def test_build_identity_env_requires_sha():
    with pytest.raises(ValueError, match="sha is required"):
        build_identity_env(sha=" ")


def test_render_json_format():
    values = build_identity_env(
        sha="abc123",
        ref="staging",
        source="worker",
        build_time="2026-06-23T20:00:00+00:00",
    )

    rendered = json.loads(render_env(values, "json"))

    assert rendered["WORKEROS_BUILD_SHA"] == "abc123"
    assert rendered["NEXT_PUBLIC_BUILD_SHA"] == "abc123"


def test_render_shell_quotes_values():
    values = build_identity_env(
        sha="abc'123",
        ref="staging",
        source="worker",
        build_time="2026-06-23T20:00:00+00:00",
    )

    rendered = render_env(values, "shell")

    assert "WORKEROS_BUILD_SHA='abc'\"'\"'123'" in rendered


def test_render_github_env_format():
    values = build_identity_env(
        sha="abc123",
        ref="staging",
        source="worker",
        build_time="2026-06-23T20:00:00+00:00",
    )

    rendered = render_env(values, "github-env")

    assert "WORKEROS_BUILD_SHA=abc123\n" in rendered
    assert "NEXT_PUBLIC_BUILD_SHA=abc123\n" in rendered
