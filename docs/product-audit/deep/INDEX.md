# Deep product audit (super-deep tracks)

Each **`pd-NN-*.md`** is produced by one background subagent. **Mandatory lens:** `docs/PRODUCT.md` + `docs/ROADMAP.md` + cross-reference `docs/ux-audit/` and `docs/functionality-audit/` where relevant.

**Depth bar (every output must include):**

1. **Executive truth table** — promise (quote PRODUCT/ROADMAP) vs observed reality (code/UI/docs), per row: *Met / Partial / Missing / Contradicted*.
2. **ICP journey** — step-by-step for that theme with **failure branches** (what happens when hub down, auth expired, wrong spec, etc.).
3. **Risk register** — P0 / P1 / P2 for launch with *evidence paths* (`file:line` or route).
4. **Open PM questions** — decisions only a human owner can make.

| # | Output file | Theme |
|---|-------------|--------|
| 01 | `pd-01-icp-positioning-truth.md` | Hero, About, Protocol, SEO/meta vs ICP sentence; jargon vs outcome copy |
| 02 | `pd-02-path1-repo-hosted-reality.md` | `packages/{runtime,detect,manifest}`, `packages/runtime/README.md`, `docs/ROADMAP` P0 — `POST /api/deploy-github`, `/build` “host repo” tile **missing vs library shipped** |
| 03 | `pd-03-path2-docker-operator-story.md` | Docker runner + `apps.yaml` path vs “user never learns Docker”; operator vs end-user narrative |
| 04 | `pd-04-path3-openapi-as-default-risk.md` | Studio/OpenAPI ramps vs PRODUCT “advanced path”; does UI default the wrong mental model? |
| 05 | `pd-05-three-surface-parity.md` | `/p/:slug`, `/mcp/app/:slug`, `POST /api/:slug/run` — auth, errors, feature parity, MCP admin vs app tools |
| 06 | `pd-06-secrets-trust-contract.md` | End-to-end secrets story for ICP; creator vs viewer; manifest `secrets_needed` vs OpenAPI vs Studio empty state |
| 07 | `pd-07-workspaces-identity-tenancy.md` | Workspaces, session, Composio — ROADMAP “backend shipped UI stub” implications for trust |
| 08 | `pd-08-creator-lifecycle.md` | Studio home → build → app tabs → triggers/renderer/analytics — completeness vs roadmap |
| 09 | `pd-09-consumer-store-trust.md` | Hub, store, `qualityHubApps`, reviews, permalink — catalog credibility |
| 10 | `pd-10-async-jobs-differentiator.md` | Jobs + `JobProgress` + worker — product promise of long-running work |
| 11 | `pd-11-selfhost-cloud-split.md` | `FLOOM_CLOUD_MODE`, Better Auth, OSS `local` ids, PRODUCT host-in-container caveat |
| 12 | `pd-12-monetization-deferred.md` | Stripe, deploy waitlist, “Billing (soon)” — expectation management |
| 13 | `pd-13-legal-cookie-trust-bar.md` | Legal pages, cookie banner, imprint — ROADMAP P0 legal vs implementation |
| 14 | `pd-14-reliability-catastrophic.md` | Health, errors, worker crashes, `floom_internal_error` — user-visible catastrophe modes |
| 15 | `pd-15-abuse-isolation.md` | Rate limits, `FLOOM_AUTH_TOKEN`, multi-tenant isolation, public run surfaces |
| 16 | `pd-16-onboarding-activation.md` | `/me?welcome=1`, empty states, first successful run — activation metrics story |
| 17 | `pd-17-renderer-differentiator.md` | Custom renderer as P0 differentiator — product story + implementation risks (see `fn-17`) |
| 18 | `pd-18-mcp-agent-native.md` | MCP ingest/list/search + agent workflows vs “headless gateway only” competitors |
| 19 | `pd-19-roadmap-p0-execution-gap.md` | ROADMAP P0 checklist vs repo state (rate limits, legal, async UI, repo-hosted, wireframes) |
| 20 | `pd-20-docs-protocol-product.md` | `/protocol`, redirects from `/docs/*`, thin copy — documentation as part of product |

**Status:** subagents spawned 2026-04-20; refresh directory as `pd-*.md` files appear.
