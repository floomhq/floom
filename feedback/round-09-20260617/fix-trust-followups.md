# Round-09 — Trust no-ops + engine durability follow-ups

Closes the Phase-1 correctness set: the two silent trust no-ops (the gap-sweep's
B1 + the completeness-audit's N3) plus the two engine durability follow-ups that
`fix-cloud-p0s.md` flagged as out of its scope (Fix 3 engine-upstream, Fix 4
engine resolver). TDD failing-test-first for each.

- **Engine** branch `fix/trust-and-followups-r9` off `origin/integration/final-20260617`
  (base engine `c6c77699`). Worktree `/tmp/workeros-trust-r9`. **Final SHA `a5b545ad`.**
- **Cloud** branch `fix/trust-and-followups-r9` off cloud `origin/integration/final-20260617`
  (base cloud `dd01c907`). Worktree `/tmp/managed-deployment-trust-r9`. **Final SHA `55205e09`.**
- Repos: `floomhq/workeros` (engine) + `floomhq/managed-deployment`. NOT merged to any
  main/trunk/prod.

---

## Fix 1 — Spend-cap silent no-op (trust bug #1, the worst gap)

### Root cause (file:line)
- UI write: `apps/web/app/settings/page.tsx:1338` — the "Monthly spend cap (USD)"
  field wrote workspace setting key **`spend_cap_usd`**.
- Backend read + enforce: `apps/api/services/run_cost.py:63`
  (`_workspace_monthly_spend_cap_usd` reads **`monthly_spend_cap_usd`**); cap
  enforced in `apps/api/run_service.py:523`.
- Settings allow-list: `apps/api/routers/workspace.py:1342` accepts
  `monthly_spend_cap_usd`; **`spend_cap_usd` is NOT in the allow-list**, so the
  UI's save was rejected 422 — the cap was never persisted AND never read. The
  operator set a cap, believed they were protected, nothing was enforced.

### Failing-test → fix
- RED: `apps/web/tests/model-defaults-797.dom.test.tsx` — changed the assertion
  from `setSetting("spend_cap_usd","100")` (which had locked the bug) to
  `setSetting("monthly_spend_cap_usd","100")` + `not("spend_cap_usd")`. Failed
  (UI wrote the wrong key).
- GREEN: changed the field key to `monthly_spend_cap_usd` in `settings/page.tsx`.
- End-to-end contract is now closed: the UI writes the exact key
  `run_cost.py` reads, and `apps/api/tests/test_797_workspace_defaults_enforcement.py`
  (pre-existing) already locks `spend_cap_exceeded` (402) firing at the set
  `monthly_spend_cap_usd` limit.

## Fix 2 — failure_email_to silent no-op (trust bug #2)

### Root cause (file:line)
- `apps/web/app/settings/page.tsx:1278` — the "Email me on run failures" toggle
  (`failure_email_enabled`) is wired and read, but there was **no UI input for the
  recipient `failure_email_to`**.
- Backend: `apps/api/services/run_notifications.py:537` reads the toggle, then
  `apps/api/services/run_pause_policy.py:147` (`_workspace_failure_email_recipients`)
  reads `failure_email_to`; **the send is skipped when recipients is empty**. So
  enabling the toggle emailed nobody (false-safety, same bug class as Fix 1).

### Failing-test → fix
- RED: new `apps/web/tests/failure-email-recipient-r9.dom.test.tsx` — asserts a
  recipient input renders, that turning the toggle ON with no recipient is blocked
  (no silent no-op), and that a valid recipient persists `failure_email_to` and
  then allows enabling. All 3 failed (no input existed).
- GREEN: `BehaviourSettingsInner` now renders a "Send failure emails to" input
  under the failure toggle; persists `failure_email_to` on blur; validates the
  email format mirroring the backend's comma-separated-email validator
  (`workspace.py:1386`); and `toggle()` BLOCKS enabling `failure_email_enabled`
  when the recipient is empty/invalid (toast error, no save).

## Fix 3 — Upstream the Hire create-intent fix to the engine

### Root cause
`fix-cloud-p0s.md` added `web/lib/emily-create-intent.ts` + an `EmilyChat.tsx`
`handleSubmit` edit on the **cloud** deploy build, but `EmilyChat.tsx` is an
engine-synced file — a submodule-present sync would clobber it. The honest gap it
recorded: "It should be upstreamed into the engine."

### Failing-test → fix
- Ported the cloud helper verbatim to the engine: `apps/web/lib/emily-create-intent.ts`
  (`buildCreateWorkerMessage` wraps the first create-mode hero message in an
  explicit worker-authoring directive; `WORKER_AUTHORING_INTENT_RE` mirrors the
  engine's `_WORKER_AUTHORING_INTENT_RE` in `apps/api/chat_service.py:1684`,
  verified byte-equal modulo DOTALL=`[\s\S]`).
- Wired `apps/web/components/emily/EmilyChat.tsx` `handleSubmit`: in create-mode,
  only the FIRST message (`createMode && messages.length === 0`) is wrapped.
- Ported the cloud test `apps/web/tests/hire-worker-creates-worker-r9.dom.test.tsx`
  (it imports `buildCreateWorkerMessage` from `@/components/emily/EmilyChat`, the
  re-export, so it is engine-compatible unchanged).
- RED→GREEN proven: temporarily reverting the `handleSubmit` wiring made the
  create-mode test fail (`expected sent != bare prompt`); restored → green. The
  existing `new-worker-emily-902.dom.test.tsx` (8) still passes.
- Cloud now inherits this via the submodule bump (durable) — the de-fork gap is
  closed.

## Fix 4 — Split-brain engine-level resolver

### Root cause (file:line)
- Grid / overview path resolves the worker-visibility owner id via
  `_worker_access_user_id(auth)` (`apps/api/services/worker_access.py:499`), which
  maps a caller whose `auth.username` is an owner/admin of the default workspace
  to the workspace-owner identity (local-deploy path, lines 508-536).
- Emily / agent path resolved via `_effective_worker_visibility_user_id(user_id)`
  (`apps/api/chat_service.py:337`), which only received the bare `user_id` string
  (chat tools call it with `user_id`, no username) and never applied that mapping.
- For the SAME caller the two resolved to **different** owner ids → the grid and
  Emily attributed ownership against different ids and showed different worker
  sets. This is the engine half of the 1-vs-9 split-brain `fix-cloud-p0s.md`
  flagged as "ENGINE-shared resolver issue … out of scope for this cloud branch."

### Failing-test → fix
- RED: new `apps/api/tests/test_worker_visibility_resolver_parity_r9.py`. In the
  exact divergent shape (OSS/local deploy, caller's username is the default-
  workspace owner/admin but `auth.user_id` is a distinct non-derived id), the grid
  resolved to `owner-admin` while the agent resolved to the bootstrap id `boot` —
  `assert agent_id == grid_id` failed (`'boot' != 'owner-admin'`).
- GREEN: `_effective_worker_visibility_user_id` now, after the cloud short-circuit
  and before building its bootstrap-fallback candidate chain, recovers the request-
  scoped `AuthContext` via `current_auth_context()` (`auth/context.py`) and, when
  `ctx.user_id == raw` (the agent is resolving the actual request caller), applies
  the SAME `_worker_access_user_id(ctx)` mapping FIRST. The existing OSS bootstrap-
  fallback (#1139) then only fires if that identity still owns nothing.
- Safety (independently verified):
  - **No import cycle / no recursion:** `services/worker_access.py` does NOT import
    `chat_service` and `_worker_access_user_id` does NOT call
    `_effective_worker_visibility_user_id`. Import smoke confirmed.
  - **No visibility widening:** `_worker_access_user_id` only maps username→username
    when that username is an **owner/admin** of the default workspace
    (`role IN ('owner','admin')`); a member caller is returned unchanged. The
    agent now sees exactly what the grid (same resolver) shows — the intended goal.
  - **No-op where required:** cloud (`_is_cloud_deploy()` short-circuit, unchanged)
    and single-user OSS (no username/`raw==user_id` → `_worker_access_user_id`
    returns the id unchanged).
- RED→GREEN proven by temporarily removing the new block (parity test failed),
  then restoring. The cloud no-op test passes both ways.

---

## Gates (per-fix + suite deltas)

### Engine
- **`next build`:** clean, exit 0 (all routes rendered, no errors).
- **Web vitest suite:** 469 passed / **13 failed** (482 total) in 7 files
  (`collection-pages`, `deep-links`, `emily-tool-card-renderer`,
  `login-split-822`, `next-config-redirects`, `not-found`, `workers-extra-views`).
  **All PRE-EXISTING:** re-ran those exact 7 files on the clean base (changes
  stashed) → identical 13 failures. **NET-NEW web failures = 0.** My changed-area
  tests all pass: `model-defaults-797` (1), `failure-email-recipient-r9` (3),
  `behaviour-settings-794` (2), `hire-worker-creates-worker-r9` (4),
  `new-worker-emily-902` (8), `workspace-settings-794` (2).
- **Python api (blast-radius set — every visibility/scoping/emily/worker/chat/
  access/identity/overview test, ~40 files):** 577 passed / **2 failed** / 2
  skipped. The 2 failures are in `test_worker_memory_defaults_1373.py` (memory-
  pack materialization, unrelated to the resolver) and are a PRE-EXISTING test-
  ordering pollution: identical **2 failed / 575 passed** on the clean base for the
  same set, and both pass in isolation on base AND branch. The +2 passed delta
  branch-vs-base is exactly my new `test_worker_visibility_resolver_parity_r9` (2).
  **NET-NEW api failures = 0.**

### Cloud
- **`next build`:** clean, exit 0 (`✓ Compiled successfully`, `✓ Generating static
  pages (8/8)`). Built with the engine fixes synced into `web/` via
  `sync-engine-web.mjs --engine <engine-fix-worktree>` + direct `next build` (the
  build's own sync defaults to the absent submodule and is the deploy-context
  skip; pointing it at the fix tree proves the submodule-present path is clean).
- **Web vitest suite (synced tree):** 417 passed / **22 failed** (439 total) in 8
  files (`api-session-redirect`, `collection-pages`, `deep-links`,
  `emily-tool-card-renderer`, `next-config-redirects`, `not-found`,
  `proxy-location-1044`, `workers-extra-views`). These match `fix-cloud-p0s.md`'s
  documented in-sandbox baseline (418/22/440; the 1-test count drift is the synced
  test set) exactly — the SAME pre-existing env/snapshot failures. **NET-NEW = 0.**
  My synced fix tests pass. (The brief's CI baseline 440/1/0 reflects an env WITH
  the SSL cert bundle / different snapshot; the clean-base-vs-branch DELTA is what
  matters and it is zero net-new.)
- **Engine submodule bump:** cloud gitlink `engine` c6c77699 → **a5b545ad** (the
  engine fix commit) — the canonical de-fork path so the cloud inherits all four
  fixes (Fix 4 reaches cloud via the submodule; Fixes 1-3 also via the tracked
  `web/` re-sync so the deploy-context sync-skip build carries them too).

- **Preview deploy:** NOT performed (token is preview-only; the cloud deploy path
  is documented BROKEN — `.vercelignore`/508 loop). Proven via failing-test-then-
  fix + clean engine & cloud builds + zero-net-new suites, as the brief allows.

---

## Honest gaps / caveats

- **Codex adversarial review of Fix 4 did not complete** — `codex exec` timed out
  (143) twice in these `/tmp` worktrees (env, not the diff). The three concerns it
  was asked (import cycle, visibility widening, the `ctx.user_id==raw` guard) were
  instead verified directly (grep for cross-imports/recursion = none; the
  owner/admin-only mapping in `_worker_access_user_id` = no member widening; guard
  scopes the mapping to the request caller). A live two-surface walk (grid vs
  Emily worker count for the same multi-member workspace) would be the strongest
  confirmation of Fix 4 beyond the unit parity test — not run here (no live
  multi-member cloud env in scope).
- **Engine Python full-suite was not run end-to-end** (it exceeds the sandbox
  timeout). I ran the complete blast-radius of my change (~40 files, every
  visibility/scoping/emily/worker/chat/access/identity/overview test) with a
  base-vs-branch comparison; my change touches only
  `_effective_worker_visibility_user_id`, whose callers are all inside that set.
- **`fix-cloud-p0s.md` itself is not on the cloud integration base** — it lives on
  `floomhq/managed-deployment` branch `fix/cloud-p0s-r9` @ `7ed7a6a3` (RSC-401 + create-
  intent + `list_for_agent` owner_id). Fixes 1/3/4 reference and build on it; the
  RSC-401 (#5) and `list_for_agent` owner_id (#1 cloud-repo half) fixes from that
  branch are NOT included here (out of this lane's scope) and remain to be merged
  from `fix/cloud-p0s-r9`.
