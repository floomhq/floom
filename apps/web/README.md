# @floom/web

React SPA for Floom. Vite + React 18 + TypeScript.

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — TypeScript check + production build (`dist/`)
- `npm run typecheck` — Type-only check, no emit

## Environment flags

All env vars are inlined at build time by Vite (they only take effect on a
fresh `npm run build`, not at runtime).

- `VITE_SENTRY_WEB_DSN` — optional Sentry error tracking. No-op when unset.
- `VITE_POSTHOG_KEY` — optional PostHog analytics. No-op when unset. Set to
  enable the 8 tracked events (landing_viewed, publish_clicked,
  publish_succeeded, signup_completed, run_triggered, run_succeeded,
  run_failed, share_link_opened). See `src/lib/posthog.ts` for scope and
  `docker/.env.example` for full docs.
- `VITE_POSTHOG_HOST` — PostHog ingest host (default `https://eu.i.posthog.com`).

Both analytics integrations degrade to no-ops if init fails, so the app
keeps rendering even when the third-party script is blocked or offline.
