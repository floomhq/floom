from __future__ import annotations

import logging
import sys
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1]
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

import run_service
from run_service import scrub_secrets, scrub_secret_values


def test_short_config_word_not_blind_replaced(caplog):
    """The reported bug: a config flag declared as a secret with value 'Full'
    must not redact every 'Full' in legitimate output."""
    secrets = {"EXTERNAL_APIFY_PROFILE_SCRAPER_MODE": "Full"}
    with caplog.at_level(logging.WARNING, logger="floom.run_service"):
        result = scrub_secrets("Full Stack Engineer", secrets)
    assert result == "Full Stack Engineer"
    # Operator gets warned to move it to env:.
    assert any("low-entropy" in rec.message for rec in caplog.records)


def test_real_api_key_value_still_redacted():
    secrets = {"APIFY_API_KEY": "a1b2c3d4e5f6g7h8i9j0k1l2"}
    result = scrub_secrets("token is a1b2c3d4e5f6g7h8i9j0k1l2 here", secrets)
    assert "a1b2c3d4e5f6g7h8i9j0k1l2" not in result
    assert "<REDACTED:APIFY_API_KEY>" in result


def test_credential_named_short_value_still_redacted():
    secrets = {"API_PIN": "1234"}
    result = scrub_secrets("the pin is 1234 ok", secrets)
    assert "<REDACTED:API_PIN>" in result
    assert "1234" not in result


def test_sk_live_and_jwt_patterns_still_redacted():
    text = (
        "key sk_live_abcDEF123 and "
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF-_123"
    )
    result = scrub_secrets(text, {})
    assert "sk_live_abcDEF123" not in result
    assert "eyJhbGciOiJIUzI1NiJ9" not in result
    assert result.count("<REDACTED>") >= 2


def test_high_entropy_value_redacted_even_with_config_name():
    # Config-class name but value is clearly credential-shaped -> still redacted.
    secrets = {"MODEL_REGION": "k7Qz9_aB3xR-2mN4pLs8"}
    result = scrub_secrets("region=k7Qz9_aB3xR-2mN4pLs8", secrets)
    assert "k7Qz9_aB3xR-2mN4pLs8" not in result
    assert "<REDACTED:MODEL_REGION>" in result


def test_word_boundary_value_does_not_mangle_substrings():
    # Non-credential, non-config name, ambiguous value -> word-boundary only.
    secrets = {"SCRAPER_TAG": "auto"}
    result = scrub_secrets("automatic auto pilot", secrets)
    assert result == "automatic <REDACTED:SCRAPER_TAG> pilot"


def test_punctuation_bounded_short_secret_still_redacted():
    # Non-credential name, short value with punctuation edges: \b...\b would
    # not match, leaking the value. Adaptive boundary must still redact it.
    secrets = {"SALT": "$abc$"}
    result = scrub_secrets("salt $abc$ done", secrets)
    assert "$abc$" not in result
    assert "<REDACTED:SALT>" in result


def test_numeric_config_value_not_blind_replaced():
    # Mis-declared numeric config cap: must not corrupt legitimate numbers.
    secrets = {"REQUEST_TIMEOUT": "3000"}
    result = scrub_secrets("waited 3000 ms for 3000 items", secrets)
    assert result == "waited 3000 ms for 3000 items"


def test_persisted_output_dict_value_quality_gate():
    secrets = {
        "EXTERNAL_APIFY_PROFILE_SCRAPER_MODE": "Full",
        "OUTPUT_SECRET": "sk-legacy-output-secret-9af",
    }
    output = {
        "title": "Full Stack Engineer",
        "blob": "prefix-sk-legacy-output-secret-9af",
        "items": ["Full time", {"v": "sk-legacy-output-secret-9af"}],
    }
    safe = scrub_secret_values(output, secrets)
    assert safe["title"] == "Full Stack Engineer"
    assert safe["items"][0] == "Full time"
    assert "sk-legacy-output-secret-9af" not in safe["blob"]
    assert "<REDACTED:OUTPUT_SECRET>" in safe["blob"]
    assert safe["items"][1]["v"] == "<REDACTED:OUTPUT_SECRET>"
