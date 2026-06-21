from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def _read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def test_worker_webhook_signature_accepts_legacy_header():
    source = _read("apps/api/main.py")
    assert 'request.headers.get("X-Floom-Signature", "")' in source
    assert 'request.headers.get("X-Workeros-Signature", "")' in source


def test_deploy_scripts_keep_legacy_host_compatibility():
    deploy = _read("ops/deploy-api.sh")
    autodeploy = _read("ops/autodeploy-api.sh")
    backup = _read("ops/backup-db.sh")
    rotate = _read("ops/rotate-artifacts.py")

    assert "/opt/floom" in deploy
    assert "/opt/workeros" in deploy
    assert "workeros-api.service" in deploy
    assert "floom-api.service" in deploy
    assert "/etc/workeros/api.env" in deploy
    assert "/etc/floom/api.env" in deploy

    assert "/opt/workeros" in autodeploy
    assert "workeros-api" in autodeploy
    assert "/opt/workeros" in backup
    assert "(?:floom|workeros)-" in backup
    assert "/opt/workeros" in rotate


def test_legacy_systemd_units_stay_versioned():
    for rel in (
        "ops/workeros-api.service",
        "ops/workeros-api-autodeploy.service",
        "ops/workeros-backup.service",
        "ops/workeros-backup.timer",
    ):
        assert (ROOT / rel).is_file(), rel
