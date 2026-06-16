from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_autodeploy_script_avoids_pull_and_checks_drift():
    text = (ROOT / "ops" / "autodeploy-api.sh").read_text(encoding="utf-8")

    assert "git pull" not in text
    assert "git merge" not in text
    assert "git fetch origin" in text
    assert "git diff --quiet" in text
    assert "git diff --cached --quiet" in text
    assert "git ls-files --others --exclude-standard" in text
    assert "git rev-list --left-right --count" in text
    assert "git checkout -B" in text
    assert "WORKEROS_AUTODEPLOY_ALERT_WEBHOOK" in text
    assert "curl -fsS" in text


def test_autodeploy_units_are_versioned_for_oss_and_cloud():
    oss = (ROOT / "ops" / "workeros-api-autodeploy.service").read_text(encoding="utf-8")
    cloud = (ROOT / "ops" / "workeros-cloud-api-autodeploy.service").read_text(encoding="utf-8")

    assert "WORKEROS_ROOT=/root/workeros" in oss
    assert "WORKEROS_DEPLOY_CMD=/root/workeros/ops/deploy-api.sh" in oss
    assert "ExecStart=/root/workeros/ops/autodeploy-api.sh" in oss

    assert "WORKEROS_ROOT=/opt/workeros-cloud-deploy" in cloud
    assert "WORKEROS_DEPLOY_CMD=/opt/workeros-cloud-deploy/ops/deploy-api.sh" in cloud
    assert "ExecStart=/usr/local/bin/workeros-api-autodeploy" in cloud
