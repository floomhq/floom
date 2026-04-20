# pd-04 — OpenAPI path (path 3) as default-risk

**Scope:** `docs/PRODUCT.md` deployment path 3, Studio build ramps + hero/query params, server OpenAPI ingest (overview + secrets), UX route note.  
**Question:** Does the product UI **default** the advanced OpenAPI / proxied mental model, conflicting with PRODUCT’s positioning of path 1 (repo → hosted) as primary?

**Referenced UX audit:** `docs/ux-audit/by-route/route-14-studio-build.md` — **not present** in this workspace (no file; `docs/ux-audit/by-route/` directory does not exist). This audit relies on code + `PRODUCT.md` only.

---

## Executive truth table

| Claim / promise | Source | Observed reality | Verdict |
|-----------------|--------|------------------|---------|
| Path 3 (“OpenAPI → proxied”) is **advanced**, not primary onboarding; path 1 is what the ICP needs. | `docs/PRODUCT.md` L19–25 | Build UI puts **GitHub import** first with “Recommended”, accent styling, and copy framing it as the main ramp; OpenAPI is second, visually secondary. | **Met** (static Studio layout) |
| “OpenAPI wrapping” is a convenience for people who **already have a hosted API**. | `docs/PRODUCT.md` L19–25 | Ingest persists `app_type: 'proxied'`, resolves `base_url` from spec servers / Swagger host / spec URL origin (`openapi-ingest.ts` `resolveBaseUrl`, `ingestAppFromSpec`). No Floom-hosted runtime for user-ingested OpenAPI apps. | **Met** (server model matches path 3) |
| Hero should hand users to build without stranding them. | `BuildPage.tsx` comments L282–287 | `?ingest_url=` / `?openapi=` pre-fill; non-GitHub URLs trigger **OpenAPI** auto-detect; GitHub-shaped URLs trigger **GitHub candidate** detect. | **Met** (routing matches URL class) |
| First-run onboarding should activate users quickly. | `Tour.tsx` + `onboarding.ts` | Step 1 anchors **`build-url-input`** (OpenAPI ramp), auto-fill uses **Petstore OpenAPI** as default sample (`SAMPLES[0]`); triggers `build-detect` (OpenAPI path), not GitHub `build-github-detect`. | **Contradicted** vs PRODUCT hierarchy — scripted onboarding **defaults path 3** |
| Tour copy: “Paste an OpenAPI URL or a GitHub repo.” | `Tour.tsx` L171–172 | That text is attached to the **OpenAPI** field; GitHub-repo paste on that field calls `runOpenapiDetect` / `detectApp(directUrl)` — **not** `runGithubDetect` with raw-file candidates. Sample 2 is a GitHub repo URL (`onboarding.ts` L41–44) and may fail unless the server treats it as a spec (unlikely). | **Partial / risk** — copy implies one field does both ramps; only the top GitHub form implements repo→raw OpenAPI probing (`BuildPage.tsx` `githubCandidates` + `runGithubDetect`). |

---

## Evidence index (file anchors)

| Evidence | Location |
|----------|----------|
| Path 3 defined as advanced; path 1 primary | `docs/PRODUCT.md` L21–25, L17–19 |
| Ramps: GitHub PRIMARY, OpenAPI fallback in comments | `apps/web/src/pages/BuildPage.tsx` L2–8, L514–724 |
| Hero query params + `heroIsGithub` → which detect runs | `BuildPage.tsx` L59–80, L295–315 |
| GitHub ramp uses raw OpenAPI URL candidates | `BuildPage.tsx` L170–218 |
| OpenAPI ramp calls `detectApp(inputUrl)` directly | `BuildPage.tsx` L232–270 |
| Publish always sends `openapi_url: detected.openapi_spec_url` | `BuildPage.tsx` L343–350 |
| Tour anchors OpenAPI input; samples include OpenAPI + GitHub URL | `apps/web/src/components/onboarding/Tour.tsx` L4–5, L98–167, L171–172; `apps/web/src/lib/onboarding.ts` L26–49 |
| Hero inline detect: GitHub tries candidates, else `detectApp(normalizeLink)` | `apps/web/src/pages/CreatorHeroPage.tsx` L223–249 |
| User ingest: proxied app, `auth: 'none'` in synthetic `OpenApiAppSpec`, secrets from `deriveSecretsFromSpec` | `apps/server/src/services/openapi-ingest.ts` L1312–1322, L1168–1228, L1490–1507 |
| Per-operation `secrets_needed` + app-level union | `openapi-ingest.ts` L664–737, L1433–1507 |
| ROADMAP: future “host this repo” ramp distinct from OpenAPI-in-repo | `docs/ROADMAP.md` L40 |

---

## Answer: does the UI default the advanced path?

**Split verdict:**

1. **Default layout and labeling:** **No.** The first interactive ramp is **Import from GitHub** with “Recommended” and stronger visual hierarchy; the OpenAPI card is explicitly the second form and the file header comments call OpenAPI the **fallback** (`BuildPage.tsx` L2–8, L514–566).

2. **Default scripted onboarding (Tour):** **Yes.** The first tour step is bound to `data-testid="build-url-input"` (OpenAPI ramp), the default “Use sample” action fills **Swagger Petstore** (`https://petstore3.swagger.io/api/v3/openapi.json`), and the click path uses `build-detect` — i.e. **path 3** behavior. That contradicts the product doc’s ordering (path 1 first for ICP) for users who complete the guided flow.

3. **Default hero deep-link behavior:** **Depends on URL.** `ingest_url` / legacy `openapi` with a GitHub repo shape → GitHub candidate detection; any other HTTP(S) URL → OpenAPI detection (`BuildPage.tsx` L73–80, L305–308). So the “default” path for a **generic** pasted link is OpenAPI-shaped routing, which is **correct** for non-GitHub spec URLs but reinforces path 3 for anything that is not classified as `github.com/.../...`.

4. **Server truth:** User-facing ingest for both ramps **normalizes to an OpenAPI spec URL** before persistence; GitHub is a **discovery** ramp, not path 1 “Floom runs your code” (`BuildPage` still ends at `ingestApp` + `openapi_url`). Full repo hosting / `POST /api/deploy-github` remains roadmap (`docs/ROADMAP.md` L40), so **today’s shipped “GitHub” ramp is still OpenAPI/proxied path 3** with extra URL guessing — important nuance for positioning.

---

## ICP journey (path 3 lens) with failure branches

1. **Land on `/studio/build` (no params)**  
   - Sees GitHub first, OpenAPI second.  
   - **Failure:** User ignores GitHub, uses OpenAPI only — matches path 3; may be wrong if they only have a repo and no public spec URL.

2. **Land with `?ingest_url=` from hero**  
   - Auto-detect runs once (`BuildPage.tsx` L295–315).  
   - **Failure (GitHub):** No `openapi.yaml` in tried paths → `githubError: 'no-openapi'` (`BuildPage.tsx` L214–218).  
   - **Failure (OpenAPI):** Network / invalid spec → taxonomy messages (`BuildPage.tsx` L247–262).

3. **First-run Tour**  
   - Directed to OpenAPI field; default sample is Petstore.  
   - **Failure:** User picks sample “Floom example apps” (GitHub repo URL) in the **OpenAPI** field — may not resolve as a spec (different code path from GitHub ramp). **Product risk:** copy says both kinds of URLs work in one box (`Tour.tsx` L171–172).

4. **Review / publish**  
   - `ingestApp` with `openapi_url` (`BuildPage.tsx` L343–350).  
   - **Failure:** Slug collision → 409 + suggestions (`BuildPage.tsx` L366–375; `SlugTakenError` in `openapi-ingest.ts` L1101–1110).  
   - **Secrets:** Spec-derived `secrets_needed` in detect preview (`detectAppFromUrl` L1227); runtime injection is out of scope here but path 3 assumes upstream API exists and is reachable from resolved `base_url`.

5. **Post-publish**  
   - Proxied execution, not Floom-hosted container for this ingest path.

---

## Risk register

| ID | Severity | Risk | Evidence |
|----|----------|------|----------|
| R1 | **P0** | **Onboarding defaults path 3** while PRODUCT declares path 1 as the ICP default — mixed mental model (“paste OpenAPI” vs “paste repo we host”). | `Tour.tsx` + `onboarding.ts` default Petstore OpenAPI; anchor `build-url-input`. |
| R2 | **P1** | **Tour copy conflates two ramps** (“OpenAPI URL or GitHub repo”) on a field that only runs **direct** `detectApp(url)` — GitHub repo success on the **primary** GitHub form depends on `githubCandidates`, not on the OpenAPI field. | `Tour.tsx` L171–172 vs `BuildPage.tsx` `handleOpenapiDetect` / `handleGithubDetect`. |
| R3 | **P1** | **“GitHub import” is not path 1 repo hosting** — it is still OpenAPI discovery + proxied ingest until `deploy-github` / hosted runtime ships. Users may think they opted into “Floom runs my code.” | `BuildPage.tsx` publish payload; `ROADMAP.md` L40; `PRODUCT.md` path 1 vs current UI. |
| R4 | **P2** | **Hero auto-detect** sends non-GitHub URLs through OpenAPI detect — appropriate technically, but **reinforces proxied/OpenAPI** for arbitrary pasted links (e.g. API doc pages). | `BuildPage.tsx` L73–80, L305–308. |
| R5 | **P2** | **Secrets complexity** on path 3: `deriveSecretsFromSpec` / per-op secrets are correct for operators, but ICP copy promises “secret injection” without surfacing **creator** secret configuration in this audit’s reviewed files for the simple OpenAPI paste flow (may exist elsewhere — not verified here). | `openapi-ingest.ts` L1383–1507, L1168–1228. |

---

## Open PM questions

1. Should the **first-run Tour** anchor the **GitHub** input and default-sample a **public repo** that succeeds via `runGithubDetect`, so onboarding aligns with PRODUCT path 1 narrative (even though implementation is still OpenAPI-under-the-hood until deploy-github exists)?

2. Should the **second tour sample** (GitHub repo URL) be removed or routed programmatically to the GitHub ramp so copy and behavior match?

3. When **path 1** (true repo hosting) ships, will OpenAPI-in-repo discovery remain a **bridge** or be **demoted** in UI to avoid two “GitHub” stories?

4. Is **non-GitHub `ingest_url`** (auto OpenAPI detect) the desired default for hero handoff, or should ambiguous URLs show a **chooser** (repo vs spec) before detect?

---

## Status

- **pd-04** complete for: PRODUCT path 3, `BuildPage` ramps + hero params, `openapi-ingest` overview + secrets model.  
- **Gap:** No `route-14-studio-build.md` UX artifact to cross-check.
