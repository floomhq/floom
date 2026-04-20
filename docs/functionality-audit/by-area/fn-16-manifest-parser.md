# Backend audit: manifest validation and AI parser (`apps/server/src/services/manifest.ts`, `apps/server/src/services/parser.ts`)

**Scope:** Server-side manifest normalization (declared), strict field validation for OpenAPI-backed shapes, per-run input coercion (`validateInputs`), and the natural-language → structured-input helper (`parsePrompt`) used by `POST /api/parse`.

**Product alignment:** Per `docs/PRODUCT.md`, manifests describe how the **three surfaces** (web form `/p/:slug`, MCP, HTTP `/api/:slug/run`) expose an app. The manifest ties **declared inputs/outputs** to execution; `parser.ts` serves the **low-friction “describe what you want”** UX when an API key is configured. Repo-path manifest handling also exists in `packages/manifest` (YAML, deploy pipeline); this audit is limited to the **server copies** named above.

---

## Normalization

### What `normalizeManifest` does

`normalizeManifest(raw)`:

- Requires top-level `name`, `description`, and `manifest_version` ∈ `{ "1.0", "2.0" }`.
- Validates **v1.0** as flat `inputs` / `outputs` arrays and folds them into a single action **`run`** with label `"Run"`.
- Validates **v2.0** via a non-empty `actions` map; action names must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`; each action has `inputs` / `outputs` arrays and optional string metadata (`description`, `secrets_needed`).
- Coerces **`runtime`** to `'python' | 'node'` (default `python`).
- Copies **`python_dependencies`**, **`node_dependencies`** (values must be strings), **`secrets_needed`**, **`apt_packages`**, optional **`license`** (non-empty trimmed string).

### Critical gap: normalizer is not on the ingestion path

`normalizeManifest` is **exported but never imported** elsewhere in this repository (only defined in `manifest.ts`). Stored app manifests are built by trusted pipelines (e.g. `specToManifest` in `openapi-ingest.ts`) or external processes, then persisted as JSON strings; **runtime routes parse with `JSON.parse(...)` as `NormalizedManifest`** without calling `normalizeManifest`.

**Implications:**

- **Schema drift:** `NormalizedManifest` in `apps/server/src/types.ts` includes fields **`memory_keys`, `blocked_reason`, `render`, `primary_action`** that **`normalizeManifest` does not produce or validate**. Those fields rely on ingest/UI paths and permissive parsing, not this function.
- **Integrity:** Any row in `apps.manifest` that is malformed relative to `normalizeManifest` rules is **not rejected at read time** unless a code path validates explicitly (today, mostly trust + `validateInputs` at run time).

---

## Validation

### `validateInput` / `validateOutput` / `validateAction` (inside `normalizeManifest`)

Used only when `normalizeManifest` runs: strong checks on **`type` enums**, enum **`options`**, required strings, and optional shapes. **`raw.default`** for inputs is assigned **without** validating against `type` (any JSON-serializable value can be stored).

### `validateInputs(action, rawInputs)` (exported; used on run/MCP/job paths)

- Iterates **only declared** `action.inputs`; **extra keys** in `rawInputs` are ignored (good for rejecting undeclared fields).
- **`number`:** Coerces via `Number(value)`; rejects NaN.
- **`enum`:** Requires a string present in `spec.options`.
- **`boolean`:** Uses **`Boolean(value)`**. Non-boolean truthy strings (including **`"false"`**) become **`true`** — incorrect for forms/API clients that send string booleans.
- **`text`, `textarea`, `url`, `date`, `file`:** Values pass through **without** type checks; nested objects or arrays can be forwarded if callers send JSON objects.
- **Requiredness:** Treats `undefined`, `null`, and **`''`** as missing; **`0` and `false`** are preserved (good for numbers/booleans).

### `parser.ts` / `POST /api/parse`

- Builds a compact schema summary (`schemaToPlain`) and sends it plus the user prompt to **OpenAI** (`PARSER_MODEL`, default `gpt-4o-mini`), requesting JSON `{ inputs, confidence, reasoning }`.
- **No call to `validateInputs`** on the returned `inputs`; the route returns LLM output **directly**. Types and enum membership are **not enforced** here.
- When **`OPENAI_API_KEY`** is unset, returns empty `inputs`, zero confidence, and an explanatory reasoning string (safe fallback).

---

## Unsafe or high-impact manifest fields

| Field / behavior | Risk |
|------------------|------|
| **`secrets_needed` / `actions.*.secrets_needed`** | Gate **secret requirements** for proxied runs. Validated as string arrays when `normalizeManifest` runs; if manifests are only `JSON.parse`d, **typos or unexpected names** could cause confusing runtime blocks or inconsistent UX vs. stored secrets. |
| **`node_dependencies` keys** | Arbitrary package names as object keys; safe in isolation but **supply-chain / typo** risk is operational, not sanitized here. |
| **`render` (`NormalizedManifest.render`)** | Typed as **`RenderConfig` with index signature `[key: string]: unknown`** — extra keys pass through to the **web client** for output rendering. Ingest controls this for OpenAPI apps; **any DB row** could carry arbitrary props; trust model is **creator-controlled manifest stored in DB** (same as other JSON columns). |
| **LLM parser** | User prompt is sent to a **third-party API** with **tool schema context** (labels, types, options). Not a traditional injection into Floom execution, but **data leaves the deployment**; failures are logged (`console.error`) without leaking full prompts in responses. |
| **`validateInputs` passthrough types** | Large or deeply nested JSON in “string” inputs could affect downstream **payload size**, logging, or worker behavior depending on runner usage. |

---

## Version compatibility

| Version | Shape | Normalization outcome |
|---------|--------|------------------------|
| **1.0** | Flat **`inputs`**, **`outputs`** | Single action **`run`**, label `"Run"`. Matches legacy single-action tooling. |
| **2.0** | **`actions`** map | Multi-action; **stable action names** required for URLs and MCP tool routing. |

- **Runtime default for v1:** `actionName` resolution in routes typically prefers `'run'` when present, else first key — consistent with folding v1 into `run`.
- **`normalizeManifest` vs stored data:** OpenAPI ingest emits **`manifest_version: '2.0'`** and populated **`actions`**. Older or hand-edited rows might omit fields the type allows (`memory_keys`, `render`, etc.) — **optional fields are additive** by design in `types.ts` comments.

### Relation to `packages/manifest`

The **deploy-from-repo** YAML manifest (`packages/manifest`) is a **separate parser** with its own schema and error collection. This server file is documented as a **trimmed port** of an older marketplace module — **two sources of truth** for “a manifest” depending on entry path (GitHub deploy vs hub/OpenAPI ingest). Aligning behavior (runtimes, allowed types) between them is a product/consistency concern, not enforced in one place today.

---

## Summary

**Strengths:** Clear v1→v2 story in `normalizeManifest`; strict structural validation when that function is used; `validateInputs` gives a single choke point for **`/api/run`, MCP, and jobs** with field-level `ManifestError`; AI parser degrades cleanly without API keys.

**Priority gaps:** (1) **`normalizeManifest` unused** — persisted manifests are not re-validated on read. (2) **Boolean coercion** via `Boolean(value)` is wrong for common string forms. (3) **`POST /api/parse`** skips **`validateInputs`**, so LLM output may not match schema. (4) **Type definition** includes fields (`render`, `primary_action`, …) **outside** the normalizer, increasing drift risk.
