# Per-route UX audits (spawned agents)

Each file is produced by a dedicated subagent: **code-first** audit (read TSX + shared components) plus optional `curl https://floom.dev…` for **public** routes only. ICP: `docs/PRODUCT.md`. Checklist: `~/.claude/skills/ui-audit/references/ux-review-checklist.md`.

| # | Output file | Route(s) | Component |
|---|----------------|----------|-----------|
| 01 | `route-01-home.md` | `/` | CreatorHeroPage |
| 02 | `route-02-apps.md` | `/apps` | AppsDirectoryPage |
| 03 | `route-03-permalink.md` | `/p/:slug` | AppPermalinkPage |
| 04 | `route-04-public-run.md` | `/r/:runId` | PublicRunPermalinkPage |
| 05 | `route-05-protocol.md` | `/protocol` | ProtocolPage |
| 06 | `route-06-install.md` | `/install` | InstallPage |
| 07 | `route-07-about.md` | `/about` | AboutPage |
| 08 | `route-08-auth.md` | `/login`, `/signup` | LoginPage |
| 09 | `route-09-me.md` | `/me` | MePage |
| 10 | `route-10-me-install-settings.md` | `/me/install`, `/me/settings` | MeInstallPage, MeSettingsPage |
| 11 | `route-11-me-run-detail.md` | `/me/runs/:runId` | MeRunDetailPage |
| 12 | `route-12-me-app-run.md` | `/me/apps/:slug/run` | MeAppRunPage (+ redirects context) |
| 13 | `route-13-studio-home.md` | `/studio` | StudioHomePage |
| 14 | `route-14-studio-build.md` | `/studio/build` | StudioBuildPage → BuildPage |
| 15 | `route-15-studio-settings.md` | `/studio/settings` | StudioSettingsPage |
| 16 | `route-16-studio-app-overview.md` | `/studio/:slug` | StudioAppPage |
| 17 | `route-17-studio-app-runs.md` | `/studio/:slug/runs` | StudioAppRunsPage |
| 18 | `route-18-studio-app-secrets.md` | `/studio/:slug/secrets` | StudioAppSecretsPage |
| 19 | `route-19-studio-app-access.md` | `/studio/:slug/access` | StudioAppAccessPage |
| 20 | `route-20-studio-app-renderer.md` | `/studio/:slug/renderer` | StudioAppRendererPage |
| 21 | `route-21-studio-app-analytics.md` | `/studio/:slug/analytics` | StudioAppAnalyticsPage |
| 22 | `route-22-studio-app-triggers.md` | `/studio/:slug/triggers` | StudioTriggersTab |
| 23 | `route-23-legal.md` | `/legal`, `/imprint`, `/privacy`, `/terms`, `/cookies` | Imprint, Privacy, Terms, Cookies |
| 24 | `route-24-not-found.md` | `*` | NotFoundPage |
| 25 | `route-25-redirects-legacy.md` | Navigate/ExternalRedirect, `/_creator-legacy*`, `/_build-legacy`, `/p/:slug/dashboard` | redirects + CookieBanner cross-cutting |

**Status:** 2026-04-20 — **25 route audit files present** under this folder (`route-01` … `route-25` + this INDEX). Code-first audits; optional public `curl` where agents used it.
