# da-04 — Link and redirect hygiene

**Scope:** every internal link, intra-doc anchor, and SPA route redirect in the Floom monorepo. Audits for: **broken** (target does not exist), **stale** (target exists but content has moved), **circular** (redirect loops), **case-sensitive mismatch**, **duplicate targets** (two files claim to be the same doc), **links to unmounted routes**, and **orphan docs** (reachable from nowhere the ICP lands).
**Audit run:** 2026-04-20, against `origin/main` `d62a4cf`. Read-only pass; no link is fixed.

## Executive summary

The docs tree has **no hard 404s between markdown files** — every `./foo.md` link in a primary doc does resolve to a real file. That's the good news. The bad news is everything else:

- **One route-level 404.** `apps/web/src/pages/InstallPage.tsx:62–69` tells the reader to hit `POST /api/publish`. That endpoint is not mounted (da-02 F1, da-01 F4). Worst offender in the pack.
- **One mounted-but-lied-about port.** Same file, `:56`, says the server is on `localhost:8787`. Real default is `3051`.
- **Three orphan docs.** `docs/TRIGGERS.md`, `docs/OAUTH_SETUP.md`, `docs/OBSERVABILITY_SETUP.md` are reachable from one internal operator file (`docker/.env.example`) or from nowhere at all. None are on [`docs/PRODUCT.md`](../PRODUCT.md)'s load-bearing list.
- **Two duplicate targets.** `spec/protocol.md` (360 lines) and `apps/web/src/assets/protocol.md` (102 lines) both claim to be "the Floom protocol". Same URL (`/protocol`) on the web, same link label on GitHub (`Protocol`), different content. Load-bearing per `PRODUCT.md` — fix in place.
- **One runbook that writes to a package Floom does not own.** `docs/ROLLBACK.md` (9 lines reference `ghcr.io/floomhq/floom:*`; CI publishes to `ghcr.io/floomhq/floom-monorepo`). A release drill off this runbook will silently leave the old tag in place (da-01 F10).
- **At least eight intra-doc anchor links that hinge on the stale `/protocol` SPA render.** Four `Navigate` redirects in `apps/web/src/main.tsx:230–232` and four in-page links from `InstallPage` point at anchors that only exist in the 102-line stale version, not in `spec/protocol.md`. If the SPA ever switches to rendering the canonical spec (the fix recommended by da-03), all eight redirects 404-in-place.

No link is on fire right this second. Every link surface has a trust leak, usually because two docs drifted and the link target picked the wrong one.

---

## Executive truth table

| # | Link source (file:line) | Target | What actually happens | Verdict |
|---|-----|-----|------|---------|
| 1 | `apps/web/src/pages/InstallPage.tsx:62–69` | `POST /api/publish` | Route is **not mounted**. `apps/server/src/index.ts:155–222` lists every router; `/api/publish` is absent; grep for `/api/publish` matches only `InstallPage.tsx`. Reader's `curl` 404s. | **Broken** |
| 2 | `apps/web/src/pages/InstallPage.tsx:56` | `http://localhost:8787` | Server default port is `3051` (`apps/server/src/index.ts:45`). Reader's browser connection refused. | **Broken** |
| 3 | `apps/web/src/main.tsx:230` | `Navigate /docs/self-host` → `/protocol#self-hosting` | The anchor `#self-hosting` resolves inside the 102-line SPA doc (`apps/web/src/assets/protocol.md:54`, "## Self-hosting"). **But** that doc is stale (da-03 F1). If the SPA ever switches to the canonical `spec/protocol.md`, the anchor does not exist (canonical spec has no "Self-hosting" top-level section — self-host copy lives in `docs/SELF_HOST.md`). | **Stale** — works today, drift-trap for the canonical-spec migration |
| 4 | `apps/web/src/main.tsx:231` | `Navigate /docs/api-reference` → `/protocol#api-surface` | Resolves to `apps/web/src/assets/protocol.md:76` ("## API surface"). Canonical `spec/protocol.md` does not have a section with this exact title; its section 9 is "Hub API". Same drift-trap as #3. | **Stale** |
| 5 | `apps/web/src/main.tsx:232` | `Navigate /docs/rate-limits` → `/protocol#plumbing-layers-auto-applied` | Anchor resolves to the stale doc (`apps/web/src/assets/protocol.md:44`, "## Plumbing layers (auto-applied)"). Canonical spec puts rate-limit truth at `spec/protocol.md:164–176` under "### Headers". Same trap. | **Stale** |
| 6 | `apps/web/src/main.tsx:233` | `Navigate /docs/changelog` → `https://github.com/floomhq/floom/releases` (via `ExternalRedirect`) | External; not verifiable in-repo. Assumes GitHub releases page exists; repo is currently public so most likely ✅, but one release cut never published to the Releases tab breaks the link. | **External — assumed met** |
| 7 | `apps/web/src/main.tsx:224, 235` | `Navigate /docs` → `/protocol`; `/docs/*` → `/protocol` | Swallows every `/docs/:anything` path. **Consequence:** a reader who types `/docs/triggers` or `/docs/stripe` lands on `/protocol` (the 102-line doc), which mentions neither. Silent content loss instead of 404. | **Partial** — technically works, semantically wrong |
| 8 | `README.md:20` | `[Protocol](./spec/protocol.md)` | Resolves to 360-line canonical spec on GitHub. ✅ | **Met** |
| 9 | `apps/web/src/pages/ProtocolPage.tsx:9` | `import protocolMd from '../assets/protocol.md?raw';` | Resolves to 102-line stale spec. The SPA's `Protocol` link therefore reads a **different file** than the GitHub `Protocol` link (#8). | **Duplicate target** — load-bearing per PRODUCT.md, fix in place |
| 10 | `docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166` | `ghcr.io/floomhq/floom:<tag>` | CI publishes only to `ghcr.io/floomhq/floom-monorepo` (`.github/workflows/publish-image.yml:37–46`, with an explicit comment that the `floom` package name is taken by a different project). A `sed` command on `:22` matching the legacy name silently no-ops on the real image. | **Broken for real use** |
| 11 | `docker/docker-compose.yml:15` | `image: ghcr.io/floomhq/floom:v0.3.0` | Same package-name issue as #10. A reader who `cd docker && docker compose up` pulls an image that is not the one CI published. | **Broken for real use** |
| 12 | `examples/docker-compose.proxied.yml:53` | `image: ghcr.io/floomhq/floom:v0.3.0` | Same. The `examples/` directory is what `README.md:127` points an ICP at. | **Broken for real use** |
| 13 | `docs/README.md:5` | `[Protocol spec](../spec/protocol.md)` | Resolves from `docs/README.md` relative path to repo-root `spec/protocol.md`. ✅ | **Met** |
| 14 | `docs/README.md:20` | `[Claude Desktop](./CLAUDE_DESKTOP_SETUP.md)` | Resolves to `docs/CLAUDE_DESKTOP_SETUP.md`. ✅ | **Met** |
| 15 | `docs/README.md:21` | `[Go-public checklist](./GO_PUBLIC_CHECKLIST.md)` | Resolves to `docs/GO_PUBLIC_CHECKLIST.md`. ✅ | **Met** |
| 16 | `docs/README.md` | (Setup section) | **Does not link** `docs/TRIGGERS.md`, `docs/OAUTH_SETUP.md`, `docs/OBSERVABILITY_SETUP.md`. Each file exists. None are on `docs/PRODUCT.md` load-bearing list. | **Orphan** |
| 17 | `spec/protocol.md:261` | `[docs/CLAUDE_DESKTOP_SETUP.md](../docs/CLAUDE_DESKTOP_SETUP.md)` | Resolves. ✅ | **Met** |
| 18 | `spec/protocol.md:333` | `[adapters.md](./adapters.md)` | Resolves to `spec/adapters.md`. ✅ | **Met** |
| 19 | `spec/protocol.md:337–341` | `[RuntimeAdapter](./adapters.md#runtimeadapter)` etc. | Five adapter anchor links; not verified line-by-line in this pass but naming is conventional GitHub-slug-cased. Spot check: `spec/adapters.md` exists; full anchor audit deferred (out of scope for this file). | **Probably Met** |
| 20 | `apps/web/src/pages/InstallPage.tsx:74, 80` | `/protocol` and `/protocol#self-hosting` | Both resolve to the SPA-rendered 102-line doc. Same drift-trap as #3–5. | **Stale** |
| 21 | `apps/web/src/main.tsx:209, 210, 221, 223, 236, 241, 242, 253–258` | 10× `Navigate to="…"` redirects inside the app | All target routes are mounted earlier in the same file. No loops detected. | **Met** |
| 22 | `apps/web/src/main.tsx:168` | `Route path="/install"` | Route is mounted. Destination file exists (`InstallPage.tsx`). Content is wrong (#1, #2). | **Met at route level, Broken at content level** |
| 23 | `apps/server/src/index.ts:842–852` | `/spec`, `/spec/*` → `308 /protocol` | Server-side redirect wired. SPA comment at `apps/web/src/main.tsx:168–171` documents why no client route exists. Redirect works. | **Met** |
| 24 | `docs/SELF_HOST.md:66` | `docs/connections.md` | File exists. ✅ | **Met** |
| 25 | `docs/SELF_HOST.md:787` | `docs/monetization.md` | File exists. ✅ | **Met** |
| 26 | `docs/SELF_HOST.md:637` | `#custom-renderer-security-model` | Intra-doc anchor — grep confirms the heading exists in the same file. ✅ | **Met** |
| 27 | `docker/.env.example:91` | `docs/OAUTH_SETUP.md` | File exists. ✅ reachable from `.env.example`. Not reachable from `README.md`, `docs/README.md`, or `docs/SELF_HOST.md`. | **Partial reachability** |
| 28 | `docker/.env.example:240` | `docs/OBSERVABILITY_SETUP.md` | Same pattern as #27. | **Partial reachability** |

---

## All SPA redirects (inventory of `<Navigate>` in `apps/web/src/main.tsx`)

Direct enumeration from the file:

| From (line) | To | Target mounted? | Notes |
|-------------|----|--------------------|-------|
| `/build` (209) | `/studio/build` | ✅ (line 199) | Legacy path, matches README "Try it" teaser |
| `/creator` (210) | `/studio` | ✅ (198) | Legacy path |
| `/creator/:slug` (211) → `StudioSlugRedirect` | `/studio/:slug` | ✅ (201) | Dynamic redirect, same-namespace |
| `/me/apps/:slug` (186) → `StudioSlugRedirect` | `/studio/:slug` | ✅ | Dynamic redirect via component |
| `/me/apps/:slug/secrets` (187) | `/studio/:slug/secrets` | ✅ (203) | Dynamic redirect via component |
| `/me/a/:slug` (192) | `/me/apps/:slug` | ✅ (186, which then forwards — **two-hop**) | Double-redirect. Not a loop but doubles navigation cost. |
| `/me/a/:slug/secrets` (193) | `/me/apps/:slug/secrets` (→ `/studio/:slug/secrets`) | ✅ | Double-redirect (same pattern) |
| `/me/a/:slug/run` (194) | `/me/apps/:slug/run` | ✅ (188) | Different tail — `MeAppRunPage`, not a studio redirect. OK. |
| `/browse` (221) | `/apps` | ✅ (160) | |
| `/deploy` (223) | `/studio/build` | ✅ (199) | |
| `/docs` (224) | `/protocol` | ✅ (166) | Silent content loss (see #7 above) |
| `/docs/protocol` (229) | `/protocol` | ✅ (166) | Redundant with `/docs/*` catch-all |
| `/docs/self-host` (230) | `/protocol#self-hosting` | Anchor in stale doc; canonical lacks it | Drift-trap (see #3) |
| `/docs/api-reference` (231) | `/protocol#api-surface` | Anchor in stale doc | Drift-trap |
| `/docs/rate-limits` (232) | `/protocol#plumbing-layers-auto-applied` | Anchor in stale doc | Drift-trap |
| `/docs/changelog` (233) | `https://github.com/floomhq/floom/releases` (via ExternalRedirect) | External | Assumed met |
| `/docs/*` (235) | `/protocol` | ✅ (catch-all) | Silent 404 → silent content loss |
| `/self-host` (236) | `/#self-host` | In-page anchor on `/` | `CreatorHeroPage` — hero must render a `self-host` id for the anchor to scroll. Not verified in this pass. |
| `/onboarding` (241) | `/me?welcome=1` | ✅ | Query-string handshake |
| `/pricing` (242) | `/` | ✅ | Collapses pricing page to hero |
| `/p/:slug/dashboard` (243) → `PSlugDashboardRedirect` | Dynamic → `/studio/:slug` | ✅ | |
| `/legal/imprint` (253) | `/legal` | ✅ (247) | |
| `/legal/privacy` (254) | `/privacy` | ✅ (249) | |
| `/legal/terms` (255) | `/terms` | ✅ (250) | |
| `/legal/cookies` (256) | `/cookies` | ✅ (251) | |
| `/impressum` (258) | `/legal` | ✅ | |

**No cycles detected.** `/me/a/:slug/secrets` → `/me/apps/:slug/secrets` → `StudioSlugRedirect` → `/studio/:slug/secrets` is three redirects deep; ending at a mounted page. Navigation works but a user watching their URL bar sees three URL rewrites. Low priority.

---

## Concrete findings

### F1 — `/install` page documents two fictional things (highest priority)

Already covered in da-02 F1. Re-surfaced here because these are the two highest-severity **link-level** trust hits:

- `apps/web/src/pages/InstallPage.tsx:56`: `http://localhost:8787` — default port is `3051` (`apps/server/src/index.ts:45`).
- `apps/web/src/pages/InstallPage.tsx:62–69`: `POST /api/publish` — no such route (`apps/server/src/index.ts:155–222`, grep confirms the string exists only in `InstallPage.tsx`).

The page comment (`InstallPage.tsx:1–6`) says the page exists because the wireframes + sitemap linked to it from the TopBar. Load-bearing rationale per PRODUCT.md: the TopBar still advertises it. Fix-in-place, not delete.

### F2 — Two files both claim to be "the Floom protocol"

Covered in da-01 F4 and da-03. Link-hygiene-specific evidence:

- `README.md:20` → `./spec/protocol.md` (360 lines, dated 2026-04-19).
- `apps/web/src/components/TopBar.tsx:562` → SPA route `/protocol`, served by `apps/web/src/pages/ProtocolPage.tsx:9` which loads `../assets/protocol.md` (102 lines, no date).
- `ProtocolPage.tsx:708` then renders a self-host snippet that **contradicts the body it just rendered** (port 3051 vs 3000, `floom-monorepo` vs `floom`).

Both files are load-bearing per `docs/PRODUCT.md` ("manifest shape" + "three-surfaces model"). **Do not delete.** Mechanical fix candidate: Vite alias + `import protocolMd from '@spec/protocol.md?raw';` in `ProtocolPage.tsx:9`.

### F3 — Orphan docs inventory

| File | Linked from | Status |
|------|-------------|--------|
| `docs/TRIGGERS.md` | nothing outside this audit pack | **Fully orphan.** Not on `docs/PRODUCT.md` load-bearing list. |
| `docs/OAUTH_SETUP.md` | `docker/.env.example:91` | **Partial orphan.** Reachable only by the operator who opens `.env.example`. Not from `README.md`, `docs/README.md`, or `docs/SELF_HOST.md`. |
| `docs/OBSERVABILITY_SETUP.md` | `docker/.env.example:240` | Same as above. |
| `docs/GO_PUBLIC_CHECKLIST.md` | `docs/README.md:21` | Reachable ✅. (Not orphan.) |
| `docs/CLAUDE_DESKTOP_SETUP.md` | `docs/README.md:20`, `spec/protocol.md:261` | Reachable ✅. |
| `docs/ROLLBACK.md` | `docs/README.md:9` | Reachable ✅ (content is broken — see F4). |
| `docs/DEFERRED-UI.md` | `docs/README.md:14`, `apps/web/src/api/client.ts:445, 556`, `apps/web/src/lib/types.ts:384` | Reachable ✅ (content contradicts ROADMAP — see F5). |

Grep was:

```
rg 'TRIGGERS\.md' /Users/federicodeponte/floomhq/floom
```

Only hits are this audit's files and `docs/docs-audit/INDEX.md`. Triggers are a shipped feature (`apps/server/src/routes/triggers.ts`, `spec/protocol.md:267–295`). The doc exists. Nothing on the ICP funnel links to it.

Load-bearing check: none of the three orphans appear in `docs/PRODUCT.md`'s load-bearing list. Per `AGENTS.md`, this means they are proposal-able to delete — but a paragraph of "what product pillar does this serve" is required. Triggers is a product pillar (scheduled runs + incoming webhooks as first-class). The doc probably wants to stay and get linked from `docs/README.md`'s Setup section. OAuth and observability setup are operator-only concerns that could fold into `docs/SELF_HOST.md` sub-sections. Product-decision, not doc-audit.

### F4 — `docs/ROLLBACK.md` is a production runbook that writes to the wrong image name

From `docs/ROLLBACK.md` (da-01 F10 evidence collated):

- `:21, 22, 69, 83, 100, 101, 116, 125, 166` reference `ghcr.io/floomhq/floom:*`.
- CI publishes to `ghcr.io/floomhq/floom-monorepo` only (`.github/workflows/publish-image.yml:37–46`).
- The `sed` command on `docs/ROLLBACK.md:22` (`sed -i 's|ghcr.io/floomhq/floom:.*|ghcr.io/floomhq/floom:v0.2.0|' docker-compose.yml`) **does not match** `ghcr.io/floomhq/floom-monorepo:*` — the `.*` is greedy but the prefix `floom:` differs from `floom-monorepo:`. The sed runs, matches nothing, exits 0, and the compose file is unchanged.

Link-hygiene framing: **every line in `ROLLBACK.md` that mentions an image points at a package Floom does not own.** Not a broken hyperlink; a broken operational link to a shell command.

### F5 — `docs/ROADMAP.md` has internal contradictions that propagate through links

Already covered in da-01 F5, F7, F8 and da-02 F4. Link-hygiene angle:

- `docs/README.md:8` links `./ROADMAP.md`.
- `README.md:148` links `./docs/ROADMAP.md`.
- Inside `ROADMAP.md`, `:26` says async-queue UI is shipped; `:35` says it is a P0 launch blocker. A reader who arrives via the `docs/README.md` link and another who arrives via the root `README.md` link both hit the same contradiction.

### F6 — `docs/SELF_HOST.md#rate-limits` is an anchor target that exists but lies

Covered in da-03 R5. Link exists (`apps/server/src/index.ts:253` as the `/openapi.json` description, and implicitly linked from runtime). Anchor resolves to `docs/SELF_HOST.md:221`. Numbers below the anchor are 3× off (da-01 F2). Link is **structurally met**, **semantically broken**. This is the class of drift a raw link-checker never catches because the anchor resolves and returns 200.

### F7 — `ghcr.io/floomhq/floom:*` references across the tree (full inventory)

Every repo location that references the legacy image name:

| File | Line(s) | Content |
|------|---------|---------|
| `docs/ROLLBACK.md` | 21, 22, 69, 83, 100, 101, 116, 125, 166 | rollback sed + pull commands (F4) |
| `docker/docker-compose.yml` | 15 | `image: ghcr.io/floomhq/floom:v0.3.0` |
| `examples/docker-compose.proxied.yml` | 53 | same |
| `apps/web/src/assets/protocol.md` | 60–62 | `docker run ghcr.io/floomhq/floom:latest` |
| `apps/web/src/pages/ProtocolPage.tsx` | 708 | footer card — da-01 F4 cross-reference |

The CI-published name is `ghcr.io/floomhq/floom-monorepo`. Grep for that string hits `README.md:87` (correct), `SECURITY.md`, `docs/SELF_HOST.md:34, 424, 881`, and `.github/workflows/publish-image.yml`. So the repo is **50/50 split** on which image name it tells the reader to pull. That's the single most concentrated trust hit in the link graph.

### F8 — SPA route `/install` and `/me/install` are semantically different pages advertised with similar names

- `/install` (`apps/web/src/main.tsx:168`) — public CLI install stub, content is fictional (F1).
- `/me/install` (`apps/web/src/main.tsx:177`) — authenticated "Install to Claude Desktop" flow.

Both are legitimate pages; the naming collision is the kind of thing that breaks user mental models when they paste a URL at someone. `apps/web/src/pages/InstallPage.tsx:1–6` calls out the distinction in a top-of-file comment but the UX does not. Not a link break — a link-naming hygiene note.

### F9 — `README.md`'s example manifest URL is the only one the reader actually runs

`README.md:73`: `openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml`

External URL. Resend publishes this spec. Not verified live in this audit (no egress), but `docs/SELF_HOST.md:20` and the live floom.dev docs use the same URL in their example. Low risk; worth noting that the very first command a first-day reader pastes depends on a third-party URL staying stable. No alternative local-example pointed at.

### F10 — `spec/protocol.md` adapter-section anchor links

`spec/protocol.md:337–341` uses anchor syntax `./adapters.md#runtimeadapter`, `./adapters.md#storageadapter`, `./adapters.md#authadapter`, `./adapters.md#secretsadapter`, `./adapters.md#observabilityadapter`. `spec/adapters.md` exists. Section-heading anchor conventions (GitHub-flavored markdown) auto-slugify section titles to kebab-case; these anchor names assume headings like `## RuntimeAdapter`. Not verified in this pass. Recommend a future pass that checks `spec/adapters.md` for those five headings.

### F11 — Docs tree file inventory vs what's actually reachable from `docs/README.md`

```
docs/CLAUDE_DESKTOP_SETUP.md   reachable (docs/README.md:20)
docs/DEFERRED-UI.md            reachable (docs/README.md:14)
docs/GO_PUBLIC_CHECKLIST.md    reachable (docs/README.md:21)
docs/OAUTH_SETUP.md            NOT reachable from docs/README.md
docs/OBSERVABILITY_SETUP.md    NOT reachable from docs/README.md
docs/PRODUCT.md                reachable (docs/README.md:13)
docs/README.md                 root
docs/ROADMAP.md                reachable (docs/README.md:8)
docs/ROLLBACK.md               reachable (docs/README.md:9)
docs/SELF_HOST.md              reachable (docs/README.md:7)
docs/TRIGGERS.md               NOT reachable from docs/README.md
docs/connections.md            reachable (docs/README.md:16)
docs/monetization.md           reachable (docs/README.md:15)
```

So 10 of 13 docs are one click from `docs/README.md`. Three are not. Adding three lines to `docs/README.md`'s Setup section closes this gap.

### F12 — `docs/ROADMAP.md` does not link `docs/DEFERRED-UI.md` and vice-versa

The two files **contradict** each other (da-01 F5, F7) but **do not cross-reference** — a reader reading one never learns the other exists unless they return to `docs/README.md`. Structural fix: add a one-line "See also" at the top of each file. Out of scope for a link-hygiene audit but flagged because it's the class of link that matters most for trust.

### F13 — `README.md` footer `@federicodeponte` link

`README.md:158`: `[@federicodeponte](https://github.com/federicodeponte)` — external, assumed met (standard GitHub profile). `SECURITY.md` and `CONTRIBUTING.md` links all work. `./LICENSE` resolves.

### F14 — Route mounted for side-effect only: `/_creator-legacy`, `/_build-legacy`

`apps/web/src/main.tsx:214–216` mounts two legacy routes with `_` prefixes. Not linked anywhere. Looks like they exist as escape hatches while migration to `/studio/*` completes. Not broken; not reachable by ICP; not a trust issue. Noted so a future cleanup pass knows they're here.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| da4-R1 | **P0** | `/install` page documents a fake route (`/api/publish`) and a wrong port (`8787`). First-day readers' `curl` returns 404 and `http://localhost:8787` refuses. | `apps/web/src/pages/InstallPage.tsx:56, 62–69`; `apps/server/src/index.ts:45, 155–222` |
| da4-R2 | **P0** | `docs/ROLLBACK.md` sed pattern silently no-ops on the real image name. Release drills off this runbook will leave the old tag live. | `docs/ROLLBACK.md:22`; `.github/workflows/publish-image.yml:37–46` |
| da4-R3 | **P0** | Half the repo says pull `ghcr.io/floomhq/floom`, the other half says `ghcr.io/floomhq/floom-monorepo`. The first name is a package Floom does not own. | F7 inventory; covered in da-01 F1 |
| da4-R4 | **P1** | `/protocol` SPA route loads a second, stale protocol spec. TopBar "Protocol" → one doc; README "Protocol" → another. Both land on the word "Protocol". | F2; `apps/web/src/pages/ProtocolPage.tsx:9, 708`; `apps/web/src/components/TopBar.tsx:562`; `README.md:20` |
| da4-R5 | **P1** | Four `Navigate` redirects (`/docs/self-host`, `/docs/api-reference`, `/docs/rate-limits`, plus the in-page `InstallPage` anchor links) target anchors that only exist in the stale doc. A future fix that swaps the SPA to `spec/protocol.md` 404s every one of them. | `apps/web/src/main.tsx:230–232`; F2 |
| da4-R6 | **P1** | Three setup docs (`TRIGGERS.md`, `OAUTH_SETUP.md`, `OBSERVABILITY_SETUP.md`) are reachable only from `docker/.env.example` or nowhere. Features are shipped; docs are not findable. | F3, F11 |
| da4-R7 | **P1** | `/openapi.json` description points at `docs/SELF_HOST.md#rate-limits`, an anchor that resolves but contains stale numbers. Machines reading the self-describe doc are being told 20/100/200/hr; code enforces 60/300/500/hr. | F6; `apps/server/src/index.ts:253`; `docs/SELF_HOST.md:221, 232–236`; `apps/server/src/lib/rate-limit.ts:27–40` |
| da4-R8 | **P2** | `/docs/*` catch-all silently collapses every unknown `/docs/X` URL to `/protocol`. Old blog links to `/docs/connections`, `/docs/stripe`, etc. land on a page that doesn't mention them. | `apps/web/src/main.tsx:235` |
| da4-R9 | **P2** | Two docs that contradict each other (`ROADMAP.md` vs `DEFERRED-UI.md`) don't cross-link. Readers need to find the disagreement on their own. | F12 |
| da4-R10 | **P2** | `/me/a/:slug/secrets` triple-redirects to `/studio/:slug/secrets`. No loop, but three URL rewrites for one click. | `apps/web/src/main.tsx:193, 187, 203` |
| da4-R11 | **P2** | `spec/protocol.md:337–341` adapter anchor links are not verified end-to-end in this pass. Five potential broken anchors. | F10 |

---

## Open PM questions

1. **`/install` page: rewrite the three wrong lines or retire the route.** Both options are cheap. Retiring it means deleting `apps/web/src/pages/InstallPage.tsx` + the TopBar entry + the `/install` route in `main.tsx:168`. Rewriting means changing the port to `3051`, the endpoint to `POST /api/hub/ingest`, and the body to match `spec/protocol.md:308`. Which?
2. **Canonical image tag in the rollback runbook.** `docs/ROLLBACK.md` should point at `ghcr.io/floomhq/floom-monorepo` throughout. This is the same decision as da-01 Open Question 1 but with sed commands on the line.
3. **`/docs/*` semantics.** Currently the catch-all collapses every `/docs/X` path to `/protocol`. Alternatives: (a) keep catch-all but emit a sub-heading banner when the slug was not one of the known four; (b) render a 404 page instead for unknown `/docs/X`; (c) mount a real docs router (new work, out of scope for docs audit). The status quo is silent content loss.
4. **`TRIGGERS.md`, `OAUTH_SETUP.md`, `OBSERVABILITY_SETUP.md`: link or fold.** Either add to `docs/README.md`'s Setup section (one line each), or fold their content into the matching sub-section of `docs/SELF_HOST.md` and delete. Load-bearing check done — none are on the list, both options are safe.
5. **Canonical protocol source.** Same question as da-03 Open Q1. Picking `spec/protocol.md` as canonical and routing the SPA there fixes F2 **and** breaks four `/docs/*` anchors (R5) — the four anchor redirects have to be re-pointed at the canonical spec's equivalent section anchors.
6. **Cross-link ROADMAP ↔ DEFERRED-UI.** Two "See also" lines in two files. Trivial. Should happen in the same pass that reconciles the contradictions.

---

## Source index

| Area | Paths |
|------|-------|
| SPA routes + redirects | `apps/web/src/main.tsx:155–259` |
| TopBar nav | `apps/web/src/components/TopBar.tsx:273, 281, 304, 392, 400, 520, 532, 551, 562, 571, 581, 592` |
| `/install` trap | `apps/web/src/pages/InstallPage.tsx:1–100` |
| Duplicate protocol | `spec/protocol.md`, `apps/web/src/assets/protocol.md`, `apps/web/src/pages/ProtocolPage.tsx:9, 708` |
| Broken rollback | `docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166`; `.github/workflows/publish-image.yml:37–46` |
| Image name drift | `docker/docker-compose.yml:15`; `examples/docker-compose.proxied.yml:53`; `apps/web/src/assets/protocol.md:60–62` |
| Docs reachability | `docs/README.md:5–21`; `docker/.env.example:91, 240` |
| Orphans | `docs/TRIGGERS.md`; `docs/OAUTH_SETUP.md`; `docs/OBSERVABILITY_SETUP.md` |
| `/spec` server redirect | `apps/server/src/index.ts:842–852`; `apps/web/src/main.tsx:168–171` |
| OpenAPI description anchor | `apps/server/src/index.ts:253`; `docs/SELF_HOST.md:221, 232–236`; `apps/server/src/lib/rate-limit.ts:27–40` |
