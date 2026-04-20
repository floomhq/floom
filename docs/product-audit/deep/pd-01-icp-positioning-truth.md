# pd-01: ICP & positioning truth

**Audit type:** Deep product truth (promise vs shipped surface vs public narrative)  
**Sources of truth:** `docs/PRODUCT.md`, `docs/ROADMAP.md`  
**Primary surfaces reviewed:** `CreatorHeroPage.tsx` (`/`), `AboutPage.tsx` (`/about`), `ProtocolPage.tsx` (`/protocol`), `apps/web/index.html` (static meta, SPA fallback, `<noscript>`)  
**Cross-reference:** `docs/ux-audit/by-route/route-01-home.md`, `route-07-about.md`, `route-05-protocol.md`  
**Snapshot note:** Copy and behavior reflect the repo state at audit time; roadmap dates in `ROADMAP.md` are historical anchors, not “as of” guarantees.

---

## 1. Executive truth table

| Promise (from `PRODUCT.md` / global marketing) | Where it appears | Reality (product + UI) | Status |
|-----------------------------------------------|------------------|-------------------------|--------|
| **ICP:** Non-developer AI engineer with a `localhost` prototype who must not need Docker, reverse proxies, secrets managers, OAuth, or infra vocabulary to succeed | `PRODUCT.md` §ICP | Landing hero uses “protocol + runtime for agentic work,” OpenAPI-flavored placeholder (`github.com/you/api`), and `aria-label` leading with “OpenAPI.” About speaks to “vibecoders” and “biz users” in plain language—closer to ICP—but still assumes GitHub/OpenAPI literacy in the CTA band. | **Partial** |
| **Core value:** Paste **repo URL** → Floom **hosts** prototype in production (~30s), plus auth, rate limits, secrets, **three surfaces** | `PRODUCT.md` §Core value; `ROADMAP.md` P0 | `ROADMAP.md`: repo→hosted **library path exists**; **still to land:** `POST /api/deploy-github`, `/build` ramp, quota, hardened docker defaults. Hero flow resolves **GitHub raw OpenAPI candidates** then `detectApp`—not “clone repo and run container” as the first-screen story. | **Partial** (backend trajectory) **+** **Contradicted** on first-screen narrative vs “paste repo” default |
| **Deployment path priority:** (1) Repo→hosted **primary**, (2) Docker hosted, (3) OpenAPI proxied **advanced** | `PRODUCT.md` §Deployment paths | Hero, placeholder, and detect loop center **OpenAPI discovery** from a GitHub URL. Protocol page and bundled `protocol.md` lead with **OpenAPI spec** as the front door. Psychologically, OpenAPI is **first**, repo-as-runtime **second** in public copy. | **Contradicted** (positioning order vs doc priority) |
| **Three surfaces:** web form `/p/:slug`, MCP `/mcp/app/:slug`, HTTP `/api/:slug/run` | `PRODUCT.md` | Roadmap confirms shipped. Landing meta (`index.html`) and inline demo narrative emphasize Claude tool + page + URL; **three surfaces** not spelled as a triad above the fold on home. Protocol diagram adds **CLI** as an output—extra vs three-surface language (`route-05-protocol.md`). | **Met** (backend) / **Partial** (discoverability & naming consistency) |
| **End users never install tooling** (git/docker on **operator** host) | `PRODUCT.md` §Host requirements | Self-host sections show `docker run` one-liners (appropriate for operators). ICP-facing copy still shows terminal blocks on home + protocol—acceptable if labeled “for operators,” but blur between “you never touch docker” and “here is docker” needs care. | **Met** for cloud ICP **if** they never click self-host; **Partial** if they scan the whole homepage |
| Shipped layers: manifest, ingest, runner, surfaces, runs, auth | `ROADMAP.md` §Current state | Consistent with product architecture; UI stubs noted for workspace, Composio, parts of jobs/renderer. | **Met** (core) / **Partial** (UI for advanced features) |
| Legal, cookies, imprint | `ROADMAP.md` P0 launch blockers | Listed as **not done** at roadmap level. | **Missing** |
| **Not a chat UI** / headless inputs-outputs | `AboutPage.tsx` | Global `index.html` JSON-LD still mentions a **“chat interface”** alongside Claude tool / page / CLI (`route-07-about.md` M2). | **Contradicted** (structured data vs About positioning) |

**Legend:** **Met** = aligned end-to-end for the ICP on the paths reviewed. **Partial** = true under conditions, in progress, or unevenly surfaced. **Missing** = not yet present where the roadmap or promise implies it. **Contradicted** = two artifacts assert incompatible stories.

---

## 2. ICP journey — first 60 seconds on site (with failure branches)

**Assumed entry:** Organic or referral to `https://floom.dev/` (SPA loads; user sees `CreatorHeroPage`).

| Time | What the ICP sees | Intended mental model (`PRODUCT.md`) | Failure branches |
|------|---------------------|--------------------------------------|------------------|
| **0–10s** | “Works with” logo strip → H1 **Ship AI apps fast.** → Accent **Vibe-coding speed. Production-grade safety.** → Sub **The protocol + runtime for agentic work.** | “I have a localhost thing; Floom gets it live without me becoming infra.” | **Branch A — Jargon skim:** “Protocol,” “runtime,” “agentic” read as builder-for-builders, not “I don’t do DevOps.” **Branch B — Job-to-be-done mismatch:** Headline promises speed; sub-line promises architecture—user may not connect either to “paste my repo.” |
| **10–25s** | Input placeholder **`github.com/you/api`**, button **Publish your app**, secondary **Browse N live apps**, **Self-host in one command** | Primary job: paste **GitHub repo URL** for **hosting**. | **Branch C — OpenAPI-first inference:** `/api` in placeholder + mono font suggests an **API repo**, not necessarily “my Python side project.” **Branch D — Empty submit:** Empty field routes to `/studio/build` or signup—good—but does not teach **repo→hosted** vs OpenAPI in one line (`route-01-home.md` F1). |
| **25–45s** | If user pasted a GitHub URL: loop tries **raw OpenAPI paths** under `main`/`master`; on success, signed-in users see **operations** count and `/p/{slug}`—still **ingest-from-spec** semantics | Full **repo container build** story is the long-term P0 (`ROADMAP.md`) | **Branch E — Spec-less repo:** Detection fails → navigate to build with query string; user may think product is “broken” rather than “OpenAPI not found yet.” **Branch F — Signed out:** Redirect to signup/build; extra steps—acceptable, but **no** above-fold explanation that **true repo hosting** is coming vs **spec wrap** today. |
| **45–60s** | `ProofRow`, `InlineDemo`, featured stripes, then **Why** / **Layers** / **MCP snippet** | Reinforce outcomes and three-surface value | **Branch G — Hub API fail:** Silent fallback to static stripes; proof numbers may show placeholders (`route-01-home.md` F5). **Branch H — Self-host block:** Fake boot line **“14 apps ready”** is static—trust risk for literal readers (`route-01-home.md` F3). |

**Secondary entry — `/about` (first 60s):** Strong alignment with pain (“Get that thing off localhost fast”) and audience split (builders vs business users). Failure branches: **(i)** Primary Studio CTA is **below the fold** (`route-07-about.md` m3); **(ii)** “Why headless” eyebrow is insider vocabulary (`route-07-about.md` m1); **(iii)** three surfaces not enumerated (`route-07-about.md` m4); **(iv)** sharing `/about` can still show **homepage OG tags** on live HTML (`route-07-about.md` M1).

**Secondary entry — `/protocol` (first 60s):** Technical diagram (**OpenAPI spec + floom.yaml** → Floom → outputs). Failure branches: **(i)** Story order is **spec-centric**, underweighting repo→hosted as default (`route-05-protocol.md` P2); **(ii)** no prominent **Publish / Studio** bridge at top (`route-05-protocol.md` P3); **(iii)** self-host commands **conflict** between embedded doc and page one-liner (image, port) (`route-05-protocol.md` P1).

---

## 3. Jargon audit — terms the ICP should not need on the **first screen** (home hero)

First screen is defined as: everything visible in the initial hero section of `CreatorHeroPage` **before** scroll—plus the browser tab title and global meta that describe the same moment.

| Term / phrase | Appears in hero (or tab/meta tied to home) | Why it’s risky for stated ICP | Mitigation already in codebase |
|-----------------|--------------------------------------------|-------------------------------|--------------------------------|
| **Protocol** | Sub-headline; `index.html` description | Implies standards body / integration mindset vs “ship my thing” | Architecture diagram removed from landing (comment in `CreatorHeroPage.tsx`); term still in sub-line |
| **Runtime** | Sub-headline; meta description | DevOps / platform connotation | Same as above |
| **Agentic** | Sub-headline | Industry trend word; not outcome language | — |
| **OpenAPI** | Input `aria-label` | Gatekeeper term if user has code but no spec (`route-01-home.md` F6) | — |
| **`/p/{slug}`** | Inline publish card (`<code>`) | Path-shaped URL jargon before user has mental model | Accurate for power users; intimidating if early |
| **Operations** | “Found N operations” | API / OpenAPI framing | Matches ingest model |
| **GitHub** (implicit) | Placeholder, logos | Fine if ICP uses GitHub; not universal | — |
| **Claude** (in meta, not hero body) | `index.html` OG/description | Anchors to one stack; ICP may use other agents | Integration logos partially contextualize |

**Not first screen but same session (below fold / sections):** MCP, Docker commands, “Self-host in one command,” YAML—appropriate **if** the ICP self-selects into depth; problematic if they must read these to understand **default** value.

**About page first screen:** “Headless” in eyebrow (`route-07-about.md` m1). **Protocol page:** OpenAPI, MCP, YAML, proxied/hosted, ghcr—appropriate for spec readers, misaligned if mistaken for onboarding (`route-05-protocol.md` jargon section).

---

## 4. Risk register (P0 / P1 / P2)

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| R1 | **P0** | **Primary journey in code + copy is OpenAPI-ingest, while `PRODUCT.md` names repo→hosted as #1 and roadmap says pipeline is incomplete** | `CreatorHeroPage` detect loop; `ROADMAP.md` P0 bullets; `protocol.md` opening | Wrong users succeed (API wrappers); right users (prototype repos) bounce or misconfigure expectations; sales/support debt |
| R2 | **P0** | **Structured data (`JSON-LD`) and/or meta still say “chat interface” while product narrative rejects chat-as-UI** | `index.html` `application/ld+json`; `AboutPage` “Not a chat UI” (`route-07-about.md` M2) | Trust erosion for careful readers; SEO/social preview fights positioning |
| R3 | **P1** | **Static / no-JS / crawler paths use `/build` while SPA canonical creator flow is `/studio/build`** | `index.html` SPA fallback + `<noscript>` (`route-01-home.md` F2) | Broken or confusing publish path when JS fails; analytics splits |
| R4 | **P1** | **Protocol and self-host instructions disagree (image name, ports) within and across artifacts** | `protocol.md` Docker vs `ProtocolPage` footer one-liner (`route-05-protocol.md` P1) | Operator mistakes; “spec page is wrong” reputational hit |
| R5 | **P1** | **Social/meta for non-home routes may still advertise homepage story** | Live `/about` OG mismatch noted in `route-07-about.md` M1 | Bad shares; investor/founder links look sloppy |
| R6 | **P2** | **Quantified proof degrades silently** (hub fetch fail, static “14 apps” line) | `CreatorHeroPage` + `ProofRow` behavior (`route-01-home.md` F3, F5) | “Empty social proof” feeling during outages |
| R7 | **P2** | **“Three surfaces” vs diagram “CLI”** | `ProtocolPage` `FlowDiagram` (`route-05-protocol.md` P4) | Conceptual drift for integrators documenting Floom |
| R8 | **P2** | **ICP-only accessibility: hero `aria-label` leads with OpenAPI** | `CreatorHeroPage` (`route-01-home.md` F6) | Screen-reader users get engineer-first instructions |

---

## 5. Open PM questions (numbered)

1. **Single headline hierarchy:** Should the **above-fold hero** always state the **repo→hosted** outcome in plain language (even if OpenAPI remains the technical ingest), or is OpenAPI-first intentional until the deploy pipeline ships?
2. **Who owns “protocol” language?** Is “protocol + runtime for agentic work” a **brand pillar** for all visitors, or should it be **demoted** to `/protocol` and investor/docs channels per ICP tests?
3. **When repo has no OpenAPI:** What is the **expected user-visible story** between now and full `deployFromGithub`—wizard to add spec, codegen, or explicit “not supported yet” with waitlist?
4. **Chat vs headless:** Should **JSON-LD**, OG, and hero bullets remove “chat interface” entirely, or is a **chat** surface still part of the product for some apps—requiring nuanced wording instead of negation?
5. **CLI as surface:** Is CLI a **fourth surface**, a **dev convenience**, or should all public diagrams fold CLI under **HTTP/MCP** for messaging consistency with `PRODUCT.md`?
6. **Biz-user ICP:** About weights “biz users” equally; home is builder- and integration-forward. Is there a **separate landing** or **segmented hero** for “I only use shared links” visitors?
7. **Canonical publish URL:** Should `/build`, `/studio/build`, and static fallbacks be **one URL everywhere** (including email templates and GitHub README), and what is allowed to break for legacy links?
8. **Legal gate:** Given P0 roadmap items for imprint/privacy/terms/cookies, what is the **minimum** that must ship before positioning spend or paid acquisition?
9. **Success metric for this audit:** Should PM track **hero→publish conversion**, **spec-less repo drop-off**, or **time-to-first-`/p/:slug`** as the primary **ICP health** KPI—and which baseline exists today?

---

## Appendix A — `document.title` / meta patterns observed

| Surface | Title pattern | Notes |
|---------|---------------|--------|
| `apps/web/index.html` | `Ship AI apps fast · Floom` | Default shell before hydration; matches hero `useEffect` in `CreatorHeroPage`. |
| `CreatorHeroPage` | `document.title = 'Ship AI apps fast · Floom'` | Set in `useEffect`. |
| `AboutPage` via `PageShell` | `title` prop → `document.title` | `"About Floom · Get that thing off localhost fast"` — strong ICP alignment. |
| `ProtocolPage` | Mount: `'The Floom Protocol'`; unmount cleanup: `'Floom: production layer for AI apps'` | Cleanup title differs from `index.html` / home; ensures a title is set when leaving. |
| Global meta | `meta name="description"`, `og:*`, `twitter:*` in `index.html` | Concrete bullets (Claude tool, page, CLI, URL); overlaps with checklist desire for plain outcomes (`route-01-home.md` F4). |
| JSON-LD | `SoftwareApplication` in `index.html` | Includes “chat interface” and “DeveloperApplication” category—tension with non-dev ICP and About negations. |

---

## Appendix B — `index.html` SPA fallback & `<noscript>` (parity)

- **Locked copy** mirrors hero themes: “Ship AI apps fast,” “protocol + runtime for agentic work,” vibe-coding / production safety, paste link → Claude tool, page, command-line, **chat interface**, URL.
- **Links:** `Try an app` → `/apps`; **Publish** → `/build` (not `/studio/build`) — see risk R3.
- **Hidden SPA fallback** (`display:none`): crawlers may see structure; content does not match `/about` or `/protocol` when those URLs are fetched as static HTML—expected SPA limitation, noted in `route-05-protocol.md` for protocol SEO.

---

*End of pd-01 — ICP & positioning truth.*
