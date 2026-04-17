# Changelog

Meaningful user-facing changes, newest first. For the full commit log, see [floomhq/floom](https://github.com/floomhq/floom).

## 2026-04-17

- **Docs site.** `/docs` is now a real docs experience (this page). Eight sections, left nav, right-rail code samples on API reference, cmd-K search.
- **Rate limits on every run endpoint.** 20/hr anon IP, 200/hr authenticated user, 50/hr per (IP, app). MCP `ingest_app` separately capped at 10/day. 429 responses carry a `Retry-After` header and a structured `{error: "rate_limit_exceeded", retry_after_seconds, scope}` body. Overridable via `FLOOM_RATE_LIMIT_*` env vars.
- **Legal pages.** `/imprint`, `/privacy`, `/terms`, `/cookies` ship as §5-TMG-compliant stubs. German `/impressum` alias and `/legal/*` deep-link aliases both work.
- **MCP admin surface at `/mcp`.** Four new tools (`ingest_app`, `list_apps`, `search_apps`, `get_app`) let MCP clients create apps, browse the gallery, and fetch manifests without the web UI. Cloud mode gates `ingest_app` behind Better Auth.
- **Async job queue UI re-enabled.** Apps declaring `async: true` now render a progress indicator on `/me/runs` and return a job-started payload over MCP instead of blocking.
- **Custom renderer upload re-enabled.** Creators can ship a `renderer.tsx` alongside the OpenAPI spec. Floom compiles via esbuild, serves at `/renderer/:slug/bundle.js`, and falls back to the default renderer on crash.
- **Silent-error detection.** The runner now flips `status=error` when batch apps (openblog, blast-radius, dep-check) report zero successes or a populated `outputs.error`. No more green runs that actually failed.
- **Paste-first `/build`.** Anonymous visitors can paste an OpenAPI URL, see a detect preview, and get prompted to sign up only at publish time. localStorage rehydrates the work on return.
- **Output polish.** Copy buttons on markdown + JSON cards, markdown summaries rendered as the primary card, download HTML + copy HTML buttons, run-id mirrored into the URL as `?run=<id>` for shareable completed runs, and actionable hints on common run failures.
- **Launch-ready SEO.** Canonical tags, full OG set (dimensions, alt), Twitter cards, JSON-LD SoftwareApplication, `favicon.svg`, `og-image.png`, `robots.txt`, and `sitemap.xml` with 28 URLs. MIME types corrected on the static server.

## 2026-04-15

- **`/p/:slug` rebuilt to wireframe v11.** Hero, ratings strip (illustrative), three how-it-works cards, four connectors (Claude live; ChatGPT/Notion/Terminal coming-soon), schedule drawer, reviews.
- **`/build` rebuilt as a 5-ramp composer.** OpenAPI URL and GitHub ramps are live; Describe, Connect, and Docker ramps are coming-soon placeholders.
- **Landing + apps polish.** `CreatorHeroPage`, `AppsDirectoryPage`, `TopBar` active state, four new home components rebuilt to match v11.
- **Vanity URL redirects.** `/deploy`, `/docs`, `/self-host`, `/pricing`, `/store` all route to the closest live page so external deep links don't 404.

## 2026-04-14

- **Cloud-mode auth bypass closed** on write routes. Anonymous writes to workspaces, secrets, memory, and hub are now blocked when `FLOOM_CLOUD_MODE=true`.
- **12 undocumented env vars** added to `docker/.env.example`.
- **Positioning cleanup.** "Infra for agentic work" tagline killed in favor of the locked "Production infrastructure for AI apps that do real work."

## 2026-04-13

- **MVP UI strip (v0.4.0-mvp).** Six backend-complete features (workspace switcher, Composio connections, Stripe Connect, app memory, async UI, custom renderer upload) deferred behind `feature/ui-*` branches to keep `main` tight for launch. Every re-enable is a branch merge. See [`docs/DEFERRED-UI.md`](https://github.com/floomhq/floom-monorepo/blob/main/docs/DEFERRED-UI.md) for the full checklist.
- **Better Auth migrations on boot** in Cloud mode. `/auth/update-user`, `/auth/change-password`, `/auth/delete-user` wired to `/me/settings`.

See [GitHub releases](https://github.com/floomhq/floom/releases) for version-pinned release notes.
