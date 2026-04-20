# Extended audits (security, quality, ops, engineering)

Each **`ax-NN-*.md`** is one background subagent. **Do not edit product code** — markdown deliverables only. Cross-link `docs/PRODUCT.md`, prior `docs/ux-audit/`, `docs/functionality-audit/`, `docs/product-audit/deep/` where useful.

| # | File | Scope |
|---|------|--------|
| 01 | `ax-01-authz-matrix.md` | AuthZ matrix: mutating routes × caller classes; gap list with `file:line` |
| 02 | `ax-02-ssrf-url-fetch.md` | Every user/hub-influenced URL → `fetch`; allowlist, redirects, DNS rebinding notes |
| 03 | `ax-03-renderer-security-deep.md` | Renderer/static delivery pen-test (`fn-17` depth++): path, CSP, MIME, cache |
| 04 | `ax-04-ci-workflows.md` | `.github/workflows/*`: triggers, secrets, path filters, missing gates |
| 05 | `ax-05-test-risk-map.md` | P0 journeys vs tests (`hub-smoke`, unit); coverage gaps |
| 06 | `ax-06-supply-chain.md` | `npm audit` (root + apps), lockfiles, licenses, Renovabot posture |
| 07 | `ax-07-microcopy-consistency.md` | Grep-driven: secret/credential/deploy/publish vocabulary across `apps/web` |
| 08 | `ax-08-seo-share.md` | Titles, meta, OG route, sitemap/robots, canonicals for `/`, `/apps`, `/p/:slug` |
| 09 | `ax-09-i18n-readiness.md` | Hardcoded strings, dates, RTL, `lang` attr |
| 10 | `ax-10-slo-observability.md` | Health vs metrics vs Sentry; what to page on; mini runbook outline |
| 11 | `ax-11-data-lifecycle.md` | SQLite paths, migrations, backup/corrupt DB story for self-host |
| 12 | `ax-12-package-boundaries.md` | `apps/server` ↔ `packages/*` imports; duplicate Docker policy surfaces |
| 13 | `ax-13-dead-legacy-routes.md` | `/_creator-legacy`, redirects in `main.tsx`; who links; deprecation candidates |
| 14 | `ax-14-regression-checklist.md` | Post-merge / pre-release checklist: hub-smoke, preview smoke, capture diff |

**Status:** subagents spawned 2026-04-20. Tracks **ax-01**, **ax-03**, and **ax-06** were completed in-repo after the partial merge (same day).
