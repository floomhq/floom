from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _fake_curl(tmp_path: Path, failing_status: str) -> Path:
    curl = tmp_path / "curl"
    curl.write_text(
        "\n".join(
            [
                "#!/usr/bin/env bash",
                "url=\"${@: -1}\"",
                "if [[ \"$url\" == *'/app/runs' ]]; then",
                f"  printf '{failing_status}'",
                "else",
                "  printf '200'",
                "fi",
            ]
        ),
        encoding="utf-8",
    )
    curl.chmod(curl.stat().st_mode | stat.S_IXUSR)
    return curl


def test_smoke_routes_fails_on_4xx(tmp_path: Path) -> None:
    _fake_curl(tmp_path, "404")
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"}

    result = subprocess.run(
        ["bash", "ops/smoke-routes.sh", "cloud"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 1
    assert "FAIL  cloud  https://floom.dev/app/runs  -> 404" in result.stdout
    assert "SMOKE FAILED - do not promote this deploy." in result.stdout


def test_smoke_routes_fails_on_5xx(tmp_path: Path) -> None:
    _fake_curl(tmp_path, "503")
    env = {**os.environ, "PATH": f"{tmp_path}:{os.environ['PATH']}"}

    result = subprocess.run(
        ["bash", "ops/smoke-routes.sh", "cloud"],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )

    assert result.returncode == 1
    assert "FAIL  cloud  https://floom.dev/app/runs  -> 503" in result.stdout
    assert "SMOKE FAILED - do not promote this deploy." in result.stdout
