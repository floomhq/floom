# V26 DRY Opportunities

Baseline scan: `apps/web/src/components/` and `apps/web/src/pages/`.

This file records repeated structures that v26 can collapse after the IA rebuild lands. No refactor is included in Track B.

## Workspace Rails

- `apps/web/src/components/RunRail.tsx` duplicates navigation primitives with `apps/web/src/components/StudioRail.tsx`: brand header, workspace identity block, section labels, rail items, footer account block, and primary CTA styling.
- `apps/web/src/components/StudioRail.tsx` already imports primitives from `RunRail.tsx`, but keeps app-list item styling locally. v26 rail collapse can turn the app-list row, empty/loading hint, and active route matcher into shared rail primitives.
- `apps/web/src/components/SettingsRail.tsx` is a wrapper over `RunRail.tsx`. v26 can delete this wrapper once settings live inside the tabbed settings page.
- `apps/web/src/components/me/MeRail.tsx` and `apps/web/src/components/studio/StudioSidebar.tsx` duplicate `SectionLabel`, `RailHint`, primary CTA, app/thread rows, and active-link styling. These are legacy sidebars next to the new rail work and can be collapsed or removed with the v26 IA cut.

## Workspace Page Chrome

- `apps/web/src/components/WorkspacePageShell.tsx` and `apps/web/src/components/me/MeLayout.tsx` both own workspace page framing. v26 can keep `WorkspacePageShell` as the single page frame and move remaining `MeLayout` tab/summary concerns into page-local content.
- `apps/web/src/pages/MeAppRunPage.tsx`, `apps/web/src/pages/MeAppTriggersPage.tsx`, `apps/web/src/pages/MeAppTriggerSchedulePage.tsx`, `apps/web/src/pages/MeAppTriggerWebhookPage.tsx`, `apps/web/src/pages/MeRunDetailPage.tsx`, `apps/web/src/pages/MeSecretsPage.tsx`, `apps/web/src/pages/MeSettingsPage.tsx`, `apps/web/src/pages/MeSettingsTokensPage.tsx`, and `apps/web/src/pages/StudioSettingsPage.tsx` repeat the `WorkspacePageShell` + `WorkspaceHeader` pattern. v26 tabbed settings can centralize the header/action contract.

## Settings Forms And Lists

- `apps/web/src/pages/MeSecretsPage.tsx` duplicates almost the full style vocabulary from `apps/web/src/pages/MeSettingsTokensPage.tsx`: card, section header, h2, muted text, form grid, input, primary/secondary/danger buttons, placeholder, empty state, list, row, mono strong text, and error panel.
- `apps/web/src/pages/MeSettingsPage.tsx` repeats the same card/form/input/button/error styling used by `MeSecretsPage.tsx` and `MeSettingsTokensPage.tsx`.
- v26 tabbed settings can expose shared `SettingsCard`, `SettingsFormRow`, `SettingsList`, `SettingsEmptyState`, and button variants.

## Studio Placeholder Cards

- `apps/web/src/pages/StudioEmptyPage.tsx`, `apps/web/src/pages/StudioTriggersTab.tsx`, and `apps/web/src/pages/StudioAppFeedbackPage.tsx` duplicate the same placeholder card structure: card shell, kicker, display h1, body copy, and primary link styling.
- `apps/web/src/pages/RunEmptyStatePage.tsx` uses the same empty-state card shape in Run mode. v26 can use a shared `WorkspaceEmptyState` with mode-specific copy and CTA.

## Studio Activity Rows

- `apps/web/src/pages/StudioHomePage.tsx` has local `ActivityFeed` and `ActivityRow` implementations that overlap with `apps/web/src/components/studio/StudioDashboardHome.tsx` activity rows and status pills.
- `apps/web/src/pages/StudioRunsPage.tsx` renders another studio activity list from the same `StudioActivityRun` data family.
- v26 drops the `/studio` overview page, so the shared target is the surviving studio runs/activity surface rather than the dashboard implementation.

## Run Status Pills

- `apps/web/src/pages/CreatorAppPage.tsx`, `apps/web/src/pages/MeRunsPage.tsx`, `apps/web/src/pages/MeRunDetailPage.tsx`, `apps/web/src/components/studio/StudioSidebar.tsx`, and `apps/web/src/components/studio/StudioDashboardHome.tsx` each define local status/live pill rendering.
- v26 can split this into a generic `RunStatusPill` and `PublishStatusPill`, then delete page-local pill copies as pages move to the new IA.

## Install And MCP Helpers

- `apps/web/src/pages/InstallInClaudePage.tsx` and `apps/web/src/pages/MeInstallPage.tsx` both generate MCP entry names, token placeholders, install snippets, code blocks, and copy-oriented install cards.
- `apps/web/src/components/CopyForClaudeButton.tsx` also carries route-aware Claude/Floom copy logic. v26 can consolidate slugification, token placeholder text, and snippet builders in a shared install helper.

## Trigger Pages

- `apps/web/src/pages/MeAppTriggersPage.tsx`, `apps/web/src/pages/MeAppTriggerSchedulePage.tsx`, `apps/web/src/pages/MeAppTriggerWebhookPage.tsx`, and `apps/web/src/pages/StudioTriggersTab.tsx` repeat trigger CTA/link styles and bridge copy between Studio and Run.
- v26 can put trigger navigation and shared button/link styles behind one trigger page module, keeping Studio as a route alias where needed.

## Authentication Form Controls

- `apps/web/src/pages/LoginPage.tsx`, `apps/web/src/pages/ForgotPasswordPage.tsx`, and `apps/web/src/pages/ResetPasswordPage.tsx` repeat label, input, and primary button styling.
- This is outside the main v26 IA cut, but it is parallel to the settings form cleanup and can share the same form-control primitives later.
