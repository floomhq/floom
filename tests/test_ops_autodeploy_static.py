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


def test_autodeploy_unit_is_versioned():
    oss = (ROOT / "ops" / "floom-api-autodeploy.service").read_text(encoding="utf-8")

    assert "WORKEROS_ROOT=/opt/floom" in oss
    assert "WORKEROS_DEPLOY_CMD=/opt/floom/ops/deploy-api.sh" in oss
    assert "ExecStart=/opt/floom/ops/autodeploy-api.sh" in oss


def test_cloud_autodeploy_is_out_of_oss_scope():
    assert not (ROOT / "ops" / "managed-deployment-api-autodeploy.service").exists()

    readme = (ROOT / "ops" / "README.md").read_text(encoding="utf-8")
    deploy = (ROOT / "ops" / "DEPLOY.md").read_text(encoding="utf-8")

    for text in (readme, deploy):
        lower = text.lower()
        assert "self-hosted" in lower
        assert "cloud" in lower
        assert "deploy" in lower
