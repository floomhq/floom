"""#542 — reusable Emily Slack onboarding skill artifact.

The durable artifact is docs/integrations/emily-slack-onboarding.md. This
test pins (a) the artifact exists with the four required sections (install,
auth/linking, first DM/channel use, troubleshooting) and (b) every endpoint
and env var the skill instructs people to use actually exists in
channels/slack.py — so the runbook cannot silently drift from the code.

Run: cd apps/api && python -m pytest tests/test_emily_slack_onboarding_skill_542.py -q
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

REPO_ROOT = API_DIR.parents[1]
SKILL_DOC = REPO_ROOT / "docs" / "integrations" / "emily-slack-onboarding.md"
SLACK_SRC = API_DIR / "channels" / "slack.py"


def _doc() -> str:
    assert SKILL_DOC.is_file(), f"skill artifact missing: {SKILL_DOC}"
    return SKILL_DOC.read_text(encoding="utf-8")


def test_skill_covers_required_sections():
    doc = _doc().lower()
    for required in ("install", "auth and account linking", "first use", "troubleshooting"):
        assert required in doc, f"skill artifact missing required section: {required!r}"
    # the four onboarding surfaces from the issue
    for surface in ("dm", "@mention", "/floom", "claim"):
        assert surface in doc, f"skill artifact must cover {surface!r}"


def test_documented_endpoints_exist_in_code():
    doc = _doc()
    src = SLACK_SRC.read_text(encoding="utf-8")
    real_routes = set(re.findall(r'@slack_router\.\w+\("([^"]+)"', src))
    documented = set(re.findall(r"`(?:GET |POST |DELETE )?(/slack/[a-z/_{}]+)`", doc))
    assert documented, "skill artifact documents no /slack endpoints"
    missing = {d for d in documented if d not in real_routes}
    assert not missing, f"skill documents endpoints that do not exist: {sorted(missing)}"


def test_documented_env_vars_exist_in_code():
    doc = _doc()
    src = SLACK_SRC.read_text(encoding="utf-8")
    documented = set(re.findall(r"`(SLACK_[A-Z_]+)`", doc))
    assert {"SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_CLIENT_ID"} <= documented
    missing = {name for name in documented if name not in src}
    assert not missing, f"skill documents env vars unknown to channels/slack.py: {sorted(missing)}"


def test_setup_allowlist_fully_documented():
    from channels.slack import SLACK_SETUP_ENV_ALLOWLIST
    doc = _doc()
    undocumented = {name for name in SLACK_SETUP_ENV_ALLOWLIST if f"`{name}`" not in doc}
    assert not undocumented, f"setup-config env keys missing from skill: {sorted(undocumented)}"
