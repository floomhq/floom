# v24 Wireframe Gemini Audit (v23 vs v24 + ICP context)

Date: 2026-04-27
Auditor: Gemini-free (gemini-2.5-flash)
Scope: 52 v24 wireframes across 6 rounds, compared against their v23 counterparts
Method: each pair sent to Gemini with full Floom/ICP context (see below) + 5-criterion rubric (content parity, delta application, ICP fit, suggestions, blocking issues).

This is a SECOND-OPINION audit complementing codex's structural audits. Use Gemini's suggestions for design polish, ICP-language nits, and content regression catches.

## Floom — what it is
Floom is a hosting platform for AI apps. Tagline: "Ship AI apps fast." / "The protocol + runtime for agentic work."
Three surfaces every app exposes: web form, MCP, HTTP. Same app, three ways to call it.

## ICP — who uses Floom
Non-developer AI engineer. Built a localhost prototype (often vibecoded with Claude/Cursor). Has zero infra fluency. Wants production hosting in <5 minutes. Will hate dev jargon, JSON-first UI, terminal-only flows. Wants:
- Friendly results (key-value cards, not raw JSON dumps)
- Plain-English status (not stack traces)
- Authentication that "just works" (Agent tokens, not OAuth dance)
- Workspace-level credentials (BYOK keys) not per-machine config

## Two equal user roles
- Creators: publish their app via OpenAPI URL, GitHub repo, or Docker image. Get /p/:slug public page + MCP + HTTP.
- Consumers: install apps from store, run them, manage runs.

## v24 IA changes vs v23 (intentional)
- Workspace tier sits ABOVE Run + Studio + Workspace settings (siblings, not nested)
- URL family rework: /me/* → /run/* (consumer mode), /settings/* (workspace credentials), /account/settings (user-scoped), /studio/* (creator mode)
- Locked vocabulary: BYOK keys (was "secrets" or "API keys"), Agent tokens (was "tokens"), App creator secrets (was "Secrets" tab in Studio)
- Banned phrases that were in v23: "My account", "your account", "your runs", "tok_••", "flo_agt_"
- Single emerald accent only (no category tints, no rainbow)
- Warm-dark `var(--code) #1b1a17` ONLY for actual code blocks (Copy for Claude, MCP config, raw JSON toggles)
- Light cream `var(--bg)` for app banners and result cards (NOT warm-dark — non-dev ICP)
- Mono icons replace v23 colored gradient icons (scalable, no per-app color management)
- /me/* paths redirect to canonical
- Multi-workspace v1.1: one Agent token per workspace, one MCP entry per workspace (`floom-{workspaceName}`)

## Tuesday 2026-04-28 launch is fixed


---

## Round 1 — Shared shells

### run-workspace-shell.html
_v23 source: me.html_

[gemini error: HTTP 429]

---

### workspace-settings-shell.html
_v23 source: me-secrets.html_

[gemini error: HTTP 429]

---

### studio-workspace-shell.html
_v23 source: studio-home.html_

[gemini error: HTTP 429]

---


## Round 2 — Workspace settings

### settings-byok-keys.html
_v23 source: me-secrets.html_

[gemini error: HTTP 429]

---

### settings-byok-keys-empty.html
_v23 source: me-secrets.html_

[gemini error: HTTP 429]

---

### settings-agent-tokens.html
_v23 source: me-agent-keys.html_

[gemini error: HTTP 429]

---

### settings-agent-tokens-empty.html
_v23 source: me-agent-keys.html_

[gemini error: HTTP 429]

---

### account-settings.html
_v23 source: me-settings.html_

[gemini error: HTTP 429]

---


## Round 3 — Run mode

### run.html
_v23 source: me.html_

[gemini error: HTTP 429]

---

### run-apps.html
_v23 source: me-apps.html_

[gemini error: HTTP 429]

---

### run-runs.html
_v23 source: me-runs.html_

[gemini error: HTTP 429]

---

### run-runs-detail.html
_v23 source: me-runs-detail.html_

[gemini error: HTTP 503]

---

### run-empty-state.html
_v23 source: me-empty-state.html_

[gemini error: HTTP 503]

---

### run-app-run.html
_v23 source: me-app-run.html_

[gemini error: HTTP 503]

---

### run-app-triggers.html
_v23 source: me-app-triggers.html_

[gemini error: HTTP 503]

---

### run-app-trigger-schedule.html
_v23 source: me-app-trigger-schedule.html_

CONTENT PARITY: 3/10 — v24 significantly thins out the content from v23, removing the friendly cron builder, run history, and explicit danger zone/management options.
DELTA APPLICATION: 9/10 — The intentional v24 deltas (URLs, vocabulary, single emerald accent, warm-dark code blocks for code, light cream banners, mono icons, multi-workspace hints) are applied consistently where elements exist.
ICP FIT: 2/10 — The page directly contradicts the ICP's needs by removing the friendly cron builder, forcing raw cron input (jargon), and eliminating critical plain-English feedback like run history and basic schedule management actions.

TOP 3 SUGGESTIONS:
1.  **Reinstate the friendly cron builder from v23:** The "Friendly / Raw cron" toggle with a visual builder (time input, day toggles) is essential for a non-developer ICP who "will hate dev jargon." Presets are helpful but insufficient for custom schedules.
2.  **Add a "Run History" panel:** A non-developer needs clear, plain-English status (not stack traces) on whether their scheduled app is running successfully or failing, which v23 provided. This is crucial for monitoring and debugging.
3.  **Include "Pause/Delete schedule" actions:** Basic management actions are missing. A "Danger zone" panel, similar to v23, or clearly visible buttons are needed to manage a live schedule.

BLOCKING ISSUES:
*   **Lack of friendly cron builder:** Directly violates the ICP's core need for ease of use and hatred of dev jargon, making the primary function (scheduling) difficult for the target user.
*   **Lack of Run History:** Prevents the user from receiving plain-English status and feedback on their scheduled runs, making monitoring and basic troubleshooting impossible from this page.
*   **Missing Pause/Delete functionality:** A significant functional gap; users cannot manage (pause or destroy) their schedules once created.

OVERALL: 2/10 — While stylistically compliant, v24 critically regresses on core functionality and user-friendliness for its non-developer AI engineer ICP, rendering the page incomplete and frustrating for managing scheduled AI apps.

---

### run-app-trigger-webhook.html
_v23 source: me-app-trigger-webhook.html_

[gemini error: HTTP 503]

---

### run-install.html
_v23 source: me-install.html_

[gemini error: HTTP 503]

---


## Round 4 — Studio mode

### studio-home.html
_v23 source: studio-home.html_

[gemini error: HTTP 429]

---

### studio-empty.html
_v23 source: studio-empty.html_

[gemini error: HTTP 429]

---

### studio-apps.html
_v23 source: studio-apps.html_

[gemini error: HTTP 503]

---

### studio-runs.html
_v23 source: studio-runs.html_

[gemini error: HTTP 429]

---

### studio-build.html
_v23 source: studio-build.html_

[gemini error: HTTP 429]

---

### settings-studio.html
_v23 source: studio-settings.html_

[gemini error: HTTP 429]

---

### studio-app-overview.html
_v23 source: studio-app-overview.html_

[gemini error: HTTP 429]

---

### studio-app-runs.html
_v23 source: studio-app-runs.html_

[gemini error: HTTP 429]

---

### studio-app-secrets.html
_v23 source: studio-app-secrets.html_

[gemini error: HTTP 429]

---

### studio-app-access.html
_v23 source: studio-app-access.html_

[gemini error: HTTP 429]

---

### studio-app-analytics.html
_v23 source: studio-app-analytics.html_

[gemini error: HTTP 429]

---

### studio-app-source.html
_v23 source: studio-app-source.html_

[gemini error: HTTP 429]

---

### studio-app-feedback.html
_v23 source: studio-app-feedback.html_

[gemini error: HTTP 429]

---

### studio-app-triggers.html
_v23 source: studio-app-triggers.html_

[gemini error: HTTP 429]

---


## Round 5 — Public + auth

### landing.html
_v23 source: landing.html_

[gemini error: HTTP 429]

---

### apps.html
_v23 source: apps.html_

[gemini error: HTTP 429]

---

### app-page.html
_v23 source: app-page.html_

[gemini error: HTTP 429]

---

### app-page-running.html
_v23 source: app-page-running.html_

[gemini error: HTTP 429]

---

### app-page-output.html
_v23 source: app-page-output.html_

[gemini error: HTTP 429]

---

### app-page-rate-limited.html
_v23 source: app-page-rate-limited.html_

[gemini error: HTTP 429]

---

### app-page-error.html
_v23 source: app-page-error.html_

[gemini error: HTTP 429]

---

### app-page-install.html
_v23 source: app-page-install.html_

[gemini error: HTTP 429]

---

### app-page-source.html
_v23 source: app-page-source.html_

[gemini error: HTTP 429]

---

### app-page-about.html
_v23 source: app-page-about.html_

[gemini error: HTTP 429]

---

### login.html
_v23 source: login.html_

[gemini error: HTTP 429]

---

### signup.html
_v23 source: signup.html_

[gemini error: HTTP 429]

---

### install-in-claude.html
_v23 source: install-in-claude.html_

[gemini error: HTTP 429]

---

### install.html
_v23 source: install.html_

[gemini error: HTTP 429]

---

### install-app.html
_v23 source: install-app.html_

[gemini error: HTTP 429]

---

### ia.html
_v23 source: ia.html_

[gemini error: HTTP 429]

---

### architecture.html
_v23 source: architecture.html_

[gemini error: HTTP 429]

---


## Round 6 — Mobile + design system

### mobile-menu.html
_v23 source: mobile-menu.html_

[gemini error: HTTP 429]

---

### design-system.html
_v23 source: design-system.html_

[gemini error: HTTP 429]

---

