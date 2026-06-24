#!/usr/bin/env python3
"""Verify deployed Cloud targets are serving the expected build SHA.

Environment:
  WORKEROS_IDENTITY_EXPECTED_SHA       Required expected git/build SHA.
  WORKEROS_IDENTITY_API_BASE           Optional API base, e.g. https://workeros-api.floom.dev.
  WORKEROS_IDENTITY_WEB_BASE           Optional apex/landing base, e.g. https://floom.dev.
  WORKEROS_IDENTITY_DASHBOARD_BASE     Optional direct dashboard base.
  WORKEROS_IDENTITY_API_VERSION_URL    Optional explicit API version URL.
  WORKEROS_IDENTITY_LANDING_VERSION_URL Optional explicit landing version URL.
  WORKEROS_IDENTITY_DASHBOARD_VERSION_URL Optional explicit dashboard version URL.
  WORKEROS_IDENTITY_ATTEMPTS           Retry attempts. Default 1.
  WORKEROS_IDENTITY_INTERVAL_SECONDS   Retry interval. Default 10.

At least one target URL/base must be configured. Smoke fails unless every
configured target returns JSON with build_sha exactly equal to the expected SHA.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


class IdentitySmokeError(RuntimeError):
    pass


@dataclass(frozen=True)
class Target:
    name: str
    url: str


@dataclass(frozen=True)
class Config:
    expected_sha: str
    targets: tuple[Target, ...]
    attempts: int = 1
    interval_seconds: float = 10.0
    timeout_seconds: float = 20.0

    @classmethod
    def from_env(cls) -> "Config":
        expected = _required_env("WORKEROS_IDENTITY_EXPECTED_SHA")
        targets = tuple(_targets_from_env())
        if not targets:
            raise IdentitySmokeError(
                "configure at least one identity target URL/base"
            )
        return cls(
            expected_sha=expected,
            targets=targets,
            attempts=max(1, int(os.environ.get("WORKEROS_IDENTITY_ATTEMPTS") or "1")),
            interval_seconds=float(os.environ.get("WORKEROS_IDENTITY_INTERVAL_SECONDS") or "10"),
            timeout_seconds=float(os.environ.get("WORKEROS_IDENTITY_TIMEOUT_SECONDS") or "20"),
        )


def _required_env(name: str) -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        raise IdentitySmokeError(f"{name} is required")
    return value


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip().rstrip("/")


def _targets_from_env() -> list[Target]:
    targets: list[Target] = []
    api_url = _env("WORKEROS_IDENTITY_API_VERSION_URL")
    landing_url = _env("WORKEROS_IDENTITY_LANDING_VERSION_URL")
    dashboard_url = _env("WORKEROS_IDENTITY_DASHBOARD_VERSION_URL")
    api_base = _env("WORKEROS_IDENTITY_API_BASE")
    web_base = _env("WORKEROS_IDENTITY_WEB_BASE")
    dashboard_base = _env("WORKEROS_IDENTITY_DASHBOARD_BASE")

    if api_url:
        targets.append(Target("api", api_url))
    elif api_base:
        targets.append(Target("api", f"{api_base}/version"))

    if landing_url:
        targets.append(Target("landing", landing_url))
    elif web_base:
        targets.append(Target("landing", f"{web_base}/version"))

    if dashboard_url:
        targets.append(Target("dashboard", dashboard_url))
    elif dashboard_base:
        targets.append(Target("dashboard", f"{dashboard_base}/app/version"))
    elif web_base:
        targets.append(Target("dashboard", f"{web_base}/app/version"))

    return targets


def fetch_json(url: str, *, timeout_seconds: float) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            payload = json.loads(body)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise IdentitySmokeError(f"{url} returned HTTP {exc.code}: {body[:500]}") from exc
    except Exception as exc:
        raise IdentitySmokeError(f"{url} failed: {exc}") from exc
    if not isinstance(payload, dict):
        raise IdentitySmokeError(f"{url} did not return a JSON object")
    return payload


FetchFn = Callable[[str, float], dict[str, Any]]


def verify_once(config: Config, fetch: FetchFn | None = None) -> list[str]:
    fetch = fetch or (lambda url, timeout: fetch_json(url, timeout_seconds=timeout))
    passed: list[str] = []
    failures: list[str] = []
    for target in config.targets:
        try:
            payload = fetch(target.url, config.timeout_seconds)
            actual = str(payload.get("build_sha") or "").strip()
            service = str(payload.get("service") or target.name)
            if actual != config.expected_sha:
                failures.append(
                    f"{target.name}: build_sha={actual or '(missing)'} expected={config.expected_sha} url={target.url}"
                )
                continue
            passed.append(f"{target.name}:{service}:{actual}")
        except Exception as exc:
            failures.append(f"{target.name}: {exc}")
    if failures:
        raise IdentitySmokeError("; ".join(failures))
    return passed


def run_smoke(config: Config, fetch: FetchFn | None = None) -> list[str]:
    last_error: Exception | None = None
    for attempt in range(1, config.attempts + 1):
        try:
            return verify_once(config, fetch=fetch)
        except Exception as exc:
            last_error = exc
            print(f"identity smoke attempt {attempt}/{config.attempts} failed: {exc}", file=sys.stderr)
            if attempt < config.attempts:
                time.sleep(config.interval_seconds)
    raise IdentitySmokeError(str(last_error))


def main() -> int:
    try:
        passed = run_smoke(Config.from_env())
    except IdentitySmokeError as exc:
        print(f"IDENTITY SMOKE FAILED: {exc}", file=sys.stderr)
        return 1
    for item in passed:
        print(f"ok  {item}")
    print(f"IDENTITY SMOKE PASSED: {len(passed)} target(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
