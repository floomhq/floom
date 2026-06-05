"""Regression checks for ops/deploy-api.sh.

The deploy script runs only on the production host as root, so these tests keep
to syntax and ordering checks that catch the venv quirk without touching a live
service.
"""

from __future__ import annotations

import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = REPO_ROOT / "ops" / "deploy-api.sh"


def test_deploy_script_is_valid_bash():
    result = subprocess.run(
        ["bash", "-n", str(DEPLOY_SCRIPT)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_deploy_installs_deployed_requirements_into_service_venv_before_restart():
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")

    assert 'SERVICE_VENV="${WORKEROS_API_VENV:-$WORKEROS_ROOT/apps/api/venv}"' in script
    assert 'API_REQUIREMENTS="${WORKEROS_API_REQUIREMENTS:-$WORKEROS_ROOT/apps/api/requirements.txt}"' in script
    assert '"$SERVICE_VENV/bin/python" -m pip install -r "$API_REQUIREMENTS"' in script
    assert '"$SERVICE_VENV/bin/python" -m pip check' in script

    install_pos = script.index('"$SERVICE_VENV/bin/python" -m pip install -r "$API_REQUIREMENTS"')
    restart_pos = script.index('systemctl restart "$SERVICE_NAME"')
    assert install_pos < restart_pos
