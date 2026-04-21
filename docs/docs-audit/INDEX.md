# Docs audit pack (hygiene track 2026-04-20)

This pack audits the Floom docs surface for **doc/code drift, broken internal links, stale onboarding copy, and trust-surface inconsistencies**. It was produced by one read-only pass over the full monorepo at `/Users/federicodeponte/floomhq/floom` on branch `docs/hygiene-and-docs-audit-2026-04-20` (based on `origin/main` `d62a4cf`). Every claim below cites either a quoted doc line or a `path/to/file:line` reference. No source code, docs copy, routes, or product files were modified.

**Mandatory lens** (read these first, they were read first for this audit):

- [`docs/PRODUCT.md`](../PRODUCT.md) — ICP, three surfaces, two ingest modes, load-bearing paths.
- [`docs/ROADMAP.md`](../ROADMAP.md) — P0/P1 launch blockers, shipped vs deferred.
- [`docs/SELF_HOST.md`](../SELF_HOST.md) — operator-facing story (image tags, env vars, docker-compose).
- [`docs/README.md`](../README.md) + repo-root [`README.md`](../../README.md) — first-30-minutes narrative.
- [`docs/extended-audit/ax-01-authz-matrix.md`](../extended-audit/ax-01-authz-matrix.md) and [`docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md`](../product-audit/deep/pd-19-roadmap-p0-execution-gap.md) for tone + depth calibration.

## Depth bar (every `da-*` file below contains)

1. **Executive truth table** (5–12 rows): doc claim (quote + path) vs code/reality (`file:line` or quote), verdict ∈ {Met, Partial, Missing, Contradicted, Drift}. Every cell cites something.
2. **Concrete findings** — 5–20 specific drift/gap observations, each with `file:line` + quoted doc text where relevant.
3. **Risk register** — `ID`, `Sev (P0/P1/P2)`, `Risk`, `Evidence`. Severity reflects ICP trust impact, not doc-perfectionism.
4. **Open PM questions** — 3–6 decisions only a human owner can make.

## Tracks

| # | File | Theme |
|---|------|-------|
| 00 | [`INDEX.md`](./INDEX.md) | This pack overview + depth bar + status |
| 01 | [`da-01-doc-code-truth.md`](./da-01-doc-code-truth.md) | **Deepest.** Doc claims vs code reality across image tags / GHCR names, rate-limit defaults, `PUBLIC_URL` fallbacks, Stripe backend status, `/spec` route, dual `protocol.md`, `/install` lies |
| 02 | [`da-02-first-thirty-minutes.md`](./da-02-first-thirty-minutes.md) | New ICP-grade reader walks the root `README.md` end to end — what works, what dead-ends, what lies (image tag, `/install` localhost:8787 trap, missing `/api/publish`, self-host quickstart) |
| 03 | [`da-03-openapi-json-mcp-narrative.md`](./da-03-openapi-json-mcp-narrative.md) | How `/openapi.json`, `spec/protocol.md`, `/protocol` SPA route, MCP surfaces, and manifest docs line up across docs + code |
| 04 | [`da-04-link-and-redirect-hygiene.md`](./da-04-link-and-redirect-hygiene.md) | **Also deep.** Every internal link / redirect: broken, stale, circular, 404s, case-sensitive slugs, duplicate targets, orphan docs (`TRIGGERS.md`, `OAUTH_SETUP.md`, `OBSERVABILITY_SETUP.md`), links to un-mounted routes |
| 05 | [`da-05-legal-and-trust-copy-alignment.md`](./da-05-legal-and-trust-copy-alignment.md) | Legal pages (`/legal`, `/privacy`, `/terms`, `/cookies`), cookie banner, jurisdiction, contact addresses vs PRODUCT/ROADMAP and what code actually enforces (cookie names, `floom_device` undisclosed, Stripe ROADMAP vs shipped, run-log retention, EU-hosting claim) |

## Ground rules (repeat of the PR brief)

- Every claim cites a quoted doc line or a `path:line`.
- **No route, doc, or code path is flagged for deletion** if it's on the `docs/PRODUCT.md` load-bearing list — the phrasing is "load-bearing per `PRODUCT.md` — fix in place" when that applies.
- `da-01` and `da-04` are the deepest files in the pack.
- Tone matches [`pd-19-roadmap-p0-execution-gap.md`](../product-audit/deep/pd-19-roadmap-p0-execution-gap.md) and [`ax-01-authz-matrix.md`](../extended-audit/ax-01-authz-matrix.md) — direct, evidence-first, no marketing fluff.

**Status:** all 6 files present on `docs/hygiene-and-docs-audit-2026-04-20`, dated **2026-04-20**, produced against the full monorepo with real evidence (no synthetic snippets, no hallucinated paths).
