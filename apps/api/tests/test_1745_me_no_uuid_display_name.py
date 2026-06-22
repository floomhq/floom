"""#1745 — /me must never emit the raw user UUID as display_name.

The Emily greeting interpolates `/me.display_name` directly, so a fallback of
`display_name = user_id` surfaced "Good morning, 9b1a5065-...". `_human_display_name`
returns a real label (email/username) or None — never the user_id and never a
bare UUID — so the client resolves its own friendly fallback.
"""

from __future__ import annotations

from routers.workspaces import _human_display_name

UUID = "9b1a5065-3ab9-493a-8220-b6c139d9c1b7"


def test_prefers_email():
    assert _human_display_name("fede@floom.dev", "fede", user_id=UUID) == "fede@floom.dev"


def test_falls_back_to_username_when_no_email():
    assert _human_display_name(None, "fede", user_id=UUID) == "fede"


def test_returns_none_when_only_user_id_available():
    assert _human_display_name(None, None, user_id=UUID) is None


def test_never_returns_value_equal_to_user_id():
    # username accidentally set to the user_id (some auth setups)
    assert _human_display_name(None, UUID, user_id=UUID) is None


def test_never_returns_a_bare_uuid_even_if_not_the_user_id():
    other_uuid = "11111111-2222-3333-4444-555555555555"
    assert _human_display_name(other_uuid, None, user_id=UUID) is None


def test_skips_blank_candidates():
    assert _human_display_name("", "   ", "real-name", user_id=UUID) == "real-name"
