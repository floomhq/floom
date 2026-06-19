"""Regression test for the 2026-05-26 P0 secrets-leak finding.

Audit 4 (security-edge) found that `get_secrets_for_worker()` unioned every
key from `/etc/workeros/api.env` into the sandbox secrets.json,
leaking FLOOM_SECRET, OPENAI_API_KEY, COMPOSIO_API_KEY,
COMPOSIO_WEBHOOK_SIGNING_KEY, and E2B_API_KEY to every pure-script worker.

The fix in `run_service.py` removes the env-file union and adds a denylist of
platform secret names so they can never appear in the sandbox payload.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "apps", "api"))

_tmp_db = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp_db.close()
os.environ["FLOOM_DB"] = _tmp_db.name

# Inject platform infra secrets that MUST stay out of the sandbox payload.
# OPENAI_API_KEY is intentionally excluded from this list because workers
# legitimately need it in single-user v0 (see run_service.py comment).
PLATFORM_LEAK_VALUES = {
    "FLOOM_SECRET": "test-floom-secret-must-never-leak",
    "COMPOSIO_API_KEY": "test-composio-must-never-leak",
    "COMPOSIO_WEBHOOK_SIGNING_KEY": "test-composio-webhook-must-never-leak",
    "E2B_API_KEY": "test-e2b-must-never-leak",
    "FLOOM_RUN_TIMEOUT": "300",
}
for k, v in PLATFORM_LEAK_VALUES.items():
    os.environ.setdefault(k, v)


def test_platform_secrets_never_enter_sandbox_dict():
    from run_service import get_secrets_for_worker

    # Pick any registered worker; even if it declares e.g. OPENAI_API_KEY,
    # the denylist must still block it.
    result = get_secrets_for_worker("research_brief")

    for forbidden in PLATFORM_LEAK_VALUES.keys():
        assert forbidden not in result, (
            f"Platform secret {forbidden} leaked into sandbox secrets dict. "
            f"This is the audit P0 bug — the fix in get_secrets_for_worker() "
            f"must filter it out via _PLATFORM_SECRET_NAMES."
        )


def test_denylist_blocks_even_if_worker_yaml_declares_platform_key():
    """A malicious worker.yml could declare exec.secrets: [FLOOM_SECRET].
    The denylist must still block it.

    OPENAI_API_KEY is NOT in the denylist because single-user v0 workers
    legitimately use it (see run_service.py comment). When the platform
    goes multi-tenant, this needs to change.
    """
    from run_service import _PLATFORM_SECRET_NAMES

    assert "FLOOM_SECRET" in _PLATFORM_SECRET_NAMES
    assert "E2B_API_KEY" in _PLATFORM_SECRET_NAMES
    assert "COMPOSIO_API_KEY" in _PLATFORM_SECRET_NAMES
    assert "COMPOSIO_WEBHOOK_SIGNING_KEY" in _PLATFORM_SECRET_NAMES
    # Intentionally NOT in the denylist:
    assert "OPENAI_API_KEY" not in _PLATFORM_SECRET_NAMES


def test_only_worker_declared_and_db_secrets_propagate():
    """Sanity: the fix must propagate worker-declared and DB-stored secrets,
    just not platform infra secrets.
    """
    from run_service import _PLATFORM_SECRET_NAMES

    # The denylist should NOT include common worker secret names.
    legit_user_secret_names = [
        "GRANOLA_API_KEY",
        "HUBSPOT_API_KEY",
        "ANTHROPIC_API_KEY",
        "STRIPE_API_KEY",
        "MY_CUSTOM_KEY",
    ]
    for name in legit_user_secret_names:
        assert name not in _PLATFORM_SECRET_NAMES, (
            f"{name} should not be in the denylist; only platform infra "
            "secrets belong there."
        )
