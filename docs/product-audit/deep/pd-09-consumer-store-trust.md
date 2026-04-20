# pd-09: Consumer discovery & store trust

**Audit type:** Deep product truth (public catalog, permalink, and social proof vs consumer trust)  
**Sources of truth:** `docs/PRODUCT.md` (ICP, three surfaces, load-bearing paths)  
**Primary surfaces reviewed:** `apps/web/src/pages/AppsDirectoryPage.tsx` (`/apps`), `apps/web/src/lib/hub-filter.ts`, `apps/web/src/pages/AppPermalinkPage.tsx` (intro + review wiring), `apps/web/src/components/public/AppStripe.tsx`, `apps/web/src/components/AppReviews.tsx`, `apps/server/src/routes/hub.ts` (public list + hide/fixture invariants), `apps/server/src/lib/hub-filter.ts`, `apps/server/src/routes/reviews.ts`  
**Cross-reference:** `docs/ux-audit/by-route/route-02-apps.md`, `route-03-permalink.md` — **not present in repo at audit time**; inline comments in `AppsDirectoryPage.tsx` cite a **route-02** audit (e.g. search-submit / mobile keyboard, 2026-04-20).  
**INDEX note:** `docs/product-audit/deep/INDEX.md` names **`qualityHubApps`**; that symbol **does not exist** in the codebase — quality is enforced via **`publicHubApps`**, **`isTestFixture`**, **`filterTestFixtures`**, sort keys, and env-driven hide lists instead.  
**Snapshot note:** Evidence reflects repo state at audit time.

---

## 1. Executive truth table

| Promise / invariant (from `PRODUCT.md` or stated product behavior) | Where it appears | Reality (product + UI + API) | Status |
|---------------------------------------------------------------------|------------------|------------------------------|--------|
| **End users never install tooling** — consumers experience hosted outcomes via surfaces | `PRODUCT.md` §Host requirements | `/apps` and `/p/:slug` are pure web; discovery is HTTP + SPA. | **Met** |
| **Three surfaces** per app: web form `/p/:slug`, MCP, HTTP run | `PRODUCT.md` §Core value | Directory links into **`/p/:slug`** only; MCP/HTTP are not first-class in the store grid (Install tab on permalink carries part of that story). | **Partial** |
| **Hosting is the product**; store is ancillary to “paste repo, get live” | `PRODUCT.md` positioning | A polished **public directory** + landing **hero stripes** still shape first-impression trust (“how real is this ecosystem?”). | **Partial** (narrative secondary, trust primary) |
| **Public directory = credible catalog** (no obvious QA/toy rows) | Implied by consumer ICP; explicit in `hub-filter.ts` comments | Server **`GET /api/hub`** strips test fixtures by default; **`FLOOM_STORE_HIDE_SLUGS`** removes chosen slugs from the list **without** breaking **`GET /api/hub/:slug`** / `/p/:slug`. Web **`isTestFixture`** is defense-in-depth vs server regex drift. | **Met** (with residual risks below) |
| **Single source of truth** for “N apps” counts (landing vs `/apps`) | `hub-filter.ts` (web) | Landing uses **`publicHubApps`**; `/apps` filters with **`isTestFixture`** and sorts client-side — same intent, **not** the same function name. Server list order vs client re-sort can diverge slightly for non-default `?sort=`. | **Partial** |
| **Reviews = trustworthy social proof** | W4-minimal product shape | **GET** reviews: global summary per slug, authenticated **POST**, upsert per user. **UI:** `AppReviews` hides QA-shaped rows **client-side** and recomputes avg/count; **`AppPermalinkPage`** hero/meta uses **`res.summary` from the API unchanged** — hero can **disagree** with the Reviews section. | **Contradicted** (hero vs body) |
| **`blocked_reason`** warns consumers when an app is not runnable in this environment | Comment in `hub.ts` (store card / warning pill) | API attaches **`blocked_reason`** to hub rows when manifest declares it; **`AppStripe`** does **not** accept or render it — directory cards show no warning. | **Missing** |
| **Featured = editorially safe** | Implied operator expectation | **`featured`** sorts first (server default + `/apps` client sort). No code-reviewed **health gate** tying featured to passing runs or uptime. | **Partial** (power without guardrails) |
| **`qualityHubApps` helper** | `docs/product-audit/deep/INDEX.md` | Not implemented under that name. | **Missing** (doc drift only) |

**Legend:** **Met** / **Partial** / **Missing** / **Contradicted** — same semantics as `pd-01-icp-positioning-truth.md`.

---

## 2. Catalog quality as product

The **hub list** is not a side feature: for visitors who are *not* pasting a repo, it is the evidence wall that Floom is a **live platform** with real utilities. Quality is therefore a **product surface**, implemented today as a **stack of filters and sorts**, not as a dedicated “curation” product layer.

**What defines “quality” in code today**

| Layer | Mechanism | Consumer effect |
|-------|-----------|-----------------|
| **Eligibility** | `GET /api/hub` returns only **`status = 'active'`** and **`visibility` public or legacy null** | Private apps stay out of the window; unlisted slugs are also excluded from this query, so they behave “link-only” relative to the store. |
| **Operator suppress** | **`FLOOM_STORE_HIDE_SLUGS`** (comma-separated, case-insensitive) applied **only** to the list route | Broken or rotating integrations can disappear from browse **without** killing permalinks — good for operator trust, invisible to end users unless documented. |
| **Fixture hygiene** | **`filterTestFixtures`** (server) + **`isTestFixture`** (web) on slug/description patterns | Prevents “Swagger Petstore” / E2E slugs from poisoning MCP and raw API consumers; web pass catches regex drift early. |
| **Ranking** | Default order: **`featured` DESC**, then **`avg_run_ms`** (nulls last), then recency, then name | Signals “what we want you to try first” + implicit performance story; unmeasured apps do not jump ahead on speed. |
| **Presentation** | **`AppStripe`**: category-driven **tint buckets** (emerald / amber / slate) to avoid identical tiles | Addresses “AI slop grid” perception; improves scanability, not factual quality. |
| **Search / chips** | `/apps`: debounced substring match over name, description, category, author fields + dynamic category chips | Discovery scales with catalog size; quality of results depends on creator-entered metadata. |

**What is *not* yet “quality as product”**

- No **`qualityHubApps`** (INDEX naming), scoring, or moderation workflow in tree.
- **`blocked_reason`** is a trust-relevant signal in the API contract for the list body but **not wired through** to directory UI — consumers may open apps that are known-broken in the current host profile with no pre-click warning.
- **Reviews** can be gamed or noisy; there is no verified-purchase / verified-run gate in `reviews.ts`.

---

## 3. Featured & broken-app risk

**Featured flag**

- **Server:** `GET /api/hub` default `ORDER BY` puts **`apps.featured DESC`** first.
- **Web:** `AppsDirectoryPage` re-sorts filtered apps with the same **`featured`** precedence, then **`avg_run_ms`**, then name.

**Risk:** `featured` is a **strong editorial lever** without an automated **run-health** or **SLO** check in the reviewed paths. A featured app with a dead upstream, slow cold start, or manifest **`blocked_reason`** still **surfaces at the top** of the directory and landing pick lists (landing uses **`pickStripes`** over **`publicHubApps`**, preferring a fixed slug roster, then filling from hub order).

**Broken / degraded app classes**

| Class | Detection / mitigation in tree | Residual risk |
|-------|-------------------------------|---------------|
| **QA OpenAPI samples** | Fixture filters | False negatives if new fixture patterns omit both slug and description matchers (server list wider than web regex today). |
| **Known-unrunnable on this host** | Manifest **`blocked_reason`** on hub payload | **No** directory pill; user learns only after navigation + run attempt. |
| **Upstream outage** | Runner errors + `upstream_host` on detail for some failures | Store does not show uptime; **featured** amplifies outages. |
| **Private / link-only** | List query excludes private | Unlisted still reachable by URL — acceptable product shape if intentional; confusing if users expect “if it’s not in store it doesn’t exist.” |

---

## 4. Consumer journey — discovery → trust → first run (with failure branches)

**Assumed entry:** “Browse live apps” from landing or direct `/apps`.

| Step | Happy path | Failure branches |
|------|------------|------------------|
| **1. Load directory** | `getHub()` returns rows; header shows **N APPS**; chips + list render. | **Hub 5s cache** after deploy: another user might briefly not see a just-published app (creator path optimized elsewhere). **`getHub` fails:** “Couldn’t load apps” + Retry; no partial list. |
| **2. Scan credibility** | No obvious toy rows (fixtures stripped); icons vary by category. | **Fixture regex lag:** rare junk rows until server updated. **All emerald fallback** if categories missing — weaker “real catalog” feel. |
| **3. Search / filter** | Debounced search; chips narrow; empty state offers **Clear filters**. | **Mobile:** search submit scrolls to results + blurs input (route-02-derived fix) — without it, keyboard obscures results. |
| **4. Open stripe** | Navigates to **`/p/:slug`**. | **Hidden slug** still has permalink — user from old link lands on app **not** in directory; can feel inconsistent. |
| **5. Permalink trust** | Tabs, run surface, optional ratings widget, reviews load. | **Review summary mismatch:** hero uses API summary; **Reviews** section filters QA strings and recomputes — **stars/count differ** in edge cases. **`?run=` dead id:** now surfaces “Run not found” card (2026-04-20 fix); **401 private run** still falls back to empty form by design — can feel “broken” to a sharer. |
| **6. First run** | Output validates “this is real.” | Upstream/network errors — trust hits **harder** if app was **featured** or **preferred** on landing. |

---

## 5. Risk register (P0 / P1 / P2)

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| R1 | **P0** | **Hero review summary can include QA fixture reviews while the Reviews section hides them** | `AppPermalinkPage.tsx` (`getAppReviews` → `setSummary(res.summary)`); `AppReviews.tsx` client filter + recomputed avg | Stars/count **contradict** within one page; sophisticated users assume manipulation or bugs |
| R2 | **P1** | **Web vs server fixture regexes can diverge** | `apps/web/src/lib/hub-filter.ts` vs `apps/server/src/lib/hub-filter.ts` (server pattern is a **superset** of slug prefixes) | Raw **`curl /api/hub`** and web `/apps` **disagree** until web is updated; MCP vs web parity risk |
| R3 | **P1** | **`?include_fixtures=true` is not auth-gated** | `hub.ts` comment: fixtures not sensitive, noisy | Low abuse risk but **surprise** for anyone assuming “public API == consumer-safe” without query params |
| R4 | **P1** | **`blocked_reason` not shown on directory cards** | `hub.ts` maps `blocked_reason`; `AppStripe` has no prop; grep shows **no** web usage | Consumers click into apps that are **declared non-runnable** on this host — wastes time, erodes trust |
| R5 | **P1** | **Featured ordering without health checks** | SQL + `AppsDirectoryPage` sort both prioritize **`featured`** | Spotlight amplifies outages / flaky demos |
| R6 | **P2** | **Reviews are global per slug across workspaces** | `reviews.ts` comment + SQL | Intended for public apps; if same slug ever collides across tenants in a multi-tenant evolution, **review pollution** |
| R7 | **P2** | **Unlisted apps invisible in hub but reachable** | `hub.ts` list `WHERE` vs `/:slug` visibility handling | Correct for stealth launches; **confusing** if support docs say “not published” == “not accessible” |
| R8 | **P2** | **INDEX references `qualityHubApps`** | `docs/product-audit/deep/INDEX.md` | Future readers hunt a **non-existent** abstraction |

---

## 6. Open PM questions (numbered)

1. **Directory vs advanced surfaces:** Should `/apps` ever surface **one-click** copy for MCP URL or `POST /api/:slug/run` cURL, or does that **confuse** the non-developer ICP?
2. **`blocked_reason` policy:** Should non-runnable-in-this-environment apps be **excluded** from the public list, **downranked**, or **labeled** — and who owns that decision (manifest author vs operator)?
3. **Featured governance:** Is **`featured`** strictly **operator/editorial**, or can creators buy/pin placement later — and what **SLA** (if any) attaches to featured apps?
4. **Fixture false positives:** Is it acceptable that **real** apps whose description **exactly** opens like Swagger/httpbin/GitHub sample docs are **hidden** from the store until they edit copy?
5. **Review integrity:** Should Floom move toward **verified run** or **verified install** before a review counts toward the public average — or stay minimal for v1?
6. **Summary source of truth:** Should **`GET /api/apps/:slug/reviews`** optionally exclude QA rows server-side so **hero, SEO, and widget** all match **`AppReviews`**?
7. **Unlisted mental model:** Should `/p/:slug` for **unlisted** show a subtle **“Not in the public directory”** badge for non-owners to reduce “missing from store = broken” support tickets?
8. **Landing ↔ hub parity:** Should **`pickStripes`** prefer **featured + healthy** signals over a **static PREFERRED_SLUGS** list when the hub returns richer metadata (e.g. `blocked_reason`, error rates)?
9. **Success metrics:** Is the primary health KPI for this theme **directory → first successful run**, **time on `/p/:slug`**, or **return rate after failed run** — and what is the baseline?

---

## Appendix A — `reviews.ts` contract (lightweight recap)

- **GET `/api/apps/:slug/reviews`:** Returns **`summary`** `{ count, avg }` over **all** rows for slug + **recent** reviews (joined display names). **No** fixture filtering.
- **POST `/api/apps/:slug/reviews`:** Authenticated (or OSS synthetic user); **upsert** per `(workspace_id, app_slug, user_id)`; validates app exists to avoid orphans; rating 1–5, optional title/body with max lengths.

---

## Appendix B — `AppPermalinkPage.tsx` intro (product-relevant notes from file header)

- **`/p/:slug`** is the **user-facing product page** (wireframe-aligned), single scroll with **tabs** in later revision: Run / About / Install / Source.
- **“Coming soon”** stubs called out: schedule drawer, ChatGPT/Notion/Terminal connectors — **honest incompleteness** reduces trust damage vs fake depth.
- **GitHub source map** `GITHUB_REPOS` is **explicit allowlist** of slugs with examples in `examples/` — avoids linking stub-only apps after bloat cut (provenance signal).

---

*End of pd-09 — Consumer discovery & store trust.*
