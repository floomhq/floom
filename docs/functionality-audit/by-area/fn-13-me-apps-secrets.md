# Backend audit: creator apps + creator secrets (`routes/me_apps.ts`, `services/app_creator_secrets.ts`)

**Scope:** HTTP surface under `/api/me/apps/:slug/...` for per-app secret policy and creator-owned override values: `GET`/`PUT` secret policies, `PUT`/`DELETE` creator secrets. Service layer: SQLite-backed policy rows, encrypted creator values, and runner-facing loaders. Runner consumption is referenced but primary review here is routes + `app_creator_secrets.ts`.

**Product alignment:** Per `docs/PRODUCT.md`, secret injection supports the hosted execution story (ICP gets production without managing a secrets manager). This path is **creator-only** configuration; end users still use the user vault elsewhere. It aligns with the three surfaces indirectly (runner injects env), not by exposing new public endpoints.

---

## Owner checks

**What exists**

- **Cloud gate:** All handlers call `requireAuthenticatedInCloud` after `resolveUserContext`, so anonymous sessions cannot mutate or read this surface in cloud mode (`401` with `code: auth_required`).
- **Author match:** `isOwner` returns true when `app.author === ctx.user_id`, or in OSS-style contexts when the synthetic local workspace/user applies (`!ctx.is_authenticated && ctx.workspace_id === 'local'` with `app.workspace_id === 'local'` or `!app.author`).
- **Per-route owner enforcement:** After loading the app by slug, every route checks `isOwner` and returns `403` with `code: not_owner` when it fails (except where visibility short-circuits first; see below).

**Gaps / inconsistencies**

- **`GET /:slug/secret-policies` applies `checkAppVisibility` before `isOwner`.** For `visibility === 'private'`, a non-owner receives **`404` `not_found`** (same as unknown slug), so existence of the app is not implied. **Write routes (`PUT` secret-policies, `PUT`/`DELETE` creator-secrets) do not call `checkAppVisibility`.** A signed-in user who is not the author but guesses a slug gets **`403` `not_owner`**, which **confirms that an app row exists for that slug**—weaker than the read path’s privacy story in `lib/auth.ts` (private apps are supposed to deny without leaking existence on other surfaces).
- **`loadApp` uses `SELECT *` by slug with no workspace scoping in the query.** Ownership is enforced in application logic; if two rows could ever share a slug (schema should forbid it), behavior would be ambiguous. Normal schema expectation is unique slug; worth treating as **assumption**, not a second defense layer.

---

## Policy mutations

**Route-level validation (`PUT /secret-policies/:key`)**

- Key must appear in `manifest.secrets_needed` (parsed JSON from `app.manifest`); unknown keys → `400` `unknown_secret_key`.
- Body validated with Zod: `policy` ∈ `user_vault` | `creator_override`.
- **No visibility gate** on this handler (see owner checks).

**Service layer (`setPolicy`)**

- Upserts into `app_secret_policies` with `ON CONFLICT (app_id, key) DO UPDATE`; timestamps `updated_at`.
- **Does not** validate keys against the manifest (documented: tests and future admin tooling). **Authorization and manifest checks are entirely the caller’s responsibility**—correct for `me_apps` today; any new internal caller must replicate the route’s `secrets_needed` check or risk orphan policy rows.

**Semantics**

- Comments and code match: switching `creator_override` → `user_vault` does **not** delete `app_creator_secrets` rows; the stored ciphertext can remain until explicitly deleted or overwritten when policy flips back. Policy row persists on `DELETE` of creator secret—intended so the creator’s policy choice survives clearing the value.

**Runner alignment**

- `loadCreatorSecretsForRun` intersects requested keys with keys that have an explicit `creator_override` policy row; default missing policy is `user_vault` at read time (`getPolicy`). Consistent with route defaults on `GET`.

---

## Encryption at rest

**Storage model**

- **`app_creator_secrets`:** `ciphertext`, `nonce`, `auth_tag` (hex strings), plus `workspace_id` on the row. **No plaintext in SQLite** for creator overrides.
- **Algorithm:** Reuses `encryptValue` / `decryptValue` from `services/user_secrets.ts`: **AES-256-GCM** with a per-workspace DEK from `workspaces.wrapped_dek` (envelope with `FLOOM_MASTER_KEY` / `unwrapDek` as implemented there—same stack as the user vault).

**Write path**

- `setCreatorSecret(app_id, workspace_id, key, plaintext)` encrypts with `encryptValue(workspace_id, plaintext)` where `workspace_id` passed from the route is `app.workspace_id || ctx.workspace_id`. Aligns encryption with the **app’s workspace** (creator workspace), not the runner’s caller.

**Read path (runner)**

- `loadCreatorSecretsForRun` decrypts using `row.workspace_id || workspace_id` for legacy tolerance; **wrong DEK yields `SecretDecryptError`**, which is **swallowed per key** so one bad rotation does not block the whole run—same operational trade-off as user secrets, with the documented downside that failure is **silent** until the creator hits the UI again.

**Assessment:** **At-rest confidentiality** for creator override values matches the **user vault envelope**; threats are primarily **key management** (master key, DB file access) rather than missing application-layer crypto for this table.

---

## Leakage via API shapes

**Intentional non-leakage**

- **No plaintext** of creator secrets is returned by these routes. Success bodies are `{ ok, policy }`, `{ ok, key }`, `{ ok, removed }`, or policy listings without secret material.
- **`creator_has_value` / presence:** The API exposes **boolean presence** per key (and `updated_at` on explicit policy rows via `listPolicies`). That is **necessary for the creator UX** (know whether to prompt for a value) and is scoped to **owners** on `GET`—but see visibility inconsistency on writes.

**Possible information edges**

- **Private slug discovery:** Write routes returning **`403` `not_owner`** vs **`404` `not_found`** for missing slug—attackers with accounts can distinguish “exists but not mine” from “no row,” **only for apps they can address by slug**. `GET` is stricter for `private`.
- **Default `user_vault` branch still calls `hasCreatorValue`:** If stale ciphertext exists while policy defaults to `user_vault`, **`creator_has_value` may still be `true`**, revealing dormant storage to the owner (injection remains gated by policy). Low severity; cleanup is policy/UX, not cross-tenant leak.
- **`listPolicies` keys vs manifest:** `GET` merges `manifest.secrets_needed` with DB; **policy rows for keys not in `secrets_needed` do not appear** in the JSON—orphan rows are hidden from this response (not deleted).
- **500 responses:** `setPolicy` and generic catch blocks return **`(err as Error).message`** to clients. If internal errors ever include sensitive fragments, this would be **verbose error leakage**—tighten or map to stable codes if that becomes observable.

---

## Summary

| Area | Verdict |
|------|---------|
| **Owner checks** | Strong **author/workspace** checks for authenticated cloud users; OSS solo path documented. **Mismatch:** `checkAppVisibility` on **`GET` only** weakens **private-app** confidentiality of slug existence on **mutations**. |
| **Policy mutations** | Manifest-scoped keys on HTTP; service layer intentionally generic; SQLite upsert is clear. |
| **Encryption at rest** | **AES-GCM under workspace DEK**, consistent with `user_secrets`; runner decrypt behavior matches operational expectations. |
| **API leakage** | No secret plaintext; presence flags are deliberate; main **shape issue** is **`403` vs `404`** for private apps on write paths, plus optional **error message** hardening on 500. |
