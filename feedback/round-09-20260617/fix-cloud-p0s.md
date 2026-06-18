# Round-09 — Cloud P0 fixes (last of the live P0s)

Branch: `fix/cloud-p0s-r9` (off `origin/integration/final-20260617` @ `dd01c907`).
Repo: `floomhq/workeros-cloud`. Worktree: `/tmp/wcloud-p0s-r9`.
TDD: failing-test-first for all three. Gates below.

Root causes traced in `feedback/round-09-20260617/p0-rootcause.md` (#5, #2, #1) +
`audit-live-surface.md`. This lane closes the three CORRECTNESS P0s from that table.

---

## Fix 1 — RSC `?_rsc=` 404 / login-redirect on soft nav (P0 #5)

### Root cause (file:line)
`web/middleware.ts:156-162` (source of truth: `web/overlay/middleware.ts`). On a
failed `verifySession`, the middleware issued a `307` redirect to `/login` for
**every** non-public request — including App Router RSC/Flight prefetches
(`/app/<route>?_rsc=…`, requests carrying the `rsc: 1` / `next-router-prefetch`
headers). The matcher (`:174`) only excludes `_next/static` + `_next/image`, and
`isPublicPath()` only short-circuits `/_next/`, so RSC page-route requests hit the
auth gate. On a cross-deploy soft-nav (landing → separate dashboard deploy via the
`vercel.json` `/app/*` rewrite) the session cookie handoff is unreliable, so the RSC
fetch received an HTML 307→login where it expected a `text/x-component` payload →
Next treats the prefetch as failed (404-equivalent), throws React #418, and soft
`<Link>` navigation hangs (only hard reloads render).

### Codex verdict (verbatim, RSC/auth-seam consult — verified vs `next@16.2.6` source)
> **Verdict**
>
> 1. Yes. Never send a `307` HTML login redirect for App Router Flight/RSC or Next
>    data fetches. On failed middleware auth, return `401` with no body and
>    `Cache-Control: private, no-store, max-age=0`. Keep the normal
>    `/login?next=...` redirect only for document navigations.
>
> 2. Use `401`, not `204`, and do not manually set `x-middleware-redirect`. In
>    `next@16.2.6`, App Router Flight fetch falls back to MPA navigation when the
>    response is not `text/x-component`, not `ok`, or has no body. Pages data
>    redirects use `x-nextjs-redirect`; `x-middleware-redirect` is an
>    internal/forbidden header, not the public client-router contract.
>
> 3. On the wire, `RSC: 1` is the semantic marker. `_rsc` is the cache-busting
>    hash. In middleware, use both because Next can strip internal Flight
>    headers/query from the `NextRequest` before user middleware. Add
>    `x-nextjs-data` / `/_next/data/` detection for Pages data.
>
> 4. No meaningful protected-data leak from returning `401` or bypassing only the
>    redirect. The RSC payload is still produced by page/server code, and this
>    app’s sensitive data path goes through the session cookie -> Bearer token ->
>    backend auth. A forged/missing cookie cannot produce backend data. Returning
>    `401` is tighter than `next()` because it prevents rendering work entirely.
>
> **Recommended Diff Shape**
> ```ts
> function isRscOrDataRequest(req: NextRequest): boolean {
>   const path = stripAppBase(req.nextUrl.pathname);
>   return (
>     req.headers.get("rsc") === "1" ||
>     req.headers.has("next-router-state-tree") ||
>     req.headers.has("next-router-prefetch") ||
>     req.nextUrl.searchParams.has("_rsc") ||
>     req.headers.has("x-nextjs-data") ||
>     path.startsWith("/_next/data/")
>   );
> }
> function authFetchRejected(csp: string): NextResponse {
>   const res = new NextResponse(null, { status: 401 });
>   res.headers.set("Content-Security-Policy", csp);
>   res.headers.set("Cache-Control", "private, no-store, max-age=0");
>   return res;
> }
> ```
> Then change only the failed-auth branch:
> ```ts
> if (!verified) {
>   if (isRscOrDataRequest(req)) {
>     return authFetchRejected(csp);
>   }
>   ... existing 307 /login redirect ...
> }
> ```
> Add matcher-level exclusion for `rsc: 1` only if production proves Next strips the
> marker before the helper sees it; that is the fallback, not the first choice,
> because `401` is the cleaner auth result.
>
> Verified against local `web/overlay/middleware.ts`, generated `web/middleware.ts`,
> and unpacked `next@16.2.6` source: `RSC_HEADER='rsc'`, `_rsc`, Flight fallback
> logic, `x-nextjs-redirect` for data requests, and internal filtering of
> `x-middleware-redirect`. Self-audit performed; no files were changed.

### Fix applied (exactly Codex's recommendation)
`web/overlay/middleware.ts` (+ synced `web/middleware.ts`): added
`isRscOrDataRequest(req)` (detects `rsc:1` header, `next-router-prefetch`,
`next-router-state-tree`, `?_rsc`, `x-nextjs-data`, `/_next/data/`) and, in the
`!verified` branch, returns a bodiless `401` with `private, no-store` + CSP for
those requests, keeping the `307 /login` only for real document navigations.

### TDD failing-test → fix
`web/tests/verify-session-935.test.ts` (source `web/overlay/tests/…`), new
`describe("Round-09 #5 …")`:
- RED: `expected 307 to be 401` for `?_rsc=` / `rsc:1` / prefetch / state-tree.
- GREEN after fix: anonymous + forged-cookie RSC → 401 (no `location`); real
  document nav → still 307 `/login`; valid-session RSC → `x-middleware-next`.

---

## Fix 2 — "Hire a worker" hero does not create a worker (P0 #2)

### Root cause (file:line)
`web/components/emily/EmilyChat.tsx` `handleSubmit` (create hero `onSubmit`) just
called `sendMessage(text)` — a plain `/chat` message with no create signal. Whether
a worker got drafted depended entirely on Emily's LLM choosing the draft tool; live
it answered with a LIST of existing workers, so "Hire worker" silently became a
query. The hero copy promises a deterministic "drafts the worker … opens the editor"
the path could not guarantee.

### Fix applied (minimal; full Worker-Studio redesign is separate)
New cloud helper `web/lib/emily-create-intent.ts`:
- `buildCreateWorkerMessage(prompt)` wraps the job description in an explicit
  worker-authoring directive (`[create-worker] Create a new worker for this job.
  Draft… create it… open the editor… Do not just list existing workers.`),
  idempotent (never double-wraps).
- `WORKER_AUTHORING_INTENT_RE` mirrors the engine's `_WORKER_AUTHORING_INTENT_RE`
  (engine `chat_service.py`). The wrapped message is GUARANTEED to trip it, so the
  backend injects the worker-authoring rules into Emily's system prompt every time
  (not just when the user happens to phrase create/build/draft + worker).

`EmilyChat.tsx` `handleSubmit`: in create-mode, only the FIRST message
(`createMode && messages.length === 0`, i.e. the hero) is wrapped; subsequent
messages chat normally. Non-create mode is unchanged.

### TDD failing-test → fix
`web/tests/hire-worker-creates-worker-r9.dom.test.tsx`:
- RED: module `@/lib/emily-create-intent` did not exist.
- GREEN: create-mode submit sends the directive (contains raw prompt, `!= prompt`,
  trips the intent regex); default mode sends verbatim; helper wraps + is idempotent.
  Existing `new-worker-emily-902.dom.test.tsx` (8) still passes.

### Honest gap (engine sync)
`EmilyChat.tsx` is an engine-synced file (NOT a cloud overlay). This fix lives in the
committed cloud tree and ships on the deploy build (which SKIPS `sync-engine-web.mjs`
when the engine submodule is absent — verified: `[sync] … Skipping sync.`). A future
build that re-initialises the engine submodule WILL clobber the EmilyChat edit +
`lib/emily-create-intent.ts`. **It should be upstreamed into the engine** (the
create-intent is generic, not cloud-specific) — recorded here so the de-fork workflow
picks it up. (`web/middleware.ts` is an overlay file and is sync-durable.)

---

## Fix 3 — cloud split-brain follow-up: `list_for_agent` / `owner_id` (P0 #1)

### Root cause (file:line)
`apps/api/db/supabase_repos.py` `SupabaseWorkerRepository.list_for_agent` (~:744)
reshaped each record to `{id,name,trigger_type,enabled,manifest_json}` and **dropped
`owner_id`**. The engine slice-1 fix made the OSS sqlite `list_for_agent` return
`owner_id` (`db/sqlite.py`) so the shared hide-helpers
(`services/worker_access._worker_hidden_from_api` / `_build_owned_tracked_ids`) and
the dashboard grid attribute ownership identically; the cloud reshape silently lost
it, so the cloud Emily surface could not match the grid the same way.

Note on scope: the cloud repo ALREADY implements `list_for_agent` with
workspace-scoped visibility (delegates to `list()` → `_worker_rows` →
`_scope_by_workspace` + `or_(user_id, visibility=shared)`), and the pre-existing
`tests/test_workers_for_agent_scope_237.py` (#224) already locks
`dashboard list() == Emily list_for_agent()`. The actionable cloud delta was the
missing `owner_id` (the brief's "return owner_id"), now fixed + tested.

### Fix applied
`list_for_agent` now includes `"owner_id": rec.get("owner_id")` (the
`_worker_record_from_rows` mapping of `workers.user_id`) on every agent row,
matching the OSS sqlite row shape.

### TDD failing-test → fix
`tests/test_cloud_list_for_agent_owner_parity_r9.py` (reuses the hermetic fake
Supabase client from `test_workers_for_agent_scope_237.py`):
- RED: `agent row missing owner_id`.
- GREEN: every agent row carries `owner_id` (own worker → caller; a same-workspace
  teammate SHARED worker → teammate); and `cloud Emily id-set == cloud grid id-set`
  for a single workspace (the count-parity the brief asked).

### Honest gap (deeper resolver divergence — NOT this fix)
The LIVE 1-vs-9 also has an engine-level component: the web grid resolves visibility
via `_worker_access_user_id(auth)` while Emily uses
`_effective_worker_visibility_user_id(user_id)` (engine `chat_service.py`). When
those resolve to different user ids, the cloud `or_(user_id.eq.X, visibility=shared)`
private-visibility filter can differ between the two surfaces. That is an
ENGINE-shared resolver issue, not the cloud repo, and is out of scope for this cloud
branch. Flagged for an engine lane. The cloud repo-level scoping + owner_id parity is
correct and tested here.

---

## Gates

- **TDD:** failing-test-first for all three (RED captured above), then GREEN.
- **Cloud `next build`:** clean. `✓ Compiled successfully`, `✓ Generating static
  pages (8/8)`, exit 0. (`sync-engine-web` correctly SKIPS in deploy context.)
  - One transient build break was found + fixed: the intent regex used the `s`
    (dotAll) flag (pre-es2018 target rejects it) → switched `.` to `[\s\S]`.
- **Web vitest suite:** 418 passed / 22 failed (440 total). The 22 failures are in 8
  files (`api-session-redirect`, `collection-pages`, `deep-links`,
  `emily-tool-card-renderer`, `next-config-redirects`, `not-found`,
  `proxy-location-1044`, `workers-extra-views`) — **all PRE-EXISTING**: verified by
  re-running them on the clean base (changes stashed) → identical 22 failures.
  NET-NEW web failures = **0**. My new/modified tests: `verify-session-935` (13),
  `hire-worker-creates-worker-r9` (4), `new-worker-emily-902` (8) all pass.
- **Cloud Python suite:** 415 passed / 28 failed (with engine submodule init'd). The
  28 failures (`test_supabase_retry_transport.*`, `test_registration`,
  `test_feedback_repo`, `test_supabase_repos::…rls…`) are **all PRE-EXISTING
  environment failures** (sandbox has no SSL cert bundle → `ssl.load_verify_locations
  FileNotFoundError` on real Supabase client init) — verified identical on the clean
  base. NET-NEW Python failures = **0**. My Fix 3 tests pass:
  `test_cloud_list_for_agent_owner_parity_r9` (2) + `test_workers_for_agent_scope_237`
  (6) + `test_supabase_repos` (8/9, the 1 fail is the SSL env failure).
  - Baseline framing: the brief's 440/1/0 baseline reflects a CI env WITH SSL certs;
    this sandbox lacks them, so the absolute pass count differs, but the
    clean-base-vs-branch DELTA is zero net-new in both suites.
- **Preview deploy:** NOT performed. A dashboard preview needs auth/secrets and would
  touch the deploy path CLAUDE.md documents as BROKEN (`.vercelignore`/508 loop). Per
  the brief ("if feasible … else prove via tests + Codex review") proven via
  failing-test-then-fix + clean build + Codex's verified RSC verdict instead.

## Branch SHA
Base: `dd01c907938c61c2101a085a40fcbcc50c0f1cca`. Final SHA recorded at commit time
(see `git log -1` on `fix/cloud-p0s-r9`).

## Files changed
- `web/overlay/middleware.ts`, `web/middleware.ts` — Fix 1 (RSC 401)
- `web/overlay/tests/verify-session-935.test.ts`, `web/tests/verify-session-935.test.ts` — Fix 1 tests
- `web/lib/emily-create-intent.ts` (new), `web/components/emily/EmilyChat.tsx` — Fix 2
- `web/tests/hire-worker-creates-worker-r9.dom.test.tsx` (new) — Fix 2 test
- `apps/api/db/supabase_repos.py` — Fix 3 (owner_id)
- `tests/test_cloud_list_for_agent_owner_parity_r9.py` (new) — Fix 3 test
