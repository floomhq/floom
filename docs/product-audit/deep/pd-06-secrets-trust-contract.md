# pd-06: Secrets as product contract

**Audit type:** Deep product truth — secrets, trust, and “who owes what credential” across surfaces  
**Sources of truth:** `docs/PRODUCT.md` (ICP, core value, three surfaces)  
**Primary code / UI reviewed:**  
`apps/web/src/pages/MeAppSecretsPage.tsx`, `MeAppRunPage.tsx`, `apps/web/src/components/me/SecretsRequiredCard.tsx`, `apps/web/src/components/runner/OutputPanel.tsx`, `apps/server/src/routes/me_apps.ts`, `apps/server/src/services/runner.ts`, `apps/server/src/services/proxied-runner.ts`, `apps/server/src/services/openapi-ingest.ts`, `apps/server/src/services/app_creator_secrets.ts`, `apps/server/src/services/user_secrets.ts`  

**Cross-reference:** `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md`, `docs/ux-audit/by-route/route-12*.md`, `route-18*.md` — **not present in this workspace at audit time.** Overlapping intent is visible in-repo via: `SecretsRequiredCard.tsx` (comment: UX audit **R12-5**, 2026-04-20), `proxied-runner.ts` and `OutputPanel.tsx` (2026-04-20 error-taxonomy / dead-end fixes).  

**Snapshot note:** Behavior reflects repo state at audit time; aligns with `docs/product-audit/deep/INDEX.md` track **pd-06**.

---

## 1. Executive truth table (promise vs shipped)

| Promise / contract (from `PRODUCT.md` or implied by architecture) | Where it is stated or assumed | Observed reality (code + UX) | Status |
|------------------------------------------------------------------|-------------------------------|------------------------------|--------|
| **Core value:** Floom gives production hosting with **secret injection** (user does not run their own secrets manager) | `PRODUCT.md` §Core value proposition | Server merges global + per-app DB secrets, **creator overrides**, user vault, then MCP `_auth` (`runner.ts` dispatch precedence). Proxied path validates missing secrets before upstream fetch (`proxied-runner.ts`). | **Met** (server-side injection model is real) |
| **ICP** should not need to reason like an infra engineer about **where** secrets live | `PRODUCT.md` §ICP | Two mental models coexist: **manifest `secrets_needed`** (declared contract), **OpenAPI `security` / scheme names** (per-action `ActionSpec.secrets_needed`), **apps.yaml `secrets`** (operator-declared list copied to `manifest.secrets_needed`). Naming must line up or runs fail with `missing_secret`. | **Partial** |
| **Trust:** “What I paste is scoped, encrypted, not logged” | UI footers on Secrets / credentials card | Copy promises AES-256 at rest and runtime injection (`MeAppSecretsPage.tsx`, `SecretsRequiredCard.tsx`). Server comments note decrypt failures can be skipped silently for resilience (`user_secrets.ts`, `app_creator_secrets.ts`) — good for uptime, opaque for debugging. | **Partial** |
| **Creator vs end-user:** creator can supply shared secrets **or** delegate per-user vault | `MeAppSecretsPage.tsx` + `me_apps.ts` | Policies (`user_vault` / `creator_override`) + encrypted creator store + runner merge are coherent **on the server** (`runner.ts`, `me_apps.ts`). | **Met** (backend + creator Secrets UI) |
| **Same contract on all surfaces** (web form, MCP, HTTP) | `PRODUCT.md` §Three surfaces | Runner applies one merge path for dispatch; proxied runner documents MCP `_auth` in missing-secret help text. Web `/me/.../run` pre-flight uses **only** the user vault list (`useSecrets`), not policies — see §3. | **Contradicted** (web run gate vs server) |
| **Errors don’t send users to empty dead-ends** | Product trust / prior UX regressions | **401/403** with **zero** declared manifest secrets → `app_unavailable` (not “Open Secrets”) in `proxied-runner.ts`; `OutputPanel.tsx` mirrors with `app_unavailable` headline when declared secret count is 0. Empty submit on credentials card now sets form error (**R12-5** in `SecretsRequiredCard.tsx`). | **Met** (for that specific contradiction class) |

**Legend:** **Met** / **Partial** / **Missing** / **Contradicted** — same sense as `pd-01-icp-positioning-truth.md`.

---

## 2. End-to-end story for the ICP (happy path + who owes what)

**Persona:** Non-developer AI engineer; has a working prototype; wants “production” without learning secrets managers (`PRODUCT.md` §ICP).

### Path A — Consumer runs a **hosted** app (Docker / repo path) that declares `manifest.secrets_needed`

1. **Discover** app (hub, link, store).  
2. **Run** from `/me/apps/:slug/run` (authenticated “cloud” session per `PageShell`).  
3. **Client pre-flight:** `MeAppRunPage` loads `AppDetail` and `useSecrets()` entries. It treats **every** key in `manifest.secrets_needed` (or slug-specific `REQUIRED_SECRETS_OVERRIDE`) as required **in the user vault** unless already present in `secrets.entries` (`MeAppRunPage.tsx` `missingKeys` memo).  
4. If any keys missing → **`SecretsRequiredCard`**: paste values → `POST /api/secrets` per key → refresh → **`RunSurface`**.  
5. **Server run:** `dispatchRun` loads admin `secrets` rows, then for each manifest key applies **policy**: `creator_override` → `app_creator_secrets`; else → `user_secrets` for the **running** user; then MCP overrides (`runner.ts`). Final `secrets` map passed to worker is **filtered to names in `manifest.secrets_needed`**.  
6. **Outcome:** Container or worker receives env / injection as implemented by that path; user saw one coherent “credentials to run” story **if** step 3’s list matched what the server actually needs.

### Path B — Creator configures **Secrets** tab (`/me/apps/:slug/secrets` or Studio)

1. **Creator** sees every `manifest.secrets_needed` key with a **policy toggle**: “I provide for all users” vs “Each user provides their own” (`MeAppSecretsPage.tsx`).  
2. **API:** `GET/PUT .../secret-policies`, `PUT/DELETE .../creator-secrets/:key` (`me_apps.ts`). Keys not in manifest return `unknown_secret_key` (400). Non-owners cannot list policies (403) — non-creators do not learn which keys are creator-supplied.  
3. **Non-creator** view only lists `user_vault` keys; if all keys are creator-side, they see “nothing to set” (`MeAppSecretsPage.tsx`).  

### Path C — **Proxied** (OpenAPI) app

1. **Ingest:** `secretNames = appSpec.secrets || []` becomes **`manifest.secrets_needed`**; each action gets **`secrets_needed`** from OpenAPI effective security (`openapi-ingest.ts` `specToManifest` + `requiredSecretsForOperation`). Placeholder rows inserted into legacy `secrets` table for each configured name.  
2. **Run:** `runProxied` requires secrets **per action** when `actionSpec.secrets_needed` is set, else falls back to manifest-level list (`proxied-runner.ts`). **Auth headers** (`buildAuthHeaders`) use **heuristic** matching on secret names for bearer / apikey / basic / oauth2 client credentials (`proxied-runner.ts`).  
3. **Outcome:** Advanced path works when scheme names, `apps.yaml` secrets, and user/creator vault keys **align**; otherwise user sees `missing_secret` or upstream `auth_error` with taxonomy-aware UI.

---

## 3. Deadlock analysis (contradictions and circular traps)

### D1 — **Web `/run` gate ignores creator policy (P0 product deadlock)**

- **Server truth:** For keys under `creator_override`, the runner **does not** read the runner’s user vault for that key; it injects the creator’s ciphertext (`runner.ts` comments and merge).  
- **Web truth:** `MeAppRunPage` `missingKeys` = required manifest keys **minus keys present in `secrets.entries` only** — it does **not** call `getSecretPolicies` or subtract keys satisfied by creator (`MeAppRunPage.tsx`).  
- **Symptom:**  
  - **Creator** who chose “I provide for all users” and saved values can still see **“This app needs credentials to run”** and be asked to paste keys the product already has on the creator side.  
  - **End user** on an app whose secrets are all creator-supplied can still be blocked on `/run` with the same card, while the Secrets tab correctly says “The creator of this app supplies every required secret.”  
- **Escape hatches today:** Run from a surface that **bypasses** this client gate (e.g. direct HTTP/MCP if allowed), or put duplicate values into the user vault (defeats creator/privacy story).  
- **Classification:** **Contradiction** between **trust copy** (“creator supplies…”) and **activation gate** on Run.

### D2 — **Open Secrets” dead-end (mitigated for one class, not universal)**

- **Historical deadlock:** Upstream **401/403** + empty secrets list → UI said “Open Secrets” → Secrets page empty — **contradiction** (`proxied-runner.ts` comments; `OutputPanel.tsx` “downgrade” logic).  
- **Mitigation:** If `manifest.secrets_needed.length === 0`, proxied runner maps auth-like HTTP errors to **`app_unavailable`**; UI shows neutral unavailable state instead of routing to Secrets (`proxied-runner.ts`, `OutputPanel.tsx`).  
- **Residual:** If manifest **declares** secrets but upstream still returns 401 (wrong value, wrong scheme), user is steered to Secrets — **correct** only if the failure is actually fixable via vault. Creator misconfiguration can still look like “your credentials” when it is “wrong base URL / scheme.”

### D3 — **Two namespaces for “secret name” (integration deadlock)**

- **Manifest / vault keys:** Operator-declared `apps.yaml` `secrets` + user/creator vault use **string names** the app author chose.  
- **Per-action requirements:** Derived from OpenAPI **security scheme names** (`requiredSecretsForOperation` → `ActionSpec.secrets_needed`).  
- **Risk:** `manifest.secrets_needed` says `OPENAI_API_KEY` but action requires `BearerAuth` (example shape) → `missing_secret` lists scheme names that **do not appear** on the Secrets page rows (which enumerate manifest keys). **ICP** cannot self-resolve without reading OpenAPI + ingest rules.

### D4 — **Silent decrypt skip → “set” in UI but run still fails**

- **Vault UI:** Shows “set” from metadata, not plaintext.  
- **Server:** Decrypt failure can **skip** a key in `loadForRun` / creator load (`user_secrets.ts`, `app_creator_secrets.ts`).  
- **Symptom:** User believes credential is present; run fails with missing secret or upstream auth error. **No** inline link from run error to “re-paste / rotate encryption” story.

### D5 — **REQUIRED_SECRETS_OVERRIDE** (`MeAppRunPage.tsx`)

- Slug-specific override reduces “required” keys for **one** app vs long `secrets_needed` manifest (documented for `ig-nano-scout`).  
- **Contract drift:** Only the Run page uses this; MCP/HTTP/other clients may still enforce the full manifest unless they duplicate logic — **surface parity** risk (`PRODUCT.md` three surfaces).

---

## 4. Truth table — “Who must have set what before a successful run?”

Rows are **logical** combinations; “Injected?” means the worker receives a non-empty value for that key **when** policy and stores cooperate.

| Role | Policy for key K | Creator stored value? | User vault value? | `secrets` table (admin)? | MCP `_auth` for this call? | Injected at run? (expected) | `/me/.../run` client gate (missingKeys) |
|------|------------------|-------------------------|---------------------|---------------------------|-----------------------------|-----------------------------|----------------------------------------|
| End user | `user_vault` | n/a | Yes | optional | optional | Yes | Pass |
| End user | `user_vault` | n/a | No | Yes | optional | Yes if key in manifest + admin row | **Fail** (user vault missing) |
| End user | `creator_override` | Yes | No | optional | optional | Yes (server) | **Fail** (D1 — user vault missing) |
| End user | `creator_override` | No | No | optional | optional | No → missing / auth failure | **Fail** |
| Creator (self) | `creator_override` | Yes | No | optional | optional | Yes (server) | **Fail** (D1) |
| Creator | `user_vault` | n/a | Yes | optional | optional | Yes | Pass |
| Anyone | any | any | any | any | Yes (covers K) | Yes for that call | Pass only if user also saved K in vault **or** K appears in `entries` from prior save |

**Reading:** The last column is the **product** bottleneck for trust: the web Run gate is **not** equivalent to the server’s injection predicate.

---

## 5. Risk register (launch-oriented)

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| S-01 | **P0** | **/me Run pre-flight contradicts creator-override contract** | `MeAppRunPage.tsx` (`missingKeys` vs `useSecrets`); `runner.ts` policy merge | Creators and end users stuck on credentials card though app is configured; support burden; “broken product” perception |
| S-02 | **P0** | **OpenAPI scheme names vs `apps.yaml` secret names** can desync | `openapi-ingest.ts` (`secretNames`, `ActionSpec.secrets_needed`); `proxied-runner.ts` missing check | `missing_secret` lists keys users cannot find on Secrets UI; ICP abandonment |
| S-03 | **P1** | **Bearer/apiKey auth header heuristics** pick “wrong” secret when multiple keys exist | `buildAuthHeaders` in `proxied-runner.ts` | Subtle production bugs; “Floom broke my API” when order of secrets changes |
| S-04 | **P1** | **Silent decrypt skip** vs “set” badge | `user_secrets.ts` `loadForRun`; `app_creator_secrets.ts` `loadCreatorSecretsForRun` | Long debug loops; trust erosion |
| S-05 | **P1** | **Surface parity:** Run page override / policy awareness **not** shared with MCP/HTTP clients | `REQUIRED_SECRETS_OVERRIDE` in `MeAppRunPage.tsx` only | Same app “works in UI” vs “fails in agent” or vice versa |
| S-06 | **P2** | **Legacy `secrets` table placeholders** from ingest (`openapi-ingest.ts` insert loop) vs encrypted vaults — two storage stories | `ingestOpenApiApps` + `runner.ts` merge | Operator confusion about “empty rows” vs user vault |
| S-07 | **P2** | **Missing UX audit artifacts** in repo | Requested `LAUNCH-UX-AUDIT-2026-04-20.md`, route-12/18 not found | Cannot trace remaining launch UX debt to written acceptance criteria from this workspace alone |

---

## 6. PM questions (owner decisions)

1. **Should `/me/apps/:slug/run` treat “satisfied by creator_override + stored value” as non-missing** (fetch policies or a dedicated “run readiness” API), so the web gate matches `runner.ts`?  
2. **Should non-creators ever see `/run` credentials UI** for keys that are creator-only, or should Run link straight to RunSurface when the server reports “no user-vault keys required”?  
3. **Canonical secret naming for proxied apps:** Is the contract “always OpenAPI scheme name,” “always operator-defined env name,” or do we **require** an explicit mapping in `apps.yaml` when those differ?  
4. **When upstream returns 401** and manifest secrets are non-empty, how do we distinguish **user wrong key** vs **creator wrong creator_override** vs **wrong security scheme** — and should the UI say which?  
5. **Do we want decrypt failures to surface** as a first-class vault health state (vs silent skip) for keys declared in `secrets_needed`?  
6. **Is `REQUIRED_SECRETS_OVERRIDE` a temporary hack** — if so, what is the **manifest-level** replacement so all three surfaces share one required-set definition?  
7. **Trust comms:** Are “never logged” guarantees accurate for **all** log levels / self-hosted operators / upstream error body capture — and where should a short **honest** limitations blurb live (footer vs docs)?  

---

## 7. Appendix — quick code map (for reviewers)

| Concern | Primary location |
|---------|------------------|
| Manifest `secrets_needed` from apps.yaml | `openapi-ingest.ts` (`secretNames = appSpec.secrets \|\| []`, `specToManifest` return `secrets_needed: secretNames`) |
| Per-action OpenAPI security | `openapi-ingest.ts` (`requiredSecretsForOperation`, `actions[name].secrets_needed`) |
| Proxied missing-secret check + auth error taxonomy | `proxied-runner.ts` |
| Policy + merge order | `runner.ts` `dispatchRun`; `app_creator_secrets.ts`; `user_secrets.ts` |
| Creator HTTP API | `me_apps.ts` |
| Creator / viewer Secrets UI | `MeAppSecretsPage.tsx` |
| Run gate + override | `MeAppRunPage.tsx` |
| Credentials card validation | `SecretsRequiredCard.tsx` (R12-5 empty submit) |
| Error UX / Open Secrets routing | `OutputPanel.tsx` |
