# Backend Test Coverage Audit

Date: 2026-04-26
Scope: `apps/server/src/routes/*.ts`, `apps/server/src/services/*.ts`, `apps/server/src/lib/*.ts`, `apps/server/src/middleware/*.ts`

This audit records the pre-gap-fill state of backend stress coverage. Coverage is classified from direct stress imports, Hono route exercise, full-server route exercise, and code inspection of `test/stress/*`.

## Summary

- Total backend files audited: 66
- Files with no direct stress coverage: 9
- Files with happy-path or indirect-only coverage: 21
- Files with broad happy/unhappy/edge coverage: 36
- Highest risk pattern: thin public routes and pure shared helpers with no direct assertions, even when their callers have partial integration coverage.

## Per-File Audit

| File | Surface | Existing stress coverage | Severity | Main gaps |
|---|---|---|---|---|
| `routes/admin.ts` | `POST /apps/:slug/publish-status` | Indirect admin MCP/security tests | P1 | Direct 404 cloaking, bad bearer, malformed JSON, invalid enum, cache invalidation |
| `routes/agent_keys.ts` | mint/list/revoke agent keys | `test-agent-tokens.mjs` | P2 | Near-boundary token expiry/revoke timing not explicit |
| `routes/connections.ts` | Composio initiate/finish/list/revoke | `test-w23-routes.mjs`, `test-w23-composio-service.mjs`, auth-boundary suites | P2 | Provider unicode/path traversal strings, concurrent finish/revoke |
| `routes/feedback.ts` | feedback create/admin list | `test-w4m-routes.mjs`, auth hint/write-rate suites | P1 | GitHub issue success/error branches, 20th/21st rate boundary, admin header variants |
| `routes/gh-stars.ts` | GitHub star proxy | None | P0 | Live/cache/fallback, upstream failure, in-flight de-dupe, token header |
| `routes/health.ts` | health JSON | Server boot smoke tests | P1 | Direct DB failure path and alert call verification |
| `routes/hub.ts` | detect/ingest/mine/detail/runs/list/delete/patch/renderer | SSRF, ingest, visibility, hub runs, renderer, rate-limit suites | P1 | Patch renderer payload extremes, concurrent visibility transitions, cache invalidation proof |
| `routes/jobs.ts` | enqueue/status/cancel jobs | `test-jobs-service.mjs`, `test-jobs-e2e.mjs` | P1 | Cancel race against worker claim, malformed ids, async app mismatch |
| `routes/mcp.ts` | MCP root/search/app tools | MCP admin/action/session/base-url/security suites | P1 | Method matrix, malformed JSON-RPC envelope variants, concurrent ingest rate cap |
| `routes/me_apps.ts` | creator policies/secrets/delete | `test-app-creator-secrets.mjs`, `test-me-apps-delete.mjs` | P1 | Bad manifest JSON, 65K/65K+1 secret boundary, delete cache invalidation |
| `routes/memory.ts` | app memory and user secrets | W2.1 memory/routes/user-secret suites | P2 | Unicode key/value extremes, undeclared key variants |
| `routes/metrics.ts` | Prometheus metrics | `test-metrics.mjs` | P2 | DB failure branch and cache TTL boundary |
| `routes/og.ts` | `/og/main.svg`, `/og/:slug.svg` | None direct | P0 | XML escaping, missing app fallback, author derivation, unicode/long text |
| `routes/parse.ts` | prompt to inputs | None direct | P0 | Required fields, missing app, bad manifest, bad action, parser fallback |
| `routes/pick.ts` | prompt to app picks | Indirect `pickApps` visibility test | P0 | Route validation, limit bounds, empty DB, fixture filtering |
| `routes/renderer.ts` | renderer meta/bundle/frame | renderer e2e/sandbox/cascade suites | P2 | Cache headers already covered; method 405 absent globally |
| `routes/reviews.ts` | list/create reviews, invite stub | `test-w4m-routes.mjs` | P1 | Invite stub validation, max title/body boundary, concurrent upsert |
| `routes/run.ts` | run/create/status/stream/share/quota/me runs | run auth/body/byok/zombie/security suites | P1 | Concurrent dispatch double-charge, stream cleanup while active |
| `routes/skill.ts` | `skill.md` endpoints | `test-skill-md-routes.mjs` | P2 | Large app catalog and XML-like markdown text |
| `routes/stripe.ts` | connect/pay/refund/subscription/webhook | W3.3 route/service/webhook suites | P2 | Numeric extremes beyond current amount cases |
| `routes/thread.ts` | create/get/append turns | Indirect cascade/rekey tests | P1 | Direct auto-create, corrupt payload parse, concurrent appends, long/unicode payload |
| `routes/triggers.ts` | create/list/update/delete triggers | trigger schedule/webhook/live suites | P2 | Concurrent update/delete race |
| `routes/waitlist.ts` | waitlist signup | waitlist/auth gate/write-rate suites | P2 | Email unicode normalization edge |
| `routes/webhook.ts` | inbound trigger webhook | webhook/trigger suites | P1 | Large body, malformed JSON with valid signature, inactive app variants |
| `routes/workspaces.ts` | workspace/session/member/invite APIs | W3.1 route/service/security suites | P2 | Invite expiry exact boundary and duplicate invite concurrency |
| `services/app_creator_secrets.ts` | creator secret policy/value load | `test-app-creator-secrets.mjs`, docker ingest | P2 | Decrypt failure during run load has coverage gaps |
| `services/app_delete.ts` | cascade app delete + hub cache bust | Indirect route deletes | P0 | Direct cascade and cache invalidation |
| `services/app_memory.ts` | app memory CRUD/load | W2.1 app-memory/auth-boundary suites | P2 | Very large JSON value and malformed stored JSON |
| `services/cleanup.ts` | orphan cleanup for deleted users | `test-user-delete-cascade.mjs` | P2 | Cleanup while active user writes |
| `services/composio.ts` | connection lifecycle/action exec | W2.3 service/routes/integration suites | P2 | SDK timeout branches and malformed metadata variants |
| `services/docker-image-ingest.ts` | Docker image publish ingest | `test-docker-image-ingest.mjs` | P2 | Registry auth config malformed JSON variants |
| `services/docker.ts` | image build/run/remove | file input docker, launch demos, proxied path suites | P1 | Disk full/write failure and Docker stream malformed JSON |
| `services/embeddings.ts` | embeddings upsert/backfill/pick | One direct `pickApps` visibility test | P0 | Keyword fallback ranking, empty prompt, fixture filtering, route limit bounds |
| `services/fast-apps-sidecar.ts` | sidecar boot/ingest/stop | `test-fast-apps.mjs`, launch tests | P1 | Missing script, unhealthy sidecar, disabled flag direct unit coverage |
| `services/jobs.ts` | job CRUD/state machine | `test-jobs-service.mjs`, `test-jobs-e2e.mjs` | P2 | Concurrent claim stress |
| `services/launch-demos.ts` | demo image build/seed | launch demo suites | P2 | Previous image fallback is covered; DB write failure branch remains |
| `services/manifest.ts` | manifest normalization/validation | manifest and file-input suites | P2 | Additional numeric/NaN schema variants |
| `services/openapi-ingest.ts` | OpenAPI fetch/parse/ingest/security | SSRF, ingest, GitHub URL, renderer, publish suites | P1 | 100K/1M spec body cap and concurrent slug collision |
| `services/parser.ts` | AI parser fallback/API call | Indirect via new parse route gap | P1 | OpenAI success/error JSON variants not direct |
| `services/proxied-runner.ts` | proxied HTTP runner/auth/file inputs | build-url, proxied timeout, mcp/action/file suites | P1 | OAuth cache expiry boundary, forbidden header injection variants |
| `services/renderer-bundler.ts` | renderer bundle/index/path safety | renderer bundler/e2e/sandbox suites | P2 | Disk write failure branch |
| `services/runner.ts` | run dispatch/update/get/sweeper | run auth, silent errors, zombie sweeper, jobs | P1 | Concurrent dispatch rate/charge and cleanup while stream active |
| `services/seed.ts` | seed apps from file | Indirect boot/seed suites | P1 | Corrupt seed file and invalid manifest direct errors |
| `services/session.ts` | device/user/workspace context | W2.1/W2.3/W3.1 auth/session suites | P2 | Malformed cookie edge variants |
| `services/stripe-connect.ts` | Stripe connect/pay/refund/sub/webhook | W3.3 service/routes/webhook suites | P2 | Time boundary at exact fee refund cutoff |
| `services/triggers-worker.ts` | scheduled/webhook trigger dispatch | trigger schedule/webhook suites | P2 | Tick while delete race |
| `services/triggers.ts` | trigger CRUD/signature/schedule | trigger schedule/webhook/live suites | P2 | Leap-second style timestamp input not meaningful in JS Date, DST cron boundary remains |
| `services/user_secrets.ts` | encrypted user secrets | W2.1/W3.1 auth-boundary suites | P2 | Tampered ciphertext variants beyond current decrypt failure |
| `services/webhook.ts` | outbound webhook delivery | `test-webhook.mjs`, jobs/triggers | P2 | Redirect handling and body size cap |
| `services/worker.ts` | background job worker | jobs/triggers/zombie suites | P1 | Worker start/stop idempotency direct assertions |
| `services/workspaces.ts` | workspace domain service | W3.1 service/routes/security suites | P2 | Concurrent invite/member role races |
| `lib/agent-tokens.ts` | token helpers/middleware | `test-agent-tokens.mjs` | P2 | Just-revoked token boundary via same millisecond |
| `lib/alerts.ts` | Discord/health alerting | `test-alerts.ts`, sentry tests | P2 | Discord non-JSON response body |
| `lib/auth-response-guard.ts` | auth scrub/timing pad | `test-auth-pentest-p0s.mjs` | P2 | Timing floor jitter tolerance already covered |
| `lib/auth-response.ts` | Better Auth response sanitizer | auth launch/pentest suites | P2 | Nested token arrays and non-JSON content variants |
| `lib/auth.ts` | global auth/admin/visibility | auth/security/visibility suites | P2 | Additional malformed authorization schemes |
| `lib/better-auth.ts` | Better Auth init/origin/migrations | W3.1 auth/security suites | P2 | Purge migration deleted-user variant |
| `lib/body.ts` | JSON parser/error envelope | Many route tests indirectly | P1 | Direct content-type and empty body matrix |
| `lib/byok-gate.ts` | BYOK quota/decision | BYOK suites | P2 | Subnet cooldown exact boundary |
| `lib/client-ip.ts` | trusted proxy IP extraction | Re-exported via `test-rate-limit.mjs` | P2 | Invalid CIDR warning is not asserted |
| `lib/email.ts` | Resend sender/templates | Indirect waitlist/auth/workspace tests | P1 | Direct template escaping and provider API error branches |
| `lib/feedback-github.ts` | GitHub issue filer | None direct | P0 | Token missing, bad repo env, API error, mention/code-fence neutralization |
| `lib/file-inputs.ts` | file envelopes/materialization | file-input suites | P2 | Disk full write failure branch |
| `lib/hub-cache.ts` | hub list cache | None direct | P0 | Key discrimination, TTL expiry, invalidation |
| `lib/hub-filter.ts` | fixture filtering | hub filter/selfhost suites | P2 | Unicode fixture description variants |
| `lib/ids.ts` | ID factories | Indirect many suites | P1 | Prefix/uniqueness direct stress |
| `lib/log-stream.ts` | SSE stream registry | run/hub auth suites | P1 | Finish with active readers and repeated finish direct test |
| `lib/metrics-counters.ts` | in-memory counters | `test-metrics.mjs` | P2 | Reset already covered |
| `lib/rate-limit.ts` | run/write/MCP limits | rate-limit/write-rate/security suites | P2 | Time window exact rollover edge |
| `lib/renderer-manifest.ts` | server renderer manifest parser | Renderer contract tests cover package version; server copy indirect | P1 | Server-local parser mirror direct coverage |
| `lib/scoped.ts` | tenant scoped SQL wrappers | W2.1 session/auth-boundary suites | P2 | Missing context already covered |
| `lib/sentry-init.ts` | Sentry boot side effect | None direct | P2 | Minimal side-effect module; low risk |
| `lib/sentry.ts` | Sentry scrub/init/capture | obs/sentry suites | P2 | Additional breadcrumbs scrub variants |
| `lib/server-version.ts` | package version export | None direct | P2 | Version equality with package metadata |
| `lib/signin-progressive-delay.ts` | signin throttling | progressive delay suite | P2 | Exact threshold boundary covered |
| `middleware/body-size.ts` | run body size limit | `test-run-body-size.mjs` | P2 | Disable flag covered |
| `middleware/security.ts` | security headers/noindex | security header/CORS suites | P2 | Existing header preservation covered |

## Top 20 Gap Closures

1. `routes/gh-stars.ts`: live/cache/fallback/in-flight de-dupe.
2. `routes/parse.ts`: missing fields, not found, corrupt manifest, invalid action, fallback success.
3. `routes/pick.ts` + `services/embeddings.ts`: validation, limit bounds, keyword fallback, fixture filtering.
4. `routes/og.ts`: XML escaping, missing app fallback, author derivation.
5. `routes/thread.ts`: create/get/append, auto-create, bad kind, concurrent appends, long/unicode payload.
6. `lib/feedback-github.ts`: configuration errors, API errors, safe issue body/title construction.
7. `lib/hub-cache.ts`: key discrimination, TTL expiry, invalidation.
8. `services/app_delete.ts`: app delete cascades runs and invalidates hub cache.
9. `routes/admin.ts`: no bearer cloaking, invalid bearer, invalid body, not found, success.
10. `routes/reviews.ts`: invite stub validation and missing app branch.
11. `routes/feedback.ts`: exact rate boundary and GitHub issue error propagation in response.
12. `lib/renderer-manifest.ts`: server-local mirror direct contract.
13. `lib/server-version.ts`: version export matches package metadata.
14. `lib/body.ts`: direct parser matrix for empty/malformed/content-type variants.
15. `lib/email.ts`: template escaping and send provider failures.
16. `services/fast-apps-sidecar.ts`: disabled/missing/unhealthy sidecar unit paths.
17. `services/seed.ts`: corrupt seed file and invalid app manifest.
18. `services/proxied-runner.ts`: OAuth cache expiry, forbidden header injection, malformed upstream response.
19. `services/runner.ts`: concurrent dispatch/rate/charge and active stream cleanup.
20. `routes/hub.ts`: renderer source size, concurrent publish visibility, cache bust after patch/delete.

## Phase 2 Batch Added From This Audit

- `test/stress/test-coverage-small-routes.mjs`
- `test/stress/test-coverage-small-libs.mjs`

Remaining P1/P2 items stay in this document as the ADR-020 coverage backlog.
