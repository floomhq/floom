# Floom Cloud Flip Audit — 2026-04-24

## Section 1 — Every `deployEnabled` branch

| Site / branch | Status | Evidence |
| --- | --- | --- |
| Server source of truth | OK | `apps/server/src/services/workspaces.ts:718-745,808-836` exposes `deploy_enabled`; real default is enabled unless `FLOOM_WAITLIST_MODE` or `DEPLOY_ENABLED=false`. Stale comment still says default-false. |
| Client flag resolver | OK | `apps/web/src/lib/flags.ts:7-58,68-120` mirrors server and prefers cached `/api/session/me`. |
| Route guards | OK | `apps/web/src/components/WaitlistGuard.tsx:41-55`, `apps/web/src/main.tsx:245-280` gate `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/me*`, `/studio*`. |
| Top bar | OK | `apps/web/src/components/TopBar.tsx:148-158,399-430` swaps between Publish/Sign in and waitlist CTA correctly. |
| Login page | Half-baked | `apps/web/src/pages/LoginPage.tsx:251-425` enabled branch exists, but usefulness depends on OAuth envs and email delivery actually being wired. |
| Build page | Broken | `apps/web/src/pages/BuildPage.tsx:170-346,389-402` detect/publish UI exists, but sample run is broken for new apps and publish copy overstates “live”. |
| Studio home | Half-baked | `apps/web/src/pages/StudioHomePage.tsx:65-67,224-236,293,990-998` enabled CTA works, but newly published apps still sit in `pending_review`. |
| About / Docs / Pricing / footer / landing cards / 404 | OK | `AboutPage.tsx:145-327`, `DocsLandingPage.tsx:362-503`, `PricingPage.tsx:342-526`, `DocsPublishWaitlistBanner.tsx:20-32`, `PublicFooter.tsx:65-145`, `DualAudiences.tsx:177-182`, `NotFoundPage.tsx:405-421` are copy/CTA swaps only. |

## Section 2 — Auth flow

- GitHub OAuth showing `auth_providers.github:false` on `/api/session/me` is not a GitHub-console callback bug. Code only returns `true` when `FLOOM_CLOUD_MODE=true` and both `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` are present: `apps/server/src/services/workspaces.ts:718-742`, `apps/server/src/lib/better-auth.ts:103-156`. If it is `false`, prod is missing env or not in cloud mode.
- If `github:false`, the button is absent entirely: `apps/web/src/pages/LoginPage.tsx:369-406`.
- If env exists but OAuth app is misconfigured, click flow is POST `/auth/sign-in/social` then top-level redirect: `apps/web/src/api/client.ts:768-801`. Errors land on `/auth/error`, which redirects to `/login?error=...` only if `FLOOM_APP_URL` is set; otherwise users get raw JSON 400: `apps/server/src/index.ts:346-362`.
- Google OAuth code path is identical and present: `better-auth.ts:145-156`, `LoginPage.tsx:396-405`, `api/client.ts:768-801`. I could not determine actual prod configuration from repo alone; requires Federico’s env/OAuth app state.
- Email/password exists and requires email verification: `apps/server/src/lib/better-auth.ts:207-247`. Forgot/reset UI exists: `apps/web/src/pages/ForgotPasswordPage.tsx:1-105`, `ResetPasswordPage.tsx:1-170`. Reset tokens expire in 1 hour: `better-auth.ts:219-242`. Without `RESEND_API_KEY`, reset/verification emails go to stdout, not inboxes: `apps/server/src/lib/email.ts:38-82`.
- Session persistence: 30-day sliding session (`expiresIn`, `updateAge`) with Secure/HttpOnly cookies: `apps/server/src/lib/better-auth.ts:287-317`. No separate refresh-token flow is implemented; Better Auth cookie session is the mechanism.

## Section 3 — Publish flow end-to-end

- Paste URL / repo: BuildPage dispatches GitHub refs to repo probing and everything else to direct detect: `apps/web/src/pages/BuildPage.tsx:170-239`. Cloud detect is auth-gated server-side: `apps/server/src/routes/hub.ts:142-195`.
- Detect / preview: server detect is read-only; it parses and returns a `DetectedApp` but does not persist anything: `apps/server/src/services/openapi-ingest.ts:1910-1947`.
- Run sample: broken for a brand-new spec. The client calls `/api/run` with the detected slug before ingest: `BuildPage.tsx:280-303`. The run API only executes slugs already present in `apps`; otherwise it returns `404 App not found`: `apps/server/src/routes/run.ts:201-205`.
- Publish: ingest persists a proxied app, derives `base_url` from `servers[]` / Swagger host / spec URL origin, and defaults new cloud apps to `private` unless visibility is explicitly chosen: `apps/server/src/services/openapi-ingest.ts:2339-2360`. New apps are inserted with `publish_status='pending_review'`: `openapi-ingest.ts:2388-2424`.
- UX mismatch: success copy says “Your app is live”: `apps/web/src/pages/BuildPage.tsx:1763-1766`. Public store/API excludes anything not `published`: `apps/server/src/routes/hub.ts:782-804,911-918`.
- Hardcoded assumptions: GitHub repo autodetect is GitHub-specific; outbound spec fetch is `http(s)` only, 10s timeout, 5 MB cap, with relative `servers[]` resolved against the spec URL: `apps/server/src/services/openapi-ingest.ts:569-603,862-1115`.
- I could not live-fetch `https://api.github.com/openapi.yaml` from this sandbox. This section is code-truth, not an external network run.

## Section 4 — Rate limiting

- Limits are 150/hour per anonymous IP, 300/hour per authed user, 500/hour per IP+app, and 10/day for MCP ingest: `apps/server/src/lib/rate-limit.ts:42-49`.
- Storage is a process-local in-memory `Map`, swept every 5 minutes and reset on restart: `rate-limit.ts:1-9,63-79`. Multi-replica fairness does not exist.
- A single IP sending 1000 POSTs/min will hit the IP bucket first, then keep generating `app:${ip}:${slug}` keys for every distinct slug: `rate-limit.ts:280-304`. Memory grows with key cardinality; there is no hard cap.
- Fairness is mixed: signed-in users get their own 300/hour bucket, but still share the 500/hour IP+app bucket with everyone behind the same NAT: `rate-limit.ts:280-299`.
- Abuse alerting exists only after 10 rate-limit hits in 5 minutes and only pings Discord: `rate-limit.ts:170-206`.

## Section 5 — Observability

- Sentry server-side is wired into boot, `onError`, `unhandledRejection`, and `uncaughtException`, but only when `SENTRY_DSN` is set: `apps/server/src/lib/sentry.ts:50-81`, `apps/server/src/index.ts:66-69,181-215`.
- Browser Sentry is consent-gated and build-env-gated (`VITE_SENTRY_DSN`): `apps/web/src/lib/sentry.ts:62-91`, `apps/web/src/main.tsx:96-104`, `apps/web/src/components/CookieBanner.tsx:156-165`.
- PostHog is also consent-gated and `VITE_POSTHOG_KEY`-gated: `apps/web/src/lib/posthog.ts:114-146`. Page views fire in `main.tsx:123-127,183-194`; run/publish/auth completion events fire in `apps/web/src/api/client.ts:244-248,363-365,952-957` and `apps/web/src/pages/LoginPage.tsx:122-130`.
- Logs are not structured JSON. There is `hono/logger()` plus extensive `console.log/warn/error`: `apps/server/src/index.ts:71-75`.
- Metrics exported when `METRICS_TOKEN` is set: `floom_apps_total`, `floom_runs_total`, `floom_active_users_last_24h`, `floom_mcp_tool_calls_total`, `floom_process_uptime_seconds`, `floom_rate_limit_hits_total`: `apps/server/src/routes/metrics.ts:28-99,102-120`.
- Actual prod DSN/keys could not be determined from repo; requires Federico’s env.

## Section 6 — Abuse / content moderation

- SSRF on detect is materially hardened: auth gate in cloud plus private-network / metadata / redirect / size / timeout blocking: `apps/server/src/routes/hub.ts:134-195`, `apps/server/src/services/openapi-ingest.ts:862-1115`.
- Detect/preview rendering does not trust raw HTML; markdown/html paths are sanitized elsewhere and BuildPage uses plain React text: `apps/web/src/lib/sanitize.ts:1-76`, `apps/web/src/components/DescriptionMarkdown.tsx:57-135`.
- Reserved slug shadowing is low risk because public app surfaces are namespaced (`/p/:slug`, `/api/:slug/run`, `/mcp/app/:slug`), not top-level `/login` or `/docs`: `apps/server/src/index.ts:274-286,914-928`. I did not find an app-slug reserved-word blacklist; only duplicate slugs are blocked: `apps/server/src/services/openapi-ingest.ts:2328-2337`.
- `pending_review` has no reviewer UI. The only promotion path is bearer-auth admin API: `apps/server/src/routes/admin.ts:1-84`. `StudioHomePage` merely shows a badge saying Federico will review it: `apps/web/src/pages/StudioHomePage.tsx:990-998`. Who reviews in practice could not be determined; requires Federico’s input.

## Section 7 — Secrets isolation

- BYOK Gemini key is per-run only: header `X-User-Api-Key` becomes transient `perCallSecrets.GEMINI_API_KEY` and is not persisted: `apps/server/src/routes/run.ts:246-276`.
- User vault secrets are encrypted per workspace under a wrapped DEK backed by `FLOOM_MASTER_KEY`: `apps/server/src/services/user_secrets.ts:1-24,56-105,196-264`.
- Runtime isolation is only as strong as app trust. The proxied runner injects declared secrets into requests sent to the app’s `base_url`: `apps/server/src/services/runner.ts:242-360`, `apps/server/src/services/proxied-runner.ts:509-548`. A malicious app author can exfiltrate caller-provided secrets to their own upstream.
- Secrets are scrubbed before Sentry, and public shared runs redact logs/inputs: `apps/server/src/lib/sentry.ts:18-46,61-74`, `apps/server/src/routes/run.ts:155-178`. But run logs themselves capture app stdout/stderr, so apps that print secrets will leak them into Floom logs: `apps/web/src/assets/docs/security.md:25-32`.

## Section 8 — Load + reliability

- `lead-scorer` is a Dockerized demo app that requires `GEMINI_API_KEY`: `apps/server/src/services/launch-demos.ts:60-103`. Each run can fan out to 32 concurrent Gemini workers and up to 200 rows: `examples/lead-scorer/main.py:43-50`. At 100 concurrent runs, the bottleneck is first Gemini quota, then Docker host CPU/memory. There is no central run queue; dispatch is fire-and-forget: `apps/server/src/services/runner.ts:367,436-520,575-596`.
- Exact Gemini free-tier/day and current Floom project headroom are not in repo. Requires Federico’s Google billing/quota console.
- Temp upload directories are cleaned after each run: `apps/server/src/lib/file-inputs.ts:350-419`, `apps/server/src/services/docker.ts:358-365`. Run rows/logs are not automatically retained/pruned; docs explicitly say no sweeper exists: `apps/web/src/assets/docs/security.md:28-32`.

## Section 9 — Recommended P0/P1 fix list

- P0: Fix BuildPage sample-run-before-ingest (`BuildPage.tsx:280-303`, `run.ts:201-205`).
- P0: Fix publish UX/reality mismatch: new apps land `pending_review`, but UI says “live” (`openapi-ingest.ts:2388-2424`, `BuildPage.tsx:1763-1766`, `hub.ts:782-804`).
- P0: Replace invite stub with real persistence/email/accept/revoke (`reviews.ts:156-194`, `api/client.ts:304-309`).
- P0: Verify prod auth envs before flip: GitHub/Google buttons depend on env presence, not magic (`workspaces.ts:718-742`, `better-auth.ts:103-156`).
- P0: Verify `RESEND_API_KEY`; otherwise signup verification and password reset are effectively broken for real users (`email.ts:38-82`).
- P1: Move rate limits/BYOK counters out of process memory for multi-replica and cardinality safety (`rate-limit.ts:1-9`, `byok-gate.ts:1-18`).
- P1: Make secrets trust model explicit; today malicious app authors can receive caller secrets by design (`runner.ts:242-360`, `proxied-runner.ts:509-548`).
- P1: Add structured logs and confirm Sentry/PostHog/metrics envs in prod.
- P1: Add retention policy for runs/logs.
- P2: Clean up stale comments/docs around `DEPLOY_ENABLED` defaults.

## Section 10 — “Deploy the flip” runbook

1. On AX41, edit the prod compose/env backing `/opt/floom-mcp-preview/docker-compose.yml`. Set `DEPLOY_ENABLED=true` and ensure `FLOOM_WAITLIST_MODE` is unset or false. Repo scripts do not change env vars for you: `scripts/ops/README.md:58-88`, `scripts/ops/floom-deploy-prod.sh:24-35`.
2. Restart only prod: `cd /opt/floom-mcp-preview && docker compose up -d --no-deps floom-mcp-preview`.
3. Verify server health: `curl -sS http://127.0.0.1:3051/api/health`.
4. Verify session flags: `curl -sS https://floom.dev/api/session/me | jq '.deploy_enabled, .auth_providers'`.
5. Smoke test in browser: `/login` shows the intended providers; email reset sends real mail; `/studio/build` detects a spec; publish lands in Studio; `/p/:slug` run + share works.
6. Monitor immediately after flip via `docker logs floom-mcp-preview`, Sentry if DSN is set, PostHog if key is set, and `/api/metrics` if `METRICS_TOKEN` is set.
