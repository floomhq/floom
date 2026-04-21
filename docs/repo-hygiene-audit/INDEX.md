# Repo-hygiene audit (2026-04-20)

Each **`rh-NN-*.md`** is a focused audit track on a single hygiene axis.
**Mandatory lens:** `docs/PRODUCT.md` (ICP, three surfaces, two ingest
modes, load-bearing paths) + `docs/ROADMAP.md` (P0/P1 vs shipped) +
`AGENTS.md` (do-not-delete load-bearing paths).

This pack was produced by running `rg` / `ls` / file reads over the **full
monorepo** on branch `docs/hygiene-and-docs-audit-2026-04-20` (based on
`origin/main` `d62a4cf`). Every claim below is backed by a concrete
`path:line` or a quoted doc line — no speculation, no invented paths.

**Depth bar (every `rh-*` file must include):**

1. **Executive truth table** — expectation (quote PRODUCT / ROADMAP / common
   sense) vs observed reality (code, UI, docs). Per row: *Met / Partial /
   Missing / Contradicted / Drift*. Every "evidence" cell is a
   `path/to/file:line` or quoted doc line.
2. **Concrete findings** — 5–15 specific observations, each with `path:line`
   evidence. No hand-waving, no "TBD".
3. **Risk register** — `ID`, `Sev (P0/P1/P2)`, `Risk`, `Evidence`. Severity
   reflects launch / ICP impact, not engineering purity.
4. **Open PM questions** — 3–6 decisions only a human owner can make
   (keep / kill / rename / document / rewrite).

**Ground rule:** a path on `docs/PRODUCT.md`'s load-bearing list is **never**
flagged for deletion. If it looks abandoned, it is annotated
*"load-bearing per PRODUCT.md — keep"* and the concern is moved to
*documentation / discoverability*.

| # | Output file | Theme |
|---|-------------|--------|
| 01 | `rh-01-unused-and-dead-surface.md` | Unused / dead routes, exports, components, feature flags, commented-out files |
| 02 | `rh-02-todo-fixme-clusters.md` | TODO / FIXME / XXX / HACK clusters — where they concentrate, what they block |
| 03 | `rh-03-config-env-drift.md` | Env vars: declared vs used, drift across `apps/server`, `apps/web`, `packages/*`, `docker-compose`, `.env.example`, docs |
| 04 | `rh-04-scripts-inventory.md` | Every script in `scripts/`, `apps/*/package.json`, `packages/*/package.json`, `.github/`, root — what still works, what's dead, what's undocumented |
| 05 | `rh-05-dependency-and-workspace-edges.md` | pnpm workspace graph, cross-package imports, circular deps, unused deps, version drift, forbidden edges |
| 06 | `rh-06-test-and-fixtures-hygiene.md` | Test layout: `apps/*/test/`, `test/stress/`, `packages/*/test/` — dead fixtures, skipped / `.only` tests, flaky history, coverage gaps vs product surfaces |

**Status (2026-04-20):** six tracks present on `main`; none of the tracks
felt thin once grounded in real `file:line` evidence. The two highest-signal
findings surfaced during the pass are summarized in the top of
`rh-05-dependency-and-workspace-edges.md` (Docker image does not bundle
load-bearing runtime packages) and `rh-03-config-env-drift.md` (several
production env vars read by the server but absent from `.env.example` and
`docker-compose.yml`).

## How to use this pack

- Treat each file as a **standalone brief** you could hand to one owner.
- Use the **truth tables** to negotiate scope with PM (what is drift vs
  contradiction vs missing) before touching code.
- Use the **risk register** column `Sev` as the first sort key when
  sequencing fixes against the P0 / P1 / P2 buckets already in
  `docs/ROADMAP.md`.
- Use the **Open PM questions** as blockers: do not mass-delete, rename, or
  schema-migrate until each question on a given track has a written answer
  from the product owner.
