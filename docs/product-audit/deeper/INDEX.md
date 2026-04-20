# Deeper product audits (second wave)

These **`pd2-NN-*.md`** tracks go **below** `docs/product-audit/deep/pd-*`: same mandatory lens (`docs/PRODUCT.md`, `docs/ROADMAP.md`) but **narrower themes**, more **failure-tree** depth, and **cross-links** to `pd-*` and `docs/extended-audit/ax-*` where relevant.

**Depth bar (each file):**

1. **Executive truth table** — 5–10 rows: promise vs reality (*Met / Partial / Missing / Contradicted*) with evidence (`route`, `file`, or doc quote).
2. **ICP failure tree** — ordered branches: what breaks, what the user sees, recovery path (or “dead end”).
3. **Risk register** — P0 / P1 / P2 with owner-facing wording (not only engineering).
4. **PM questions** — explicit decisions; no fake consensus.

| # | File | Theme |
|---|------|--------|
| 01 | `pd2-01-trust-after-first-run.md` | After first successful run: data retention, “where did my run go?”, share links, deletion — trust vs surprise |
| 02 | `pd2-02-competitive-framing.md` | vs “API gateway”, vs “Zapier”, vs “Vercel one-click” — honest positioning from PRODUCT promises |
| 03 | `pd2-03-error-copy-icp-fit.md` | User-visible errors: jargon scan, “what do I do next?” for non-dev ICP |
| 04 | `pd2-04-empty-states-all-surfaces.md` | Hub empty, /me empty, studio empty, MCP list empty — parity and next action |
| 05 | `pd2-05-multi-action-manifest-ux.md` | `primary_action`, tabs, wrong default action — creator + consumer confusion |
| 06 | `pd2-06-private-and-auth-required-apps.md` | `visibility`, cookies vs bearer, MCP/HTTP parity — “who can run this?” |
| 07 | `pd2-07-ingest-failure-recovery.md` | Detect/ingest/slug collision: emotional arc + concrete recovery (not HTTP codes only) |
| 08 | `pd2-08-preview-vs-production-story.md` | preview.floom.dev vs floom.dev: mental model for ICP who does not read infra |
| 09 | `pd2-09-integrations-composio-narrative.md` | “Connect a tool” when UI is stub — promise control and docs as product |
| 10 | `pd2-10-support-and-escalation.md` | When something breaks: feedback route, logs, “contact” — expectation vs reality |

**Status:** second wave authored 2026-04-21.
