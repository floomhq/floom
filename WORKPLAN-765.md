# WORKPLAN-765

Date: 2026-04-25  
Issue: https://github.com/floomhq/floom/issues/765  
Branch: `codex/765-dup-signup-investigate`

## REPRODUCED

`NO` on current main.

### Evidence trail

1. Read issue body (`gh issue view 765`): original repro saw `200` twice with different `user.id` values for the same email.
2. Read Floom auth wiring end-to-end:
   - [`apps/server/src/lib/better-auth.ts`](/root/floom-codex-765-dup-signup-investigate/apps/server/src/lib/better-auth.ts#L207) sets `emailAndPassword.requireEmailVerification = true`.
   - No custom `onExistingUserSignUp` or `customSyntheticUser` override exists in this file.
   - [`apps/server/src/index.ts`](/root/floom-codex-765-dup-signup-investigate/apps/server/src/index.ts#L341) routes `/auth/*` directly through Better Auth handler.
3. Read upstream Better Auth duplicate branch:
   - `node_modules/.pnpm/better-auth@1.6.3.../dist/api/routes/sign-up.mjs` generates a synthetic user id on duplicate sign-up when `requireEmailVerification` is true (`generatedId`), returning generic `200` without inserting a second user row.
4. Ran targeted repro script against local dev DB:
   - Script: [`scripts/security/repro-765-duplicate-signup.mjs`](/root/floom-codex-765-dup-signup-investigate/scripts/security/repro-765-duplicate-signup.mjs)
   - Command: `./scripts/security/repro-765-duplicate-signup.mjs`
   - Result: `PASS`
   - Observed:
     - first sign-up: `200`, user id `Pn7Txi...`
     - second sign-up: `200`, user id `sZsvNg...` (different synthetic id)
     - SQLite auth table `"user"` row count for that email: `1`
     - SQLite mirrored table `users` row count for that email: `1`

## ROOT CAUSE

No duplicate persisted account creation reproduced in current main.

The reported symptom (`200` with a different `user.id` on second sign-up) matches Better Auth’s generic duplicate-response behavior in `better-auth@1.6.3` when email verification is required. The second response can contain a synthetic user id while the database still retains exactly one user row for that email.

## PROPOSED FIX

No production code fix is required for #765 based on current main behavior.

Proposed follow-up hardening (test-only):

1. Extend [`test/stress/test-auth-launch-security.mjs`](/root/floom-codex-765-dup-signup-investigate/test/stress/test-auth-launch-security.mjs#L133) to assert DB row count remains `1` after the duplicate sign-up call (today it only checks response shape).
2. Close issue #765 with evidence and clarify that generic duplicate responses may return synthetic ids by design.

## RISK

1. Production-specific schema drift could still reintroduce this (for example if `"user"."email"` unique constraint were missing in a specific environment).
2. Current investigation used local current-main migrations and handler path; this confirms code behavior, not every historical production DB snapshot.

## TEST PLAN

1. `pnpm install`
2. `pnpm --filter @floom/server build`
3. `./scripts/security/repro-765-duplicate-signup.mjs`
4. Confirm script reports:
   - second sign-up is either safe reject/idempotent/synthetic-safe branch
   - auth table row count for test email is exactly `1`
   - mirrored `users` row count is not duplicated
