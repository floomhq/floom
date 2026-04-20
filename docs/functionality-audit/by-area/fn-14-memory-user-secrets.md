# Backend audit: per-user memory and secrets vault

**Scope:** `apps/server/src/routes/memory.ts` (HTTP routers for `/api/memory/*` and `/api/secrets/*`), `apps/server/src/services/app_memory.ts` (SQLite-backed JSON memory keyed by workspace, app, user), `apps/server/src/services/user_secrets.ts` (AES-256-GCM vault with workspace DEK + master KEK).

**Product alignment:** Per `docs/PRODUCT.md`, Floom targets users who need hosted execution with auth, rate limits, and secret injection across the three surfaces. Memory and the encrypted vault are tenant- and user-scoped persistence layers that support that story; they are not listed as isolated load-bearing paths in the PRODUCT table, but they underpin **secret injection** and **per-user state** for hosted apps.

---

## Workspace scoping

| Store | Primary key shape (logical) | Source of `workspace_id` / `user_id` |
|-------|-----------------------------|-------------------------------------|
| **App memory** | `(workspace_id, app_slug, user_id, key)` unique; `device_id` stored for rekey | `SessionContext` from `resolveUserContext` — all queries use `ctx.workspace_id` and `ctx.user_id`. |
| **User secrets** | `(workspace_id, user_id, key)` unique | Same `SessionContext`; no `app_slug` — vault is **per user per workspace**, not per app. |

**OSS vs cloud:** In OSS mode, `session.ts` synthesizes `workspace_id: 'local'` and `user_id: 'local'` plus a stable `device_id` cookie. In cloud mode, authenticated users get the active workspace from `user_active_workspace` / bootstrap and the Better Auth user id; `rekeyDevice` migrates anonymous `app_memory` rows from device-scoped anonymous state to the real user on first login.

**Encryption scope:** `user_secrets.ts` wraps a **per-workspace DEK** under `FLOOM_MASTER_KEY` (or `.floom-master-key`); ciphertext rows are tied to `workspace_id` at rest. `loadWorkspaceDek` throws if the workspace row is missing.

**Runner injection:** `app_memory.loadForRun` and `user_secrets.loadForRun` both take `SessionContext` and only return data for that workspace/user (memory additionally filters by declared keys; secrets by the requested key list — see below).

---

## Key allowlists

### Memory (`app_memory.ts`)

- **Write path (`get` / `set`):** Keys must appear in the app’s **`memory_keys` array inside the parsed manifest JSON** (`apps.manifest`). If the key is absent, **`MemoryKeyNotAllowedError`** is thrown (surfaced as HTTP 403 from POST with `code: memory_key_not_allowed` and `details.allowed`).
- **Manifest source:** `loadManifest` reads `SELECT manifest FROM apps WHERE slug = ?` and parses JSON; corrupt or missing manifest yields `null` → `memory_keys` defaults to `[]`, so **no key is allowed** for get/set.
- **`list`:** Does **not** re-check the manifest. It returns **all** rows for `(workspace_id, app_slug, user_id)` with parsed JSON values. Keys removed from `memory_keys` later can still appear until deleted.
- **`del`:** Explicitly **skips** manifest validation so users can remove stale keys after a manifest change.
- **`loadForRun`:** Only includes keys still present in `memory_keys`; stale DB keys are not injected.

### Secrets (`user_secrets.ts` + runner)

- **HTTP API (`POST /api/secrets`):** **No creator allowlist** at the vault layer. Any string `key` (1–128 chars) can be stored if validation passes.
- **Injection into runs:** `runner.ts` loads user vault values only for keys in **`manifest.secrets_needed`** that remain under the **`user_vault`** policy (vs creator overrides). Unrelated vault keys are not merged into the run secret bag — **manifest `secrets_needed` is the effective allowlist at execution time**.

---

## Decrypt errors

| Location | Behavior |
|----------|----------|
| **`SecretDecryptError` class** | Used for bad DEK unwrap, bad ciphertext shape, AES-GCM auth failure on decrypt, missing workspace row. |
| **`unwrapDek` / `decryptValue`** | Throw `SecretDecryptError` with messages that may include underlying crypto error text; DEK unwrap message hints at **`FLOOM_MASTER_KEY` mismatch**. |
| **`userSecrets.get`** | Propagates `decryptValue` errors to callers (no local catch). |
| **`userSecrets.set` → route** | `encryptValue` can throw `SecretDecryptError` (e.g. DEK load/unwrap). `memory.ts` maps **`instanceof SecretDecryptError`** to **500** with `code: secret_encrypt_failed` (name reflects encrypt path; underlying cause can still be unwrap/load). |
| **`userSecrets.loadForRun`** | **Swallows** per-row decrypt failures in a `try/catch` — failed rows are **skipped** so one bad row does not block runs; comment references rotation mistakes. **No logging** in that catch. |
| **`MasterKeyError`** | Thrown from `getMasterKey()` for wrong-length env/file key — not specialized in `memory.ts` POST handler; surfaces as generic `secret_set_failed` if not caught earlier. |

**Assessment:** HTTP write path distinguishes `SecretDecryptError` for a narrower response; **read paths that bulk-decrypt for runs intentionally omit failing secrets** rather than failing closed, which favors availability over strict “all or nothing” for bad rows.

---

## Size limits

| Surface | Limit | Notes |
|---------|--------|--------|
| **Memory keys** | `z.string().min(1).max(128)` | Route validation in `memory.ts`. |
| **Memory values** | **No explicit cap** in route or service | Stored as `JSON.stringify(value)`; very large payloads can bloat SQLite rows and responses on GET `list`. |
| **Secret keys** | `z.string().min(1).max(128)` | Same as memory keys. |
| **Secret values** | `z.string().min(1).max(65536)` (64 KiB) | Documented in schema comment as blocking accidental giant pastes before encryption. |

---

## Auth gates

| Route | `requireAuthenticatedInCloud` | Notes |
|-------|------------------------------|--------|
| `GET /api/memory/:app_slug` | **No** | Resolves context only; in cloud, unauthenticated users still receive the synthetic OSS-like `local`/`local` context per `session.ts` fallback, so behavior depends on how anonymous cloud sessions are treated elsewhere. |
| `POST /api/memory/:app_slug` | **Yes** | Anonymous cloud callers get **401** `auth_required`. |
| `DELETE /api/memory/:app_slug/:key` | **Yes** | Same. |
| `GET/POST/DELETE /api/secrets` | **Yes** | All mutations and listing require authenticated session in cloud. |

**Global auth:** `FLOOM_AUTH_TOKEN` middleware (when set) applies to `/api/*` broadly per `index.ts` — separate from cloud Better Auth.

**Assessment:** **Read listing of memory is less restricted than writes in cloud mode** (no `requireAuthenticatedInCloud` on GET memory). Secrets listing requires auth in cloud. Manifest key allowlist still applies to **set** even when authenticated.

---

## Summary

- **Scoping** is consistent: both stores key off `workspace_id` + `user_id`; secrets add envelope crypto per workspace. Runner paths filter memory and vault injection by **manifest** to avoid leaking undeclared keys into runs.
- **Allowlists:** Strict for **memory writes** (`memory_keys`); **secrets HTTP** accepts any key name — **run-time injection** is gated by **`secrets_needed`** (+ policy).
- **Decrypt handling** splits **strict errors** on crypto primitives vs **silent skip** in `loadForRun` for resilience.
- **Size:** 64 KiB cap on secret plaintext; **memory values are uncapped** at the API layer.
- **Auth:** Cloud mode requires Better Auth for **secrets** and for **memory mutations**; **GET memory** does not use the same gate.
