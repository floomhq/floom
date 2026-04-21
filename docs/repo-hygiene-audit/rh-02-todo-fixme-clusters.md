# rh-02 — TODO / FIXME clusters

**Audit type:** Repo-hygiene (read-only).
**Source of truth:** `docs/PRODUCT.md`, `docs/ROADMAP.md`,
`docs/DEFERRED-UI.md` (the "paper trail" every deferred piece of UI is
expected to route through, per `api/client.ts` comments).
**Repo snapshot:** branch `docs/hygiene-and-docs-audit-2026-04-20`.

## Executive summary

The **canonical-marker** story is exceptionally clean: repo-wide there
are only **two `TODO` markers in source** and **zero `FIXME` / `XXX` /
`HACK` / `WORKAROUND` / `KLUDGE`** hits. That is unusual for a repo of
this size and is the direct result of a house style that moves
known-incomplete work into **prose comments pointing at
`docs/DEFERRED-UI.md`** and into **"Coming soon" UI affordances**
instead of leaving loose markers in code.

The **real cluster** is not in `TODO:` text — it is in "Coming soon" UI
copy and `/* deferred */` comments concentrated in two files:
`apps/web/src/pages/BuildPage.tsx` and `apps/web/src/pages/AppPermalinkPage.tsx`.
Both are **shipped to end users**; both carry visible placeholder
surfaces (Docker import, scheduling, one-click install, Connect-a-tool)
that `ROADMAP.md` either lists as P1 / P2 or does not list at all.
Combined with `DEFERRED-UI.md` already being **stale vs `main`** on
async jobs and custom renderer (flagged in
`docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:17,18`),
this is the cluster worth cleaning up before launch.

---

## Executive truth table

| # | Expectation (evidence) | Reality (evidence) | Verdict |
|---|------------------------|--------------------|---------|
| 1 | Source-level `TODO` / `FIXME` markers track unfinished work. Common expectation in every codebase. | Only **2** canonical-marker hits repo-wide: `apps/server/src/lib/rate-limit.ts:6` (`// TODO: swap for Redis`) and `packages/manifest/src/generate.ts:66` (`run: run ?? 'echo "TODO: set run command"'`). The second is **output** from the manifest generator, not a source marker. | **Met** (unusually clean) |
| 2 | Deferred UI is catalogued in `docs/DEFERRED-UI.md` — doc callouts in `apps/web/src/api/client.ts:445` and `:556` reference it explicitly. | `docs/DEFERRED-UI.md` exists (139 lines) but is **out of date** relative to `main` on async jobs and custom renderer — see `pd-19:17,18`. | **Partial / Drift** |
| 3 | "Coming soon" copy is used sparingly and each instance has a roadmap line. | `BuildPage.tsx` contains **10** occurrences of "coming soon"/"deferred"/"not yet"/"(soon)" markers; `AppPermalinkPage.tsx` contains **8**; `MeAppPage.tsx` contains **3**. `ROADMAP.md` does **not** enumerate every corresponding item. | **Drift** |
| 4 | Adapter interfaces are "deferred by design" per `spec/adapters.md`. | `apps/server/src/adapters/types.ts:12` confirms (*"IMPORTANT: these are DECLARATIONS ONLY…"*). Unambiguous. | **Met** (intentional) |
| 5 | Cloud / paid surfaces marked as "not yet" are gated off safely. | `apps/server/src/services/stripe-connect.ts:682,856` fail loud: *"Stripe account is not yet charges_enabled — finish onboarding first"*. Good pattern. | **Met** |
| 6 | Deferred backend-ready UI paths have doc anchors. | `apps/web/src/api/client.ts:445` (workspaces), `:556` (Composio connections), `apps/web/src/lib/types.ts:384` (ConnectionRecord) all cite `docs/DEFERRED-UI.md`. Consistent. | **Met** |
| 7 | `docs/ROADMAP.md` entries match "(soon)" copy seen in UI. | Examples: `BuildPage.tsx:1626` ("Docker import (coming soon)") not listed in ROADMAP P0/P1/P2 explicitly; `AppPermalinkPage.tsx:1822` ("Scheduling is coming soon") — scheduling is not a ROADMAP item either. | **Drift** |
| 8 | Better Auth deferred plugins (passkeys, multi-factor) should be visible in one place. | `apps/server/src/lib/better-auth.ts:15–19` lists them in code; `docs/ROADMAP.md` does not enumerate them. | **Partial** |

---

## Concrete findings

### 1. Canonical markers repo-wide (source only)

Running `rg -nE "\b(TODO|FIXME|XXX|HACK|WORKAROUND|KLUDGE|STUB|PLACEHOLDER)\b" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs'` with standard excludes returns only two hits:

- `apps/server/src/lib/rate-limit.ts:6` — *"single-replica preview.
  TODO: swap for Redis when Floom goes multi-replica."* Matches the P1
  narrative in `docs/PRODUCT.md` (single-box reference vs future
  cluster). Intentional.
- `packages/manifest/src/generate.ts:66` — `run: run ?? 'echo "TODO:
  set run command"'`. This is the **generated manifest's fallback
  value**, not a source marker. A regenerated manifest with no `run`
  specified will literally emit a shell command that prints
  `TODO: set run command` into the user's container. Consider
  upgrading the default to a clearer `echo "ERROR: manifest missing
  run command" && exit 1` so a broken generate step fails fast instead
  of booting into a stuck echo loop.

### 2. "Coming soon" clusters

File-level counts of `coming soon | deferred | not wired | not yet | (soon)`:

| File | Hits |
|------|------|
| `apps/web/src/pages/BuildPage.tsx` | **10** |
| `apps/web/src/pages/AppPermalinkPage.tsx` | **8** |
| `apps/web/src/pages/MeAppPage.tsx` | **3** |
| `apps/web/src/components/studio/StudioSidebar.tsx` | **1** (`Billing (soon)` at `:211`) |

Representative lines:

- `BuildPage.tsx:6–9` — header comment enumerates four **"coming
  soon"** build modes (Describe it, Connect a tool, Docker image).
- `BuildPage.tsx:682` — *"Works with any public repo. Private repos
  coming soon."*
- `BuildPage.tsx:897` — UI `<Tile badge="Coming soon" />` usage; also
  `:1626` *"Docker import (coming soon)"*.
- `AppPermalinkPage.tsx:1800` — *"One-click install is coming soon.
  For now, copy the MCP URL and paste it into your ChatGPT custom
  GPT"* (and mirror for Notion at `:1808`).
- `AppPermalinkPage.tsx:1822` — *"Scheduling is coming soon"*.
- `MeAppPage.tsx:233,236` — `aria-label={`${tab.label} (coming
  soon)`}` + `title="Coming soon"` for deferred tabs.

### 3. Deferred-UI paper trail is consistent but stale

Three files point contributors at `docs/DEFERRED-UI.md`:

- `apps/web/src/api/client.ts:445` — workspace switching UI.
- `apps/web/src/api/client.ts:556–557` — Composio OAuth connections
  UI.
- `apps/web/src/lib/types.ts:384–385` — `ConnectionRecord` type
  deferred *"with the connections UI"*.
- `apps/server/src/services/app_creator_secrets.ts:13` — *"See
  docs/DEFERRED-UI.md for the product model and routes/me_apps.ts"*.

`docs/DEFERRED-UI.md` is 139 lines long but **still says no async-jobs
UI on `main`** (contradiction flagged in
`docs/product-audit/deep/pd-19-roadmap-p0-execution-gap.md:17`) and
**still lists custom renderer UI as deferred**
(`pd-19-roadmap-p0-execution-gap.md:18`) despite
`apps/web/src/components/CustomRendererPanel.tsx` being wired into
`BuildPage.tsx`, `CreatorAppPage.tsx`, `StudioAppRendererPage.tsx`.

### 4. Declarative / research-driven deferrals

These are **intentional** and live-referenced in code:

- `apps/server/src/adapters/types.ts:12–19` — *"DECLARATIONS ONLY…
  deferred (YAGNI + launch risk)"* (see also rh-01 finding 6).
- `apps/server/src/lib/scoped.ts:4` — RLS deferred; single helper
  enforced "by convention + lint".
- `apps/server/src/lib/better-auth.ts:15–19` — passkeys, multi-factor
  deferred; traces to `better-auth-comparison.md`.

### 5. "Not yet" surfaces that fail loud (good examples)

- `apps/server/src/services/stripe-connect.ts:682,856` — both raise
  *"Stripe account is not yet charges_enabled — finish onboarding
  first"*. This is the pattern the rest of the deferred surfaces
  should copy (explicit error text, not invisible UI gaps).

### 6. `scripts/` / one-shot fixtures with `TODO`-adjacent copy

- `apps/server/scripts/audit-2026-04-18-renderer-test-desc.sh` (42
  lines): dated, single-purpose. Not a `TODO`, but effectively "should
  have been deleted after run" — see rh-04 for full inventory.

### 7. `packages/manifest` default text leaks into user containers

- `packages/manifest/src/generate.ts:66` — default `run:` literally
  contains the string `TODO: set run command`. If the CLI or server
  generates a manifest and the caller skips `run`, the emitted manifest
  will boot a container that prints `TODO: set run command` and
  keeps running until timeout. Low severity but user-facing.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| R1 | P1 | **"Coming soon" copy drifts ahead of `ROADMAP.md`** — end users see promises for Docker import, scheduling, one-click install that are not on the P0/P1 roadmap. | `apps/web/src/pages/BuildPage.tsx:897,1626`; `AppPermalinkPage.tsx:1800,1808,1822`; `docs/ROADMAP.md` missing lines |
| R2 | P1 | **`docs/DEFERRED-UI.md` contradicts shipped UI** (async jobs, custom renderer). External comms and internal planning diverge. | `docs/DEFERRED-UI.md`; `pd-19-roadmap-p0-execution-gap.md:17,18` |
| R3 | P2 | **Default manifest `run` prints `TODO`** into the container, which runs happily until timeout and wastes Docker minutes on broken apps. | `packages/manifest/src/generate.ts:66` |
| R4 | P2 | **Rate-limit single-replica caveat** is in-code but not in operator docs. Self-hosters scaling out will hit silent incorrect behavior. | `apps/server/src/lib/rate-limit.ts:6`; no mirror in `docs/SELF_HOST.md` |
| R5 | P2 | **Better Auth deferred plugin list** (passkeys, MFA) lives only in server comment — product/PM can't see it. | `apps/server/src/lib/better-auth.ts:15–19` |
| R6 | P2 | **"Not yet used (curated row)" pill text** in `ToolTile.tsx:25` has no ROADMAP anchor — soft promise without owner. | `apps/web/src/components/me/ToolTile.tsx:25` |

---

## Open PM questions

1. **`DEFERRED-UI.md` rewrite**: do we rewrite it from scratch against
   current `main` now, or wait for the roadmap pass that
   `pd-19-roadmap-p0-execution-gap.md` already captures?
   (`docs/DEFERRED-UI.md`, `pd-19:17,18`)
2. **"Coming soon" audit**: do we keep every current "coming soon" UI
   element (`Scheduling`, `Docker import`, `One-click install` for
   ChatGPT / Notion) — or remove the placeholders until they have a
   roadmap line? (`AppPermalinkPage.tsx:1800,1808,1822`,
   `BuildPage.tsx:897,1626`)
3. **`packages/manifest/src/generate.ts:66`**: is the default
   `run` command expected to be the user's responsibility (current
   behavior: prints `TODO: set run command`), or should generate fail
   loud when `run` is missing?
4. **`rate-limit.ts` Redis TODO**: schedule it against a ROADMAP P2
   milestone or mark "single-replica only" as a documented
   self-host limit?
5. **Better Auth deferred plugins**: do they get a ROADMAP entry or
   stay a server-side research note?
   (`apps/server/src/lib/better-auth.ts:15–19`)
6. **ToolTile "not yet used" pill**: is this meta / editorial surface
   (curator says "this is recommended but you haven't run it") or a
   hidden "coming soon"? Either way it needs a written meaning.
   (`apps/web/src/components/me/ToolTile.tsx:25`)
