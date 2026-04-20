# fn-15 — OpenAPI ingest and DB seed (`openapi-ingest`, `seed`)

**Scope (workspace root `apps/server/src/`):** `services/openapi-ingest.ts`, `services/seed.ts`.

**Product lens (`docs/PRODUCT.md`):** OpenAPI → proxied is the **third** deployment path (advanced). It must still converge on the same three surfaces (web form, MCP, HTTP). `seed.ts` backs **path 2** demo data when operators opt in; both files are on load-bearing paths for self-host and hub population—**fix, do not delete casually** per the PRODUCT table (`services/seed.ts`, runner stack).

---

## Summary

| Area | Verdict |
|------|---------|
| `secrets_needed` vs `apps.yaml` | **Split model:** file ingest uses **YAML `secrets` only** for manifest-level `secrets_needed`; per-action lists come from **OpenAPI `security`**. Hub/URL ingest uses **`deriveSecretsFromSpec`** for manifest-level. Easy to end up with **empty top-level** `secrets_needed` while actions still require schemes—known tension with Studio / pre-flight UX (see `docs/ux-audit/`). |
| Truncation | **Bounded and explicit:** `FLOOM_MAX_ACTIONS_PER_APP` (default **200**, **0** = unlimited). Operations sorted by `operationSortScore` then cut; **warn** logs total vs cap. `deriveSecretsFromSpec` still scans **all** operations (not truncated list). |
| SSRF on spec fetch | **High concern** for any deployment where **untrusted** users or configs supply URLs or specs: `fetch` has **no allowlist**; YAML path does not require `http(s)`; **`$RefParser.dereference`** can follow **remote `$ref`** fetches in addition to the primary spec URL. |
| Seed idempotency | **Insert-only for apps** (existing slugs skip manifest refresh). **Secrets:** `INSERT OR IGNORE` — **no value updates** on re-run; unique on `(name, COALESCE(app_id,'__global__'))`. |
| DB writes | Ingest: upsert `apps` + placeholder `secrets` (empty values) for YAML-declared names; large **`openapi_spec_cached`** JSON. Hub ingest path **does not** insert `secrets` rows. Seed: transactional batch; apps unchanged if slug exists. |

---

## `secrets_needed` derivation vs `apps.yaml`

### File-based ingest: `ingestOpenApiApps(configPath)`

- Config is YAML/JSON with top-level `apps: OpenApiAppSpec[]` (the repo’s `apps.yaml` pattern). Each entry may include **`secrets?: string[]`** (`OpenApiAppSpec`).
- **Manifest-level** `secrets_needed` is **`secretNames` passed straight through** to `specToManifest` — i.e. **`appSpec.secrets || []` only**. There is **no** merge with `deriveSecretsFromSpec` on this path.
- **Per-action** `actions[*].secrets_needed` is computed per operation via **`requiredSecretsForOperation`**, which:
  - Respects OpenAPI 3 **operation-level `security` replacing global** (including `security: []` for public ops).
  - ORs alternatives in the `security` array, ANDs scheme names **within** each requirement object, then intersects across alternatives so only **strictly required** scheme names remain.
  - Emits only **`apiKey`** and **`http` + `scheme: bearer`** schemes (`schemeRequiresSecret`). OAuth2, HTTP basic, etc. are **not** auto-listed (comments: OAuth out-of-band; basic left for explicit YAML declaration).

**Implication:** Operators who rely only on the OpenAPI document for security and omit **`secrets:`** in `apps.yaml` get **`manifest.secrets_needed: []`** at the top level while some actions may still list non-empty `secrets_needed`. The **proxied runner** prefers per-action `secrets_needed` when set (`proxied-runner.ts`), so runtime can still enforce secrets; **MCP / Studio / `me_apps` helpers** that key off **top-level** `manifest.secrets_needed` can **under-declare** (documented UX risk elsewhere).

### Hub / preview paths: `detectAppFromUrl`, `ingestAppFromSpec`

- Build a synthetic `OpenApiAppSpec` with **`auth: 'none'`** and pass **`deriveSecretsFromSpec(derefed)`** into `specToManifest` for manifest-level `secrets_needed`.
- **`deriveSecretsFromSpec`** unions `requiredSecretsForOperation` across **every** method on **every** path in `spec.paths` (independent of action truncation order in `specToManifest`).

**Cross-path inconsistency:** Same spec ingested via **apps.yaml** vs **hub URL** can yield **different manifest-level** `secrets_needed` unless YAML **`secrets`** is kept in sync with what `deriveSecretsFromSpec` would produce.

---

## Truncation (`specToManifest`)

- Cap from **`FLOOM_MAX_ACTIONS_PER_APP`**; unset or invalid → **200**. **`0`** disables the cap (intended for very large specs, e.g. Stripe/GitHub).
- Operations are collected, sorted by **`operationSortScore`** (deprioritizes health-style GETs, favors POSTs), then emitted until the cap.
- When truncated, **`console.warn`** includes slug, cap, and **total operation count** in the spec—actionable for operators.
- **Truncated operations disappear** from `manifest.actions`; anything that assumes “every path in the spec has a tool” will be wrong past the cap.
- **Secrets:** Per-action secrets only exist for **included** actions. Manifest-level `secrets_needed` from **`deriveSecretsFromSpec`** can still name schemes required by **dropped** operations (URL/hub path), which can look like “extra” keys in the UI; YAML path can instead show **empty** top-level keys while dropped ops had requirements—both are edge cases worth QA matrix coverage.

---

## SSRF and untrusted URL handling

### `fetchSpec(url)`

- Uses global **`fetch(url)`** with **`AbortSignal.timeout(30_000)`** and an `Accept` header. No documented redirect limit or IP blocklist.
- **`ingestOpenApiApps`:** `openapi_spec_url` is used **without** a scheme check—**non-http(s)** schemes could be attempted depending on runtime `fetch` behavior.
- **`ingestAppFromUrl`:** rejects URLs that do not match **`^https?:\/\/`** — **relative** SSRF vectors are reduced for that entrypoint only, but **`http://169.254.169.254`**, internal hostnames, and metadata URLs remain **valid** unless blocked elsewhere.

### `dereferenceSpec` (`@apidevtools/json-schema-ref-parser`)

- Dereferences **`$ref`** on a JSON-cloned spec with **`circular: 'ignore'`**. Remote references in real-world specs are common; resolution typically performs **additional HTTP(S) fetches** to whatever host appears in `$ref`, which is a **second SSRF surface** even when the primary `openapi_spec_url` is benign.
- On failure, logs a warning and returns the **raw** spec (degraded manifest, no throw).

### `resolveBaseUrl`

- Derives runtime base URL from **`apps.yaml` `base_url`**, `servers[]`, Swagger 2 `host`/`basePath`, or spec-fetch origin. This shapes **where proxied traffic is sent** at runtime; it is not the same class as server-side fetch SSRF but matters for **open redirects / wrong-backend** if specs are attacker-controlled.

**Operator guidance:** Treat OpenAPI ingest as **trusted config** unless hardened (allowlisted spec hosts, disable remote `$ref` resolution, or run ingest in a network-isolated job).

---

## `seed.ts` — idempotency and DB writes

### Gating

- **`FLOOM_SEED_APPS`** must be truthy (`1|true|yes|on`, case-insensitive). Default: **off** — logs that the hub starts empty and **`apps.yaml`** is the normal registration path (`PRODUCT.md` path 2 vs operator workflow).

### `findSeedFile`

- Tries several relative paths (`db/seed.json` next to compiled `services`, cwd variants). Returns `null` if missing → **no-op** with zero counts.

### Apps

- **`SELECT id FROM apps WHERE slug = ?`**. If **no row**: **`INSERT`** full row (`docker_image`, `code_path` placeholder, manifest JSON from file). If **row exists**: **reuse `id`**, **do not UPDATE** name/description/manifest/docker fields.
- **Idempotency:** Re-running seed **never refreshes** an existing app’s manifest or metadata—only adds missing slugs.

### Secrets

- **`per_app_secrets[slug]`** and **`global_secrets`**: each pair uses **`INSERT OR IGNORE`** with **`newSecretId()`** each time.
- Unique index **`idx_secrets_unique ON secrets(name, COALESCE(app_id, '__global__'))`** (`db.ts`): duplicates are ignored.
- **Idempotency:** First successful insert wins; **changing values in `seed.json` does not update** existing rows. Counts `secrets_added` only when `result.changes > 0`.

### Transaction

- Entire seed loop runs inside **`db.transaction(() => { ... })()`** — all-or-nothing for the batch (SQLite transaction).

---

## `openapi-ingest.ts` — DB writes (ingest paths)

### `ingestOpenApiApps`

- **Upsert by slug:** `existsBySlug` → **`UPDATE apps`** or **`INSERT`**, including **`manifest`** (stringified), **`openapi_spec_cached`** (full **dereferenced** spec JSON—can be **very large**), **`base_url`**, auth fields, async fields, visibility, etc.
- **Secrets:** For each name in **`appSpec.secrets`**, **`INSERT OR IGNORE`** placeholder rows with **empty string `value`** for the app id (so the UI can show required keys). Does **not** remove stale secret names removed from YAML.
- **Fetch failure:** If `openapi_spec_url` fetch throws, code logs and continues with an **empty spec** `{}` — ingest still writes DB rows; manifest may be generic **`call`** action only until spec is fixed.
- **Per-app error isolation:** `try/catch` per app; failures increment **`apps_failed`** and collect **`errors[]`**. There is **no single DB transaction wrapping** update + secret inserts for one app (typical boot is single-threaded; partial state on mid-loop crash is theoretically possible).

### `ingestAppFromSpec` / `ingestAppFromUrl`

- Upserts **`apps`** for proxied hub apps; sets **`workspace_id`**, **`author`**, clears async fields on update path; **does not** insert into **`secrets`** (creators add credentials via vault / studio flows).

### Side effects (non-DB)

- **Custom renderer:** `bundleRendererFromManifest` may run **`void`** (fire-and-forget); comments state bundles are **not** stored in DB—disk / in-memory index.

---

## Cross-cutting notes

- **ICP / trust:** Path 3 users paste URLs; without network controls, a malicious URL or spec can turn the **ingest process** into an internal port scanner or metadata exfil channel—this is **operator-trust** territory, not end-user-safe multi-tenant ingest as-is.
- **Alignment with PRODUCT:** OpenAPI wrapping remains **advanced**; correctness of **`secrets_needed`** at both levels affects whether the **three surfaces** advertise and enforce the same auth story as the upstream API.

---

## Suggested follow-ups (non-blocking)

1. **Unify manifest-level `secrets_needed`** for YAML ingest: optionally merge **`deriveSecretsFromSpec`** with explicit **`secrets`** (union), or document that **`secrets` is mandatory** for hub parity when using OpenAPI security.
2. **SSRF:** Allowlist hosts for `fetchSpec` + ref parser, or disable remote dereference in untrusted contexts.
3. **Seed:** If operators need “refresh from seed.json”, add an explicit **`UPDATE`** path or a separate `FLOOM_SEED_RESET` danger flag—never silent overwrite without policy.
