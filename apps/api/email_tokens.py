"""Email design-token constants for WorkerOS transactional emails.

These mirror the CSS custom properties declared in the :root block of
``web/app/globals.css``.  Email clients strip CSS custom properties, so every
color and dimension used in hand-rolled HTML emails must be a literal value.
This module is the single source of truth for those literals.

``tests/test_email_token_parity.py`` parses globals.css at test time and fails
if any constant here drifts from the dashboard token it mirrors.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Color tokens
# ---------------------------------------------------------------------------

BG_APP = "#FBFBFC"              # mirrors --bg-app
BG_CARD = "#FFFFFF"             # mirrors --bg-card
BG_BAND = "#F2F3F5"             # mirrors --bg-2
INK = "#16171A"                 # mirrors --text-primary
MUTED = "#62697A"               # mirrors --muted-text  (a11y value; emails used #6B7280 which fails WCAG AA on #F2F3F5 band)
ACCENT = "#3563CC"              # mirrors --accent
# No BORDER token: WorkerOS cards are borderless+shadowless (globals.css
# --card-border:none, --card-shadow:none). Email cards are defined by fill
# contrast alone (white card on the #F2F3F5 band on the #FBFBFC page).

# ---------------------------------------------------------------------------
# Dimension tokens
# ---------------------------------------------------------------------------

RADIUS_CARD = "16px"            # mirrors --radius-card
RADIUS_BUTTON = "10px"          # mirrors --radius-button

# ---------------------------------------------------------------------------
# Typography token
# ---------------------------------------------------------------------------

# NOTE: not parity-tested — globals.css uses var(--font-geist-sans) which
# resolves at runtime; we cannot assert equivalence of a CSS var reference
# against a literal fallback chain.
FONT = "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"  # annotated to --font-sans
