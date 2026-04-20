# Backend audit: shared types, adapter contracts, body/ids/email/log helpers

**Scope:** `apps/server/src/types.ts`, `apps/server/src/adapters/types.ts`, `apps/server/src/lib/body.ts`, `apps/server/src/lib/ids.ts`, `apps/server/src/lib/email.ts`, `apps/server/src/lib/log-stream.ts`.

**Product alignment:** Per `docs/PRODUCT.md`, Floom targets a non-developer ICP with three surfaces (web form `/p/:slug`, MCP `/mcp/app/:slug`, HTTP `/api/:slug/run`). These files underpin request parsing, persistence shapes, transactional email for auth, run log streaming, and stable IDs across runs, jobs, triggers, and Stripe. They do not implement hosting path 1 (`packages/runtime`, etc.) directly, but they define and carry the contracts the server uses while serving that product.

---

## `types.ts` — schema vs runtime reality

**Role:** Single TS source for DB row shapes (`AppRecord`, `RunRecord`, `JobRecord`, …), session payloads (`SessionContext`, `SessionMePayload`), manifest surface (`NormalizedManifest`, `ActionSpec`), and newer domains (triggers, Stripe, reviews, feedback).

**Contract drift vs routes and services**

- **SQLite → TS:** Columns evolve via migrations in `db.ts`; `types.ts` is updated by convention. There is **no mechanical link** (no codegen). A missed migration update yields **compile-time** drift only where a route still casts `as AppRecord`; optional fields (`RunRecord.workspace_id?`) paper over older DB snapshots.
- **Manifest:** `NormalizedManifest` is a **structural** contract. Routes (`routes/run.ts`, `routes/parse.ts`, services) still do `JSON.parse(row.manifest) as NormalizedManifest` with **no runtime validator**. Malformed or attacker-controlled manifest JSON can violate assumptions in `services/manifest.ts` until something throws deep in the stack.
- **Permissive index signatures:** `RenderConfig` and `ConnectionMetadata` allow `[key: string]: unknown`, which matches the product need to pass arbitrary renderer props but **weakens** static guarantees anywhere those types are trusted without narrowing.
- **`WorkspaceMemberRecord.role`:** Typed as `'admin' | 'editor' | 'viewer' | string`, so the union does not actually enforce the enum at compile time.

**Unsafe parsing (indirect)**

- This file does not parse HTTP bodies. It **does** document JSON-in-string columns (`manifest`, `inputs`, `outputs`, `payload` on turns). Callers are responsible for `JSON.parse` + validation; several paths assert with `as` only.

---

## `adapters/types.ts` — aspirational interfaces vs the reference server

**Role:** Declares `RuntimeAdapter`, `StorageAdapter`, `AuthAdapter`, `SecretsAdapter`, `ObservabilityAdapter` and shared result/filter types. File header states explicitly: **declarations only**; services do not `implements` these yet; semantics live in `spec/adapters.md`.

**Contract drift**

- **StorageAdapter surface is a subset of real persistence.** The live app uses raw `better-sqlite3` in `db.ts` plus many tables/operations **not** named on `StorageAdapter` (triggers, workspace invites, reviews, feedback, Stripe webhook ledger, Composio connections, app memory, etc.). Anyone treating this interface as “the full storage contract” will be misled.
- **Method names vs usage:** The reference code calls `db.prepare(...)` patterns, not `storage.getApp`. Drift is **intentional documentation lag** until a refactor lands — not a user-visible bug, but a **hazard for alternate implementations** that implement the file without reading `services/*` and `routes/*`.
- **RuntimeAdapter.execute** matches the mental model in `services/runner.ts` (docker vs proxied). `RuntimeResult` aligns with `updateRun` patches; comments about `detectSilentError` defer edge semantics to the spec — good cross-pointer.

**Conclusion:** Treat `adapters/types.ts` as **spec scaffolding**, not as enforced boundaries. `types.ts` is the shape truth for rows; `db.ts` + routes are the behavior truth.

---

## `lib/body.ts` — JSON parsing and route consistency

**Strengths**

- Distinguishes **empty/whitespace body** (ergonomic `{}`) from **non-whitespace that fails `JSON.parse`** (`malformed_json` → 400 with `code: 'invalid_body'`).
- Rejects **non-object** top-level JSON (`wrong_shape`), matching the stated invariant that handlers destructure object keys.
- `bodyParseError` returns a **stable JSON envelope** and does **not** echo the raw body to the client (reduces accidental secret exfiltration in broken JSON).

**Residual risks**

- **`parseMessage` in 400 responses:** `details.parse_message` can contain the engine’s parse error text. Usually benign; in theory unusually long or weird messages could bloat responses (minor DoS / log noise).
- **No size cap:** `c.req.text()` reads the **entire** body into a string. Very large bodies are a generic **memory/DoS** concern at the edge (not introduced here, but not mitigated here either).
- **Post-parse validation:** Success returns `Record<string, unknown>`. Every caller must still **validate fields**; the type system does not narrow.

**Adoption drift vs routes**

- **Uses `parseJsonBody` + `bodyParseError`:** `routes/run.ts` (POST `/api/run` and slug run), `routes/jobs.ts`.
- **Still uses `c.req.json()` without the strict helper:** e.g. `routes/hub.ts`, `routes/me_apps.ts`, `routes/triggers.ts`, `routes/workspaces.ts`, `routes/stripe.ts`, `routes/memory.ts`, `routes/connections.ts`, `routes/reviews.ts`, `routes/feedback.ts`, `routes/deploy-waitlist.ts` — malformed JSON on those paths **throws or surfaces as framework errors** rather than the uniform `invalid_body` contract (exact behavior depends on Hono and error middleware).
- **Legacy `catch(() => ({}))` pattern:** `routes/thread.ts` (`POST .../turn`), `routes/pick.ts`, `routes/parse.ts` — conflates “no body” with “broken JSON” exactly the anti-pattern `body.ts` documents; **silent `{}`** on truncate/invalid JSON.

---

## `lib/ids.ts` — ID generation

**Mechanism:** `nanoid` `customAlphabet` on a Crockford-like subset (no `i`, `l`, `o`, `u`), length **12**, prefixed identifiers (`app_`, `run_`, `job_`, …).

**Assessment**

- **Entropy:** 12 characters from ~32 symbols → sufficient for non-coordinated guessing in practice; **not** UUID-level namespace scale, but aligned with “opaque cursor” usage in URLs and DB primary keys.
- **Predictability:** Cryptographic-quality generation from `nanoid`; not sequential.
- **Collision:** Probability negligible at current scale; DB `PRIMARY KEY` still enforces uniqueness on conflict.
- **Product note:** Prefixes aid logs and support; they do not replace auth checks on `runs`, `jobs`, etc.

---

## `lib/email.ts` — injection and sensitive data handling

**HTML templates (`renderResetPasswordEmail`, `renderWelcomeEmail`)**

- **HTML context:** `escapeHtml` applied to **display name** and **URLs** embedded in HTML attributes and body copy — good baseline against HTML/script injection from stored names or crafted URLs.
- **Plain-text parts:** Greeting lines use **raw** `input.name` and raw `input.resetUrl` / constructed `buildUrl`. For normal Better Auth–supplied URLs this is acceptable; if a caller ever passed uncontrolled strings, **text/plain** does not execute markup but could still confuse clients or support staff reading raw `.eml` dumps.

**`sendEmail`**

- **`to` / `subject`:** Passed through to Resend’s API. In current wiring (`lib/better-auth.ts`), `to` is the verified user email from the auth layer — **not** an arbitrary public input path. `subject` is fixed per template for reset/welcome.
- **`RESEND_FROM`:** Operator-controlled. If mis-set to a string with newlines or odd characters, behavior depends on Resend validation — **low risk**, configuration footgun only.
- **Logging on failure / success paths:** Logs include **`to=`** and **`subject=`** (PII: email address). Stdout fallback logs the **full plaintext body**, including **password-reset links with secrets** — intentional for local dev (`RESEND_API_KEY` unset) but a **high PII / credential leak** if that mode is ever enabled on a shared log aggregator without scrubbing.

**Injection summary**

| Vector | Mitigation / state |
|--------|-------------------|
| HTML injection (name, URL) | Escaped in HTML branch of templates. |
| Header injection (SMTP) | API-based send; not raw SMTP headers from user input in current templates. |
| Log injection / operator visibility | Stdout mode prints full reset content — treat as **sensitive**. |

---

## `lib/log-stream.ts` — live logs, memory, and PII

**Behavior:** In-memory `Map` of `runId` → `{ lines, listeners, done, finishListeners }`. `append` pushes `{ stream, text, ts }` to all subscribers; `finish` marks done and deletes the map entry after **60s** if no listeners remain.

**Access control (route layer, not this file)**

- `GET /api/run/:id/stream` in `routes/run.ts` applies the **same ownership gate as GET `/api/run/:id`**, denies `is_public` shared viewers for the stream (comments note logs can leak inputs). **Good:** this module is dumb transport; authorization is correctly enforced upstream.

**PII and secrets**

- **Content:** Lines are **verbatim stdout/stderr** (or proxy trace) from the runtime. Buggy or malicious apps can print **env vars, tokens, or user data**. Those bytes flow to: (1) subscribers over SSE, (2) in-process history until GC, (3) ultimately **`runs.logs` in SQLite** via `runner.ts` — same sensitivity class as persisted logs, not introduced uniquely here.

**Operational risks**

- **Unbounded `lines` array per run:** There is **no line cap** or byte budget. A chatty container can grow process memory until OOM or until `finish` runs and listeners drain — a **availability / multi-tenant fairness** concern on shared hosts.
- **Retention:** After `finish`, late subscribers still call `getOrCreateStream` which can recreate state only if the entry was deleted; the 60s listener-empty cleanup limits **linger** time but does not cap per-run volume while the run is active.

---

## Summary table

| File | Contract drift | Parsing / safety | PII / injection |
|------|----------------|------------------|-----------------|
| `types.ts` | Row types vs migrations is manual; manifest not validated at boundary | N/A (types only) | N/A |
| `adapters/types.ts` | Storage surface << real `db` usage; intentional spec-only | N/A | N/A |
| `lib/body.ts` | Only some routes use strict parse; others throw or swallow | Strict JSON object rule; no raw body in 400; full read into RAM | `parse_message` only in JSON error |
| `lib/ids.ts` | N/A | Strong opaque IDs | None |
| `lib/email.ts` | Templates fixed; env `RESEND_FROM` | HTML escaped; plaintext less hardened | **Stdout fallback logs secrets**; logs include recipient email |
| `lib/log-stream.ts` | N/A | Unbounded buffer | **Raw runtime output**; access gated in `run.ts` |

---

## Recommendations (non-blocking)

1. **Gradually migrate** high-traffic or security-sensitive POST routes from `c.req.json()` / `catch(() => ({}))` to `parseJsonBody` for consistent **400 `invalid_body`** behavior (start with `thread`, `parse`, `pick` where silent `{}` is worst).
2. **Add a max body size** (or rely on reverse proxy limits) before `parseJsonBody` reads unbounded text.
3. **Cap `log-stream` history** per run (ring buffer or byte limit) and/or sample in extreme cases to protect the node.
4. **Redact or shorten** stdout email logging in production builds; document that `RESEND_API_KEY` unset is **unsafe for shared logs**.
5. When implementing `StorageAdapter` for real, **derive the method list from grep of `db.prepare`** (or generate from a single module) so `adapters/types.ts` cannot fall years behind.
