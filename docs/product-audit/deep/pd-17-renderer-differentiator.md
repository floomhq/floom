# pd-17: Renderer as differentiator (product lens)

**Audit type:** Deep product truth — custom renderer vs “gateway-only” positioning, trust, and shipped implementation bridge  
**Sources of truth:** `docs/PRODUCT.md` (load-bearing table row for renderer pipeline)  
**Primary code reviewed (skim):** `apps/server/src/services/renderer-bundler.ts`, `apps/web/src/components/CustomRendererPanel.tsx`, `apps/web/src/components/runner/CustomRendererHost.tsx`, `apps/web/src/pages/StudioAppRendererPage.tsx`, `apps/web/src/lib/renderer-contract.ts`, `apps/web/src/components/runner/RunSurface.tsx` (integration branch)  
**Cross-reference:** `docs/functionality-audit/by-area/fn-17-renderer.md` — **not present** (the `docs/functionality-audit/` tree does not exist in this workspace at audit time).  
**Snapshot note:** Security narrative and iframe sandbox model are explicitly documented in component headers (`sec/renderer-sandbox`, 2026-04-17) and `renderer-bundler.ts` comments.

---

## 1. Load-bearing product claim (`PRODUCT.md`)

| Path | Why it’s load-bearing |
|------|----------------------|
| `apps/server/src/services/renderer-bundler.ts` + `apps/web/src/components/CustomRendererPanel.tsx` + `CustomRendererHost.tsx` | **Custom renderer pipeline. P0 differentiator vs. “just an API gateway”.** |

This row ties **three layers** to one pillar: **server-side compile + persist**, **creator authoring UI**, **runtime presentation + isolation**. Removing or “simplifying” any leg without a replacement collapses the story from “Floom ships *my* product UI” to “Floom forwards *my* JSON.”

---

## 2. Product narrative — why the custom renderer wins vs gateway

**Gateway mental model (what Floom must not feel like for the ICP):** The user’s app is a black box HTTP handler. Floom authenticates, rate-limits, injects secrets, and surfaces **the same raw payload** everywhere. That is valuable plumbing, but it does not complete the job for a non-developer AI engineer who needs **something demoable and legible** to stakeholders: tables, downloads, markdown, charts, or a bespoke layout tied to *their* domain output.

**Renderer mental model (the differentiator):** After a successful run, Floom is still **Floom’s run surface**, but the **meaning** of the output is rendered under the creator’s control — within a contract — so the hosted app reads as a **product**, not a transcript of an API integration test. The three surfaces still share one execution truth; the **web form** gains a **presentation layer** that MCP/HTTP peers do not automatically get in the same way, which is acceptable if copy positions the renderer as “how it looks on `/p/:slug` / Studio run,” not “how agents see it.”

**What “winning” looks like in user language:**

- “My Floom page looks like *my* tool, not a JSON dump.”
- “I can ship a v1 UI without learning front-end hosting or another deploy target.”
- “When I share `/p/:slug`, people understand the output without reading field names.”

---

## 3. What breaks trust if the renderer story is wrong

| Failure mode | Why it erodes trust |
|--------------|---------------------|
| **Security surprise** | If creator-supplied code ever ran in the **end viewer’s** first-party context, a malicious (or compromised) creator could reach session-bearing primitives. The product would be reclassified as “dangerous multi-tenant SaaS,” not “safe hosting.” |
| **Silent downgrade** | If the UI **looks** like a custom renderer shipped but users actually see the default cascade (timeout, hash mismatch, non-success run), creators infer “Floom ignored my work” or “bugs,” not “defensive fallback.” |
| **Authoring vs docs mismatch** | If Studio copy says one artifact type (“HTML file”) but the panel compiles **React/TSX** with a specific contract, the ICP loses confidence that they are in the right mental model — classic “product lied on the label.” |
| **Compile opacity** | esbuild failures at upload are recoverable if errors are clear; vague failures read as “platform can’t run my kind of app.” |
| **Over-promising cross-surface parity** | If marketing implies the **same** bespoke UI appears identically on MCP tool results and HTTP without a defined contract, integrators discover a gap and downgrade Floom to “web-only sugar.” |
| **Size / perf shocks** | Large bundles or slow iframe `ready` paths that hit timeouts feel like flaky hosting even when the action succeeded. |

---

## 4. Implementation risk bridge (product claim → code reality)

| Product pillar | Supporting implementation (high level) | Bridge risk |
|----------------|------------------------------------------|-------------|
| **Not a gateway dump on the web surface** | `RunSurface` wraps successful runs in `CustomRendererHost` when `app.renderer` is present, else `OutputPanel` only. | If `app.renderer` metadata is missing after upload, or slug/hash bust fails cache, users stay on default output while believing a renderer exists. |
| **Creator can ship UI without separate hosting** | `CustomRendererPanel` uploads source + `output_shape`; server bundles via esbuild; artifacts under `DATA_DIR/renderers`. | Disk vs memory index drift (`bundleIndex` vs cold restart) could produce “sometimes no bundle” until re-ingest or route disk fallback — feels intermittent. |
| **Sandboxed execution** | Iframe `sandbox="allow-scripts"` (no `allow-same-origin`), `frame.html` CSP (`connect-src 'none'` per comments), `postMessage` contract in `renderer-contract.ts`, `ev.source === iframe.contentWindow` guard, safe link schemes for `link_click`. | Any future relaxation (e.g. `allow-same-origin`, broader `connect-src`) without a compensating model **directly** trades the trust row above. |
| **Broken renderer never blocks a run** | Host falls back to `children` (`OutputPanel`) on non-success runs, ready timeout, or parse failures; panel comments note compile failure keeps default panel on run. | Product-wise this is **correct resilience** but **bad UX** if the fallback is unexplained — users may blame Floom stability. |
| **Bounded blast radius** | `MAX_BUNDLE_BYTES` (512 KB), file upload cap in panel (512 KB). | Legitimate rich UIs may hit caps; ICP may interpret cap as “Floom can’t host real apps.” |

**Copy inconsistency (explicit):** `StudioAppRendererPage` introductory copy describes uploading an **“HTML file”** and “sandboxed iframe” in generic terms, while `CustomRendererPanel` describes a **React component**, `@floom/renderer` imports, and compile/sandbox language. Same feature surface; **conflicting instructions** — high trust risk for the exact audience that reads Studio carefully.

---

## 5. Executive truth table

| Promise / implied behavior | Where it lives | Reality (product + implementation) | Status |
|----------------------------|----------------|-----------------------------------|--------|
| Custom renderer is a **P0 differentiator** vs gateway | `PRODUCT.md` load-bearing table | Pipeline exists end-to-end: bundler + Studio/creator panel + iframe host + contract. Wired from `RunSurface` when `app.renderer` set. | **Met** (architecture) |
| Renderer output is **safe for logged-in viewers** | `CustomRendererHost.tsx` header (post–Apr 2026 sandbox model) | Iframe isolation + CSP + validated `postMessage` + link scheme re-check. Prior model explicitly called out session exfil risk — mitigated in current design intent. | **Met** (as designed) — **verify** continuously on any iframe/CSP/route change |
| **Broken renderer does not block runs** | `CustomRendererHost` + panel comments | Fallback to default `OutputPanel` on timeout / failure / non-success. | **Met** |
| **Studio teaches the correct artifact** | `StudioAppRendererPage` + `CustomRendererPanel` | Page copy says **HTML**; panel is **TSX/React** with starter template. | **Contradicted** (authoring copy vs actual contract) |
| **Functional audit trail for fn-17** | Expected `docs/functionality-audit/by-area/fn-17-renderer.md` | Path absent. | **Missing** |
| **End-user understands when fallback happened** | Product expectation | Code drops to default output without an on-surface “your renderer timed out” banner in the skimmed host. | **Partial** |

**Legend:** Same as `pd-01-icp-positioning-truth.md` (**Met** / **Partial** / **Missing** / **Contradicted**).

---

## 6. Risk register

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| R1 | **P0** | **Regression of sandbox** (iframe flags, CSP, bundle serving origin) re-introduces **cross-tenant or session theft** via creator code | Comments document prior insecure `lazy(import bundle)` model; current model depends on layered constraints | Catastrophic trust loss; potential incident class |
| R2 | **P1** | **Studio copy says HTML, implementation is React/TSX** — users mis-prepare assets and blame Floom | `StudioAppRendererPage.tsx` vs `CustomRendererPanel.tsx` | Support burden; abandoned feature; “docs wrong” reputation |
| R3 | **P1** | **Silent iframe fallback** (4s ready timeout) reads as flaky renderer or ignored upload | `READY_TIMEOUT_MS` in `CustomRendererHost.tsx` | Creators lose confidence; harder debugging |
| R4 | **P1** | **output_shape** mismatch vs actual run output shapes confuses contract / future tooling | `OUTPUT_SHAPES` in panel vs runtime outputs | Wrong expectations; harder auto-UI |
| R5 | **P2** | **512 KB cap** (bundled React included) blocks legitimate UI ambition | `MAX_BUNDLE_BYTES` / panel file cap | Power users bounce or fork output off-Floom |
| R6 | **P2** | **Three-surface parity** unclear: renderer is web-run-surface-centric | `RunSurface` integration | MCP/HTTP consumers feel “second class” if marketing over-unifies |
| R7 | **P2** | **No fn-17 functionality audit** | Missing `fn-17-renderer.md` | Harder regression triage; product/engineering disconnect |

---

## 7. PM questions

1. **Positioning:** Should public and Studio language say **“custom output view (React)”** explicitly, or do we want a **no-React** path for the ICP — and if so, what replaces TSX authoring?
2. **Fallback UX:** When the iframe does not become `ready` in time, do we owe the viewer a **non-blocking toast** (“Showing default output; renderer did not load”) so resilience does not look like negligence?
3. **Cross-surface:** What is the **canonical promise** for MCP and HTTP consumers regarding structured vs rendered output — one sentence we can repeat in docs and UI?
4. **Trust proof:** Do we surface **any** user-visible **“sandboxed”** or **“isolated preview”** badge on `/p/:slug` runs, or keep security as invisible hygiene only?
5. **Governance:** Who may upload a renderer for a shared org app — same as publish permissions, or stricter — and do we need audit logs for renderer changes?
6. **Sizing:** Is **512 KB** a hard product ceiling forever, or should we tier by plan / self-host config with clear upgrade messaging?
7. **Backlog hygiene:** Should **`fn-17-renderer.md`** be created under `docs/functionality-audit/by-area/` to lock acceptance criteria (upload, compile error, success run, timeout fallback, delete renderer, security smoke)?

---

## 8. Suggested next artifact (out of scope here)

Add `docs/functionality-audit/by-area/fn-17-renderer.md` when that audit tree exists, and link it back here as the engineering acceptance mirror for **pd-17**.
