# da-02 — First thirty minutes (walking the README as an ICP reader)

**Audit type:** Docs-hygiene audit (read-only).
**Scope:** a non-developer AI engineer who has the repo link, nothing else. They open [`README.md`](../../README.md), click every link in order, run every command. Where does that reader land? What trust hits do they absorb?
**Repo snapshot:** `origin/main` `d62a4cf`, audit run **2026-04-20**.

## Executive summary

A reader who trusts `README.md` end-to-end hits **three trust-breaking surprises in the first ten commands**:

1. The self-host `docker run` pulls `v0.4.0-mvp.4` but when they click through to [`docs/SELF_HOST.md`](../SELF_HOST.md) the example command pulls `v0.4.0-minimal.6` — two different tags three clicks apart.
2. The README "Community" section links `./SECURITY.md` (works) and `./CONTRIBUTING.md` (works), and shows a "Try it" button that points at `https://floom.dev/build` (works live but not verifiable from the repo); the "Protocol" link points at `./spec/protocol.md` which is the canonical 360-line spec — **but** the reader who instead navigates to `/protocol` in the web app sees the 102-line [`apps/web/src/assets/protocol.md`](../../apps/web/src/assets/protocol.md), a stale copy with contradicting self-host instructions.
3. If the reader clicks "Install" from the live site's top bar (`/install`), they land on [`InstallPage.tsx`](../../apps/web/src/pages/InstallPage.tsx) which tells them the server runs on `localhost:8787` (it does not — default is `3051`) and to `curl -X POST http://localhost:8787/api/publish` (that route does not exist).

README is marketing-correct. The operational on-ramp it funnels into has three bad steps. That is a well-contained fix surface — four files, maybe thirty lines — but as of 2026-04-20 it is the first-day ICP experience.

---

## Executive truth table

| # | Doc claim (quote + path) | Code/Reality | Verdict |
|---|--------------------------|--------------|---------|
| 1 | "`docker run -d --name floom -p 3051:3051 -v floom_data:/data -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" -e FLOOM_APPS_CONFIG=/app/config/apps.yaml -e RESEND_API_KEY=re_... ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4`" (`README.md:81–88`) | `docs/SELF_HOST.md:34` says `v0.4.0-minimal.6`; `docker/docker-compose.yml:15` says `ghcr.io/floomhq/floom:v0.3.0` (wrong package name). `apps/server/package.json:3` reads `"version": "0.4.0-mvp.5"`. | **Contradicted** |
| 2 | "Self-host (60 seconds)" (`README.md:66`) | Full SELF_HOST guide is 887 lines (`docs/SELF_HOST.md`) and contains Composio, Stripe, observability, backup runbook, rollback notes. 60 seconds is the sticker price; everything the ICP needs to **operate** is much longer. | **Partial** — first-boot claim holds, "done" claim does not |
| 3 | "Runs the web app on `:5173` and the server on `:3051` with hot reload." (`README.md:144`) | `apps/server/src/index.ts:45` confirms `3051`. Web dev server is Vite default `:5173`. | **Met** |
| 4 | "[Try it](https://floom.dev/build)" (`README.md:18`) | Live URL — not verifiable from repo. The in-repo `/build` React Route is a `<Navigate to="/studio/build" replace />` (`apps/web/src/main.tsx:209`), so the cloud/preview should 302 to `/studio/build`. A reader who bookmarks `/build` is on a redirect. | **Drift** — minor, redirect works |
| 5 | "[Self-host](./docs/SELF_HOST.md) · [Protocol](./spec/protocol.md) · [Roadmap](./docs/ROADMAP.md)" (`README.md:19–22`) | All three files exist: 887 lines, 360 lines, 83 lines respectively. | **Met** |
| 6 | "Four MCP admin tools (`ingest_app`, `list_apps`, `search_apps`, `get_app`)" (`README.md:34`) | Correct on count for admin tools; missing the separate `/mcp/search` gallery-search MCP server (`apps/server/src/routes/mcp.ts:760–764`, `spec/protocol.md:234–236`). | **Drift** — under-count |
| 7 | "See [docs/ROADMAP.md](./docs/ROADMAP.md) for priorities. The v0.4 line is OpenAPI ingest, secret policies, per-app rate limits, and MCP admin tools; everything else is parked until those are battle-tested." (`README.md:148–150`) | `docs/ROADMAP.md` shows v0.4 line also shipped Stripe Connect backend, Composio connections backend, custom renderer sandbox, async queue, multi-tenant schema (`docs/SELF_HOST.md:881–886`), renderer + connections are called out on the same ROADMAP page. README description under-claims the v0.4 scope. | **Drift** — under-claims |
| 8 | "MIT. See [LICENSE](./LICENSE)." (`README.md:162`) | `LICENSE` exists; `package.json`, `apps/server/package.json`, `packages/*/package.json` all reference MIT. `spec/protocol.md:78` notes "`license`: SPDX identifier (e.g. `MIT`)". | **Met** |
| 9 | "Built in SF by [@federicodeponte](https://github.com/federicodeponte)" (`README.md:158`) | Legal addresses say Delaware (C-Corp, `apps/web/src/pages/ImprintPage.tsx:19–27`) with no mention of SF; privacy page claims infrastructure is in the EU (`apps/web/src/pages/PrivacyPage.tsx:173–174`). Not a lie — founder location vs company incorporation vs hosting region are three different things — but the reader has to reconcile three answers. | **Drift** — minor trust friction |
| 10 | "[CONTRIBUTING.md](./CONTRIBUTING.md)" (`README.md:155`) | File exists at repo root (`CONTRIBUTING.md`); `AGENTS.md` and `SECURITY.md` also exist. | **Met** |

---

## Walk the commands — what happens, click by click

The ICP (per `docs/PRODUCT.md:11`) is "a non-developer AI engineer who has a working prototype on `localhost` and needs to get it to production without learning Docker, reverse proxies, secrets managers, OAuth, or infra." Below is a literal click-and-paste walk of [`README.md`](../../README.md) from the top.

### Step 0 — open `README.md` on GitHub

- Hero + badges render. ✅
- Four nav pills: **Try it** → `https://floom.dev/build` (external, not verifiable here); **Self-host** → `./docs/SELF_HOST.md` (open file, ✅); **Protocol** → `./spec/protocol.md` (opens 360-line spec, ✅); **Roadmap** → `./docs/ROADMAP.md` (opens 83-line file, ✅).

**What works:** all four destinations exist on GitHub.
**What drifts:** the Protocol link and the **web app's `/protocol` route** show different content (da-01 F4). A reader who clicks "Protocol" on GitHub is on spec A; a reader who clicks the same word in the TopBar at floom.dev (`apps/web/src/components/TopBar.tsx:562`) is on spec B.

### Step 1 — "Quickstart (cloud)"

(`README.md:60–64`)

> 1. Sign in at floom.dev.
> 2. Paste an OpenAPI spec URL at floom.dev/build.
> 3. Publish. Share the /p/:slug URL, or install the MCP server in your agent.

No evidence we can gather from the repo proves this works end-to-end (cloud). The repo-side equivalent is `apps/web/src/pages/BuildPage.tsx` (or its Studio redirect target `apps/web/src/pages/StudioBuildPage.tsx`) — both mounted (`apps/web/src/main.tsx:199, 209`). The page exists; the live flow depends on the cloud instance.

**What drifts:** `docs/PRODUCT.md:17–19` is explicit that the "paste a repo" path is the primary ICP on-ramp ("hosting is the product; 'OpenAPI wrapping' is a convenience path"). The README cloud quickstart funnels the user into OpenAPI-wrapping first, not into paste-a-repo. Already flagged in [`pd-04-path3-openapi-as-default-risk.md`](../product-audit/deep/pd-04-path3-openapi-as-default-risk.md) — noted here because the README text is the entry point for that mismatch.

### Step 2 — "Self-host (60 seconds)"

(`README.md:66–90`) The reader copies:

```bash
cat > apps.yaml <<'EOF'
apps:
  - slug: resend
    type: proxied
    openapi_spec_url: https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml
    base_url: https://api.resend.com
    auth: bearer
    secrets: [RESEND_API_KEY]
    display_name: Resend
    description: "Transactional email API."
EOF

docker run -d --name floom \
  -p 3051:3051 \
  -v floom_data:/data \
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \
  -e RESEND_API_KEY=re_... \
  ghcr.io/floomhq/floom-monorepo:v0.4.0-mvp.4
```

- `ghcr.io/floomhq/floom-monorepo` **is** the CI-published package (`.github/workflows/publish-image.yml:43`). ✅
- `v0.4.0-mvp.4` — `apps/server/package.json:3` is at `0.4.0-mvp.5`. Either the README is one behind the server, or the image that was actually pushed under `v0.4.0-mvp.4` is different from what source shows today. **Drift.**
- `-p 3051:3051` matches `apps/server/src/index.ts:45`. ✅
- Two lines later (`README.md:91`): "Then open `http://localhost:3051/p/resend`, or point your agent at `http://localhost:3051/mcp/app/resend`." — both routes are real (`apps/web/src/main.tsx:163`, `apps/server/src/routes/mcp.ts:767`). ✅

**Expected outcome (assuming the tag is live):** container boots, `/p/resend` loads the Resend form. Reader is happy. **Known trust hit if they pivot:** when they click to `docs/SELF_HOST.md`, the compose snippet there (`docs/SELF_HOST.md:424`) uses a **different** tag (`v0.4.0-minimal.6`). Following that one produces a different container, and diffs between the two are unexplained.

### Step 3 — click "Full guide: [docs/SELF_HOST.md]"

(`README.md:101`)

The reader lands on `docs/SELF_HOST.md`. In the first 35 lines they meet the contradicting tag and a complete quickstart. Important claims the first-day reader relies on:

- Env-var table at `docs/SELF_HOST.md:48–68` — **defaults listed for rate limits are 3× lower than the code enforces** (da-01 F2). A reader reading "20 runs/hour per IP" will not realize the server is letting 60 through.
- `PUBLIC_URL` default documented as `http://localhost:$PORT` (`docs/SELF_HOST.md:52`) — **true for most of the server, false for the MCP router** which falls back to `https://floom.dev` (da-01 F3).
- Claude Desktop setup (`docs/SELF_HOST.md:134–149`) recommends `npx -y mcp-remote`. That library exists on npm; the bridge approach is accurate.
- "Long-running apps (async job queue, v0.3.0+)" section (`docs/SELF_HOST.md:263–407`) is a full, detailed, correct reference. ✅ This is one of the strongest parts of the self-host doc.

**What dead-ends:** `docs/SELF_HOST.md:65–68` references `docs/connections.md` for Composio. That file exists (`docs/connections.md:1`). ✅. It also references `docs/monetization.md` at `docs/SELF_HOST.md:787`; that file also exists. ✅. It does **not** link out to `docs/TRIGGERS.md`, `docs/OAUTH_SETUP.md`, or `docs/OBSERVABILITY_SETUP.md`, even though triggers, OAuth, and observability are all covered in the page itself. Those three files are orphaned from the first-30-minutes funnel (see da-04 F3).

### Step 4 — click "Protocol spec: [spec/protocol.md]"

(`README.md:101`)

Lands on [`spec/protocol.md`](../../spec/protocol.md) — 360 lines, dated `Last updated: 2026-04-19` (`spec/protocol.md:3`). This is the good doc. Rate-limit numbers here are correct (`spec/protocol.md:166`), MCP surfaces include `/mcp/search` (`spec/protocol.md:234`), transport is called "Streamable HTTP" (`spec/protocol.md:238`).

**What breaks if they navigate the SPA instead:** clicking "Protocol" in the TopBar on the live site loads [`apps/web/src/assets/protocol.md`](../../apps/web/src/assets/protocol.md) — 102 lines, last non-trivially updated pre-Stripe, pre-Composio, pre-multi-tenant. The two files disagree on: image name, port, MCP transport, feature list. **They are both live.** GitHub-first readers and web-first readers end the hour with different mental models of the product.

### Step 5 — click "Install" in the TopBar (live site only)

(The reader never opens `apps/web/src/pages/InstallPage.tsx` directly on GitHub — but if they try the live site's TopBar "Install" link, this is the landing.)

Contents (`apps/web/src/pages/InstallPage.tsx:39–69`):

1. `git clone https://github.com/floomhq/floom.git && cd floom && pnpm install` — ✅ resolves, `pnpm-workspace.yaml` and `package.json` are real.
2. `pnpm --filter @floom/server dev` — ✅ that filter matches `apps/server/package.json:2` (`"name": "@floom/server"` — verified on-the-fly).
3. **"The server comes up on `http://localhost:8787`"** — **False.** Default port is `3051` (`apps/server/src/index.ts:45`). If the reader points their browser at `8787`, they get nothing.
4. **`curl -X POST http://localhost:8787/api/publish ...`** — **False on two counts.** Port is wrong (3051) and route does not exist. The ingest endpoint is `POST /api/hub/ingest` (`apps/server/src/routes/hub.ts`, documented in `spec/protocol.md:308`). Reader runs the curl: connection refused or 404.

**Impact:** the page marketed as "Install" tells the ICP to run two commands that both fail. This is the worst trust surface in the pack. Load-bearing note: `/install` route exists because the TopBar advertises it; the comment at `InstallPage.tsx:1–6` says "the route needed to exist (returned 404 before)". **Do not delete** — fix in place per `docs/PRODUCT.md` rules.

### Step 6 — click "See example manifests under [`examples/`]"

(`README.md:127`) Resolves to `examples/`. Directory exists. Spot-checked: `examples/stripe-checkout/`, `examples/flyfast/`, `examples/slow-echo/` all cited in `docs/SELF_HOST.md:383–406, 675, 780`.

### Step 7 — click "Roadmap"

(`README.md:148`) Opens `docs/ROADMAP.md`. Reader now sees:

- "Async job queue \| Shipped" (`docs/ROADMAP.md:26`) — ✅
- "Async job queue UI (re-enable)" under **P0 — Launch blockers** (`docs/ROADMAP.md:35`) — ❌ contradicts `docs/DEFERRED-UI.md:13` and the shipped line above. Same file, nine rows apart.
- "Stripe Connect monetization \| Backend stub, UI deferred to v1.1+" (`docs/ROADMAP.md:28`) — ❌ the backend ships (`apps/server/src/index.ts:203`, `docs/monetization.md`, `docs/SELF_HOST.md:727–787`). Backend is not a stub.

A reader who got this far and cares about the velocity of the project now cannot tell whether P0 is two items (legal + rate limits + landing) or seven items (the whole P0 list literally). Already deep-dived in [`pd-19`](../product-audit/deep/pd-19-roadmap-p0-execution-gap.md) — re-surfacing here because the README funnels every new reader into this confusion.

### Step 8 — click "[SECURITY.md](./SECURITY.md)"

Opens `SECURITY.md` (40 lines). Image name `ghcr.io/floomhq/floom-monorepo` matches CI. ✅. Scope excludes "User-uploaded custom renderers running in sandbox (report sandbox-escape issues only)" (`SECURITY.md:38`) — the custom-renderer sandbox is detailed in `docs/SELF_HOST.md:639–662` and `docs/product-audit/deep/pd-17-renderer-differentiator.md`. Consistent.

### Step 9 — click "[CONTRIBUTING.md](./CONTRIBUTING.md)"

Not read in full for this audit; file exists at repo root. `AGENTS.md` at repo root gives the agent-specific rules. `docs/PRODUCT.md:69–74` covers "How to propose a deletion safely". Consistent.

### Step 10 — the reader types `pnpm dev`

`README.md:138–142`:

```bash
pnpm install
pnpm dev
```

`package.json` has a `dev` script (verified via presence of `turbo.json`). The `pnpm-workspace.yaml`, `apps/server/package.json`, `apps/web/package.json` all exist. Reasonable confidence this works.

**But** if the reader followed the `/install` page from Step 5 instead of the README Development section, they already believe the server is on `:8787`. The README Development block does not re-state the port, so the misunderstanding persists — they still open `localhost:8787` in the browser and see nothing.

---

## Concrete findings

1. **F1 (ICP blocker).** `apps/web/src/pages/InstallPage.tsx:56, 62–69` documents `localhost:8787` and `POST /api/publish`. Both are fictional. Evidence: `apps/server/src/index.ts:45` (`PORT ?? 3051`), and a grep across the whole repo for `/api/publish` returns only `InstallPage.tsx`.

2. **F2.** README `docker run` tag (`v0.4.0-mvp.4`, `README.md:87`) is one behind `apps/server/package.json:3` (`v0.4.0-mvp.5`) and uses a different tag stream from `docs/SELF_HOST.md:34` (`v0.4.0-minimal.6`). Reader sees three tags in three files within ten minutes of cloning.

3. **F3.** README quickstart (`README.md:66–90`) does not call out `docker/docker-compose.yml` as the structured alternative. If a reader looks in `docker/` instead of copy-pasting, they find a compose file pinned to `ghcr.io/floomhq/floom:v0.3.0` (`docker/docker-compose.yml:15`) — a package CI does not publish. `docker/apps.yaml.example` is the only file in that folder that matches the README's verbal setup.

4. **F4.** README "What it does" (`README.md:29–34`) under-counts MCP admin surfaces (four, vs the five-surface reality in `spec/protocol.md:234–236`). Minor but agent-first positioning means agent-surface specificity matters.

5. **F5.** README "How it works" ASCII diagram (`README.md:45–50`) shows a one-way arrow `OpenAPI spec → Floom manifest → 3 surfaces`. The diagram omits the repo→hosted path — which `docs/PRODUCT.md:21–27` calls out as the **primary** path. A reader who only skims the README never learns that Floom also runs their code.

6. **F6.** README does not mention `floom_device` cookies, the per-workspace DEK encryption, or the rate-limit defaults. Those are the things an ICP security-minded reader will Google within their first day. They live in `docs/SELF_HOST.md` but not on the landing funnel.

7. **F7.** "[Try it](https://floom.dev/build)" (`README.md:18`) — on the live site `/build` is a redirect to `/studio/build` (`apps/web/src/main.tsx:209`). A reader who bookmarks the URL from the README bookmarks a redirect. Low priority but it is another tiny "wait, which is canonical?" moment.

8. **F8.** "Built in SF by @federicodeponte" (`README.md:158`) vs Delaware C-Corp (`apps/web/src/pages/ImprintPage.tsx:19–27`) vs EU-infra claim (`apps/web/src/pages/PrivacyPage.tsx:173–174`). Three different location stories in the first-30-minute funnel. See da-05 for the trust-surface drilldown.

9. **F9.** "MIT. See [LICENSE](./LICENSE)." (`README.md:162`) — `spec/protocol.md:331` calls out that `"renderer is the only concern that is currently swappable *at runtime* (per-app bundle upload)."` The custom-renderer bundles uploaded by creators at runtime inherit the app's license, not Floom's. Not a contradiction but worth noting for legal clarity.

10. **F10.** `docs/README.md:5` links the protocol spec as `../spec/protocol.md` — that resolves from `docs/README.md` to `spec/protocol.md` (correct on GitHub). The root `README.md:20` links the same file as `./spec/protocol.md` — also correct. Consistent across the two READMEs; good.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| da2-R1 | **P0** | First-day ICP running the `/install` page commands hits a port that isn't bound and a route that 404s. | `apps/web/src/pages/InstallPage.tsx:56, 62–69`; `apps/server/src/index.ts:45` |
| da2-R2 | **P0** | README `docker run` command uses `v0.4.0-mvp.4`; `docs/SELF_HOST.md` compose uses `v0.4.0-minimal.6`. Two different images on the reader's disk within ten minutes of starting. | `README.md:87`; `docs/SELF_HOST.md:34, 424` |
| da2-R3 | **P1** | README `How it works` diagram omits the repo→hosted path — primary ICP per PRODUCT.md. Reader builds the wrong mental model. | `README.md:45–50`; `docs/PRODUCT.md:21–27` |
| da2-R4 | **P1** | ROADMAP simultaneously calls async-queue UI "shipped" and "P0 launch blocker" within the same file. README links into ROADMAP; new readers absorb the contradiction. | `docs/ROADMAP.md:26, 35`; `docs/DEFERRED-UI.md:13` |
| da2-R5 | **P1** | Self-host default env-var numbers (rate limits) in the reader's first reference doc are 3× the server's actual defaults. | `docs/SELF_HOST.md:60–63, 232–237`; `apps/server/src/lib/rate-limit.ts:27–40` |
| da2-R6 | **P2** | README "four MCP admin tools" under-counts the real surface (five). | `README.md:34`; `apps/server/src/routes/mcp.ts:760–767` |
| da2-R7 | **P2** | `docker/docker-compose.yml` in the repo still points at the legacy image name. A reader who goes file-browsing before reading README lands on the wrong tag. | `docker/docker-compose.yml:15` |
| da2-R8 | **P2** | Three location stories (SF / Delaware / EU) appear within the first-day funnel. Not a lie, but a trust hit. | `README.md:158`; `apps/web/src/pages/ImprintPage.tsx:19–27`; `apps/web/src/pages/PrivacyPage.tsx:173–174` |

---

## Open PM questions

1. **Delete or fix `/install` copy.** The honest fix is either "kill the page, redirect `/install` to `/protocol#self-hosting`" or "rewrite the three wrong lines". Load-bearing: the TopBar still advertises it (`apps/web/src/components/TopBar.tsx`). Which?
2. **Canonical tag for README.** If `mvp.5` is current per `apps/server/package.json`, should the README bump to `mvp.5`? Or freeze at a public "latest stable" doc-alias tag (e.g. `v0.4.0-latest`) so README never drifts in a future release? Related to da-01 F1.
3. **ICP entry on README.** Should the "Self-host (60 seconds)" block be replaced with or preceded by a "Paste a GitHub repo" block that maps to the primary ICP path per `docs/PRODUCT.md:21–27`? Current README funnels into OpenAPI-wrap first.
4. **Protocol link on README.** The canonical link on README is `./spec/protocol.md`; the canonical link on the web is `apps/web/src/assets/protocol.md`. Pick one source and mechanically redirect the other (see da-03).
5. **Do the three orphan docs (`TRIGGERS.md`, `OAUTH_SETUP.md`, `OBSERVABILITY_SETUP.md`) belong in `docs/README.md`'s "Setup" section?** If yes, they are reachable from README within one click. If no, delete them (none are on `docs/PRODUCT.md`'s load-bearing list).
6. **What is the 30-minute "done" target?** The README claims 60 seconds to self-host, but a reader who wants to cover Composio + Stripe + legal + rate limits invests ~30 minutes of reading. That should be explicit, not implied.

---

## Source index

| Area | Paths |
|------|-------|
| README entry points | `README.md:1–163` |
| Self-host | `docs/SELF_HOST.md:1–887`, `docker/docker-compose.yml:1–71`, `docker/.env.example:1–200` |
| Protocol | `spec/protocol.md:1–360`, `apps/web/src/assets/protocol.md:1–102`, `apps/web/src/pages/ProtocolPage.tsx:1–717` |
| `/install` bait | `apps/web/src/pages/InstallPage.tsx:1–100`, `apps/web/src/main.tsx:168` |
| Ingest reality | `apps/server/src/routes/hub.ts`, `spec/protocol.md:307–309` |
| Roadmap / deferred UI | `docs/ROADMAP.md:1–83`, `docs/DEFERRED-UI.md:1–140` |
| Security / legal | `SECURITY.md:1–40`, `apps/web/src/pages/ImprintPage.tsx:1–47`, `apps/web/src/pages/PrivacyPage.tsx:1–234` |
| Port + rate limit truth | `apps/server/src/index.ts:45`, `apps/server/src/lib/rate-limit.ts:27–40` |
