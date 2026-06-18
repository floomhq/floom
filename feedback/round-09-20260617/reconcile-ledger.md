# Reconcile Ledger — round-09 RELEASE onto NEW main (cloud)

Direction: `git merge --no-commit --no-ff origin/main` INTO
`release/round-09-20260618` so the cloud release ⊇ cloud main. NO merge to main;
only `reconcile/round-09-onto-main` is pushed.

- Cloud release tip (HEAD): `ff2ab096` (release: re-derive round-09 onto main)
- Cloud new main tip (merged in): `da9eca7b`
- Cloud-main commits preserved (all present / ancestors of merge HEAD):
  - `da9eca7b` chore(engine): bump E2B resource defaults
  - `3a36093e` chore(engine): bump mutation gate fixes
  - `dad23b8c` chore(engine): bump security fixes
  - `d0666061` perf: cache cloud workspace list
  - `063e5118` (overlay: localStorage guard + public onboarding routes) — confirmed
    ancestor of merge HEAD.

## Conflicted paths (1)

### `engine` (submodule pointer)
- **What cloud main had:** engine `272a4093` (new-main tip — security +
  mutation-gate + E2B + perf fixes).
- **What cloud release (R9) had:** engine `3a2196b0` (R9 engine line).
- **Resolution:** pointed the submodule at the **engine reconcile SHA
  `9682c052`** (the engine merge produced earlier: `release/round-09` engine +
  `git merge origin/main`). Verified BOTH cloud engine pointers are ancestors of
  `9682c052`:
  - cloud-release engine `3a2196b0` → ancestor of `9682c052` ✓
  - cloud-main engine `272a4093` → ancestor of `9682c052` ✓
  So the cloud now carries R9 engine AND all 4 new-main engine fixes.
- **Dropped:** nothing — `9682c052` is a strict superset of both pointers.

## Auto-merged (no manual resolution)

- `apps/api/routes/workspaces.py` — cloud-main `d0666061` per-user workspace-list
  cache (`_workspace_list_cache`, 15s TTL) coexists with R9's changes; landed in
  distinct regions. Confirmed cache symbols present in merged tree.
- `README.md` — auto-merged.

## Cloud KEEP rules re-confirmed post-merge

- Cloud-main `063e5118` localStorage guards + public onboarding routes: present
  (`063e5118` is ancestor of merge HEAD; `web/app/start/page.tsx`,
  `web/app/auth/magic/[token]/page.tsx` present; localStorage guards in
  `web/lib/emily-chat-storage.ts`, `web/lib/workers/pinned-tabs.ts`,
  `web/app/connections/callback/page.tsx`).
- R9 RSC-401 handling: present (`web/middleware.ts`, `web/overlay/middleware.ts`,
  `verify-session-935` tests).
- R9 overlay changes: present (`web/overlay/`, `ClaimSuccessOverlay.tsx`,
  `cloud-overlay-parity` / `claim-success-overlay` tests).
- Cloud-main `d0666061` workspace-list cache: present.

## Unresolved / dropped

None.
