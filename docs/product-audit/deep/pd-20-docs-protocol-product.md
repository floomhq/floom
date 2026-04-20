# pd-20: Documentation & protocol as product

**Audit type:** Deep product truth — docs surface, `/protocol` shell vs copy depth, `/docs/*` routing, alignment with **three surfaces** and ICP self-serve bar.  
**Sources of truth:** `docs/PRODUCT.md`, `docs/ROADMAP.md` §P1 “Real docs content”  
**Primary artifacts reviewed:** `apps/web/src/pages/ProtocolPage.tsx`, `apps/web/src/assets/protocol.md`, `apps/web/src/main.tsx` (`/docs/*` routes), `apps/server/src/index.ts` (canonical HTTP/MCP wording in comments)  
**Cross-reference:** `docs/ux-audit/by-route/route-05-protocol.md`, `docs/product-audit/deep/pd-01-icp-positioning-truth.md`  
**Snapshot note:** Repo state at audit time (2026-04-20). Roadmap dates in `ROADMAP.md` are editorial anchors.

---

## 1. Executive truth table

| Promise (from `PRODUCT.md` / `ROADMAP.md`) | Where it appears in the docs product | Reality (observed) | Status |
|-------------------------------------------|--------------------------------------|---------------------|--------|
| **Three surfaces** for every app: web form `/p/:slug`, MCP `/mcp/app/:slug`, HTTP `POST /api/:slug/run` | `PRODUCT.md` §Core value, §Deployment paths | `protocol.md` §“What gets generated” lists **MCP**, **HTTP API**, **Web** — aligned in substance. §“API surface” documents **hub/pick/parse/run** style paths (`POST /api/run` with `app_slug` in body) alongside slug routes not shown as the primary paste-first contract. | **Partial** |
| **Repo → hosted** is deployment path **#1**; OpenAPI proxied is **#3 (advanced)** | `PRODUCT.md` §Deployment paths | `ProtocolPage` flow diagram leads with **“OpenAPI spec + floom.yaml”** as input; markdown opens with OpenAPI as the front door. Hosted/proxied YAML is explained, but **paste repo URL** is not the lead narrative. | **Contradicted** (positioning order vs product SSOT) |
| **Real docs content** (shell live; copy thin) | `ROADMAP.md` P1 | Single long-scroll **protocol** page + `protocol.md` (~100 lines prose + blocks). TOC from headings; comparison cards; example manifest links; no separate guides (billing, troubleshooting, MCP auth, jobs). | **Partial** (shell strong, breadth thin) |
| **ICP** should not need Docker / reverse proxies / infra vocabulary to **succeed on the default cloud path** | `PRODUCT.md` §ICP | Page is written as a **spec** (OpenAPI, MCP, SSE, YAML, `uvicorn`). Self-host Docker appears in markdown and again as a one-liner in TSX. Appropriate for operators; **misleading** if this is the first doc after marketing. | **Met** for integrator audience / **Partial** for ICP-as-only-docs |
| **`/docs/*` deep links** from wireframes/blogs land safely | Comment in `main.tsx` | Explicit maps: `/docs` → `/protocol`; `/docs/protocol`; `/docs/self-host` → `#self-hosting`; `/docs/api-reference` → `#api-surface`; `/docs/rate-limits` → `#plumbing-layers-auto-applied`; `/docs/changelog` → GitHub Releases; catch-all → `/protocol`. | **Met** |
| **Changelog** discoverable without maintaining duplicate copy | `/docs/changelog` redirect | Hard redirect to `https://github.com/floomhq/floom/releases` (note: org/repo name **floom** vs **floom-monorepo** elsewhere — operator must not confuse repos). | **Met** (single source) / **Partial** (brand/repo naming consistency) |
| **Protocol** explains **plumbing** (secrets, rate limits, streaming, history) | `protocol.md` §Plumbing | Listed; “Coming soon” line acknowledges gaps. Rate-limit detail not expanded on-page (deep link only to anchor). | **Partial** |
| **Diagram outputs match messaging** | Three-surface promise | `FlowDiagram` adds **CLI** as a fourth output alongside MCP / HTTP / Web — not in `PRODUCT.md` three-surface list. | **Contradicted** (diagram vs SSOT triad) |
| **Self-host instructions** are **one consistent truth** | Trust for “protocol” page | `protocol.md` uses `ghcr.io/floomhq/floom:latest`, port **3000**; `ProtocolPage` footer uses `ghcr.io/floomhq/floom-monorepo:latest`, port **3051** (`ProtocolPage.tsx` self-host block). | **Contradicted** (same page family, divergent commands) |

**Legend:** **Met** / **Partial** / **Missing** / **Contradicted** — same semantics as `pd-01`.

---

## 2. `ProtocolPage.tsx` — structure and length (audit)

| Layer | Approx. scale | Role |
|--------|----------------|------|
| **File** | **~716 lines** `ProtocolPage.tsx` | Page shell, markdown pipeline, diagrams, footer |
| **`protocol.md` (bundled)** | **~103 lines** | Canonical prose spec consumed by `ReactMarkdown` |
| **Above-the-markdown UI** | `FlowDiagram` (~100 lines component), `ProxiedVsHosted` (~100 lines), `Arrow`, `CopyCodeButton`, TOC helpers | Visual “how it works” + side-by-side YAML before the `h1` renders — strong for builders, weak for document outline order (see UX audit) |
| **Markdown pipeline** | `remarkGfm` + custom `markdownComponents` | CSP-safe rendering; heading `id`s slugified to match TOC anchors |
| **Below markdown** | GitHub CTA, `/apps` link, example `floom.yaml` links to `floomhq/floom` `examples/*`, Docker one-liner | Exit ramps skew **OSS / examples**, not **“host my repo”** Studio |

**Length verdict:** The **TypeScript** is long because of design system inline styles and reusable renderers, not because the **written spec** is encyclopedic. Roadmap’s “copy is thin” refers to **breadth** (missing how-tos, troubleshooting, per-surface auth), not line count of the React file.

---

## 3. `main.tsx` — `/docs/*` redirects (audit)

| Client route | Behavior |
|--------------|----------|
| `/docs` | `<Navigate to="/protocol" replace />` |
| `/docs/protocol` | → `/protocol` |
| `/docs/self-host` | → `/protocol#self-hosting` |
| `/docs/api-reference` | → `/protocol#api-surface` |
| `/docs/rate-limits` | → `/protocol#plumbing-layers-auto-applied` |
| `/docs/changelog` | `ExternalRedirect` → `https://github.com/floomhq/floom/releases` |
| `/docs/*` (any other subpath) | → `/protocol` (catch-all) |

**Assessment:** Redirect design is **product-aware** (no 404s for legacy URLs). **Risk:** anchor targets depend on **heading text** in `protocol.md` staying stable; rewording a heading breaks external `#` links without a build-time check.

**Server note:** `main.tsx` comments reference `/spec` → `/protocol` as **308** in `apps/server/src/index.ts` (not duplicated in the SPA). Crawlers hitting `/spec` may never load the client bundle — acceptable if server redirect is always configured.

---

## 4. Can the ICP self-serve **without sales**?

**Bar:** A non-developer AI engineer with a `localhost` prototype must understand **what to do next**, **what Floom will do**, and **how to get a first successful run** using only public artifacts (site + docs + repo).

| Criterion | Verdict | Why |
|-----------|---------|-----|
| Understand **default** value (repo hosted in ~30s) | **No** (from docs alone) | Protocol and diagram center **OpenAPI + manifest**, not **paste repo → build → surfaces**. `PRODUCT.md` priority is not reflected as the first-screen doc story. |
| Complete **first publish** without human help | **Uncertain** | Publishing lives in **Studio** (`/studio/build`); protocol page lacks a prominent bridge (noted in `route-05-protocol.md`). ICP may never discover the path from `/protocol`. |
| Operate **three surfaces** after publish | **Partial** | Markdown names MCP, HTTP, web; lacks **copy-paste curl**, **MCP URL**, and **permalink** in one “happy path” box per app. |
| Recover from **errors** (no OpenAPI in repo, auth, rate limits) | **No** | No troubleshooting matrix, no “what this HTTP status means,” no link from rate-limit anchor to operator env docs. |
| **Self-host** without Slack | **Risky** | Conflicting Docker lines undermine trust; `PRODUCT.md` host-in-container caveat is **not** on this page — operator can attempt an unsupported topology. |

**Conclusion:** For the **stated ICP**, documentation as shipped today is **not sufficient** for confident self-serve **if `/protocol` is treated as the docs hub**. It **is** usable for **integration-minded** readers who already speak OpenAPI and MCP. Sales or community hand-holding fills the gap today.

---

## 5. Gaps vs **three surfaces** explanation

| Surface | `PRODUCT.md` expectation | `protocol.md` + `ProtocolPage` coverage | Gap |
|---------|--------------------------|----------------------------------------|-----|
| **Web** `/p/:slug` | Named as production surface | “Web” described generically (form + renderer + streaming); **no** screenshot, URL pattern, or “share with biz user” story | **ICP social proof** and **permission model** absent |
| **MCP** `/mcp/app/:slug` | Per-app server | Paths and SSE/JSON-RPC noted; **no** “connect from Claude Desktop / Cursor” steps, auth token story, or admin `/mcp` vs app MCP distinction in one table | **Onboarding steps** missing |
| **HTTP** `POST /api/:slug/run` | Primary for scripts | Doc emphasizes **legacy-style** `POST /api/run` + hub/pick/parse in a block; slug-first line is clearer in **server** comments than in **user-facing** protocol section | **Canonical vs legacy** not taught as a decision tree |
| **Extras** | — | **Typed SDKs** / **openapi-generator** claimed; **CLI** in diagram | If SDK generation is not universally true in cloud tier, this is **expectation debt**; CLI vs triad **messaging drift** |

---

## 6. Recommended doc pillars (audit only — no implementation claim)

These are **content pillars** PM should consider so “docs” matches the three-surfaces + three-paths model without turning `/protocol` into a dumping ground.

1. **Start here (ICP)** — One short page or above-fold block: paste repo vs paste OpenAPI; “you never install Docker” vs “operator runs Docker”; link to Studio **publish** CTA.  
2. **Three surfaces playbook** — For a published app: permalink, MCP endpoint URL, `curl` for `POST /api/:slug/run`, when to use `/api/run` body style, streaming/jobs pointer.  
3. **Manifest reference** — `floom.yaml` keys, proxied vs hosted, secrets list, limits — can stay near current protocol content.  
4. **Operator / self-host** — Single source for image name, ports, env vars, rate limits, `FLOOM_*` flags; **host-in-container unsupported** callout from `PRODUCT.md`.  
5. **Trust & legal** — Imprint, privacy, terms, cookies (roadmap P0); linked from every surface doc footer.  
6. **Changelog & migration** — Keep GitHub Releases canonical; add **in-app** “what changed” only when breaking manifest or URL contracts.  
7. **Failure & limits** — Rate limits, quotas, common 4xx/5xx, “no OpenAPI in repo” path until repo-hosted is fully wired.

---

## 7. ICP journey — documentation-only path (with failure branches)

**Assumed entry:** User bookmarks `/docs` or follows “Docs” from marketing → lands on `/protocol`.

| Step | Intended mental model | Failure branches |
|------|----------------------|------------------|
| **0–15s** | “Floom turns my tool into production endpoints + a page.” | **A — OpenAPI-first inference:** Diagram shows OpenAPI as **input**; user with **no spec** assumes they are in the wrong place. **B — CLI surprise:** Sees four outputs; thinks Floom is a **CLI product**. |
| **15–45s** | “I know which mode (proxied vs hosted) applies.” | **C — Duplicated YAML:** Same blocks in cards and markdown — skim feels like repetition, not depth. **D — Hosted example** uses `uvicorn` — ICP may not map that to *their* stack. |
| **45–90s** | “I can call my app from an agent and from HTTP.” | **E — No copy-paste run:** API table is reference-shaped, not tutorial-shaped. **F — Path confusion:** `POST /api/run` vs `POST /api/:slug/run` not explained for the “I just want a URL” user. |
| **Post-read action** | Sign up / publish / try an app. | **G — Weak CTA:** Footer pushes GitHub + browse apps, not **Studio build**. **H — Self-host rabbit hole:** User copies **wrong** docker line depending on scroll position. |

**Secondary entry — `/docs/rate-limits`:** Lands on plumbing heading; no dedicated rate-limit operator doc on-page → user may still open Slack or Discord.

**Secondary entry — `/docs/changelog`:** Leaves the site for GitHub Releases — fine for maintainers; **ICP** may want **user-facing** release notes (pillar 6).

---

## 8. Risk register

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| D1 | **P0** | **Docs hub tells OpenAPI-first story while product SSOT says repo→hosted is #1** | `protocol.md` L5–7; `FlowDiagram` input; `PRODUCT.md` §Deployment paths | Wrong self-serve success; right ICP churns before Studio |
| D2 | **P0** | **Conflicting self-host commands** (image, port) on the same conceptual page | `protocol.md` L58–62 vs `ProtocolPage.tsx` ~706–708 | Operators fail bootstrapping; “docs are wrong” narrative |
| D3 | **P1** | **Three surfaces vs CLI in diagram** | `ProtocolPage.tsx` `FlowDiagram` outputs | Partners publish wrong integration diagrams |
| D4 | **P1** | **Anchor-based `/docs/*` links fragile** | Headings drive `slugify` IDs in `main.tsx` redirects | Silent partial page loads on rename |
| D5 | **P1** | **HTTP API table emphasizes hub/legacy paths** | `protocol.md` §API surface | Power users script the wrong endpoint for multi-app hosts |
| D6 | **P2** | **SPA / static HTML: protocol content not in initial HTML** | Per `route-05-protocol.md` | SEO and no-JS users see generic shell |
| D7 | **P2** | **“Typed SDKs” / generator claim** | `protocol.md` L42 | If not universally available, creates support tickets |

---

## 9. Open PM questions

1. **Is `/protocol` the canonical “docs home,” or should `/docs` become a hub index** with protocol as one chapter (ICP start here vs spec)?  
2. **Should the flow diagram drop CLI** or should `PRODUCT.md` acknowledge CLI as a documented fourth channel?  
3. **Which Docker image + port is canonical** for self-host docs — `floom` vs `floom-monorepo`, `3000` vs `3051` — and who owns updating **all** mirrors (README, protocol, ROADMAP)?  
4. **Should `protocol.md` §API surface lead with `POST /api/:slug/run`** and demote `POST /api/run` to “legacy / compatibility”?  
5. **What is the minimum doc set** that must exist before marketing spend or outbound sales is allowed to claim “self-serve”?  
6. **Repo naming in links:** Protocol footer points to `floomhq/floom-monorepo`; examples use `floomhq/floom` paths — is that intentional split, and how should docs explain it?  
7. **Jobs / async:** Roadmap treats async UI as important; should protocol mention **`POST /api/:slug/jobs`** next to sync run to avoid integrator surprise?  
8. **ICP reading order:** Should marketing send non-developers to **`/about` first** and reserve `/protocol` for integrators — and if so, is that explicit in nav labels?

---

*End of pd-20 — Documentation & protocol as product.*
