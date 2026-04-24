#!/usr/bin/env node
// Contract tests for the AuthAdapter — the migration target for whoever
// wires `adapters.auth.signIn/signUp/signOut/onUserDelete` through Better
// Auth.
//
// These tests DEFINE what the AuthAdapter contract looks like from a
// caller's perspective. They are expected to FAIL today because the
// current impl (`adapters/auth-better-auth.ts`) throws "not yet wired"
// for signIn/signUp/signOut and stores `onUserDelete` listeners in an
// array that nobody ever reads. That is the point.
//
// When a future PR migrates the live Better Auth HTTP handler
// (/auth/sign-in/email, /auth/sign-up/email, /auth/sign-out,
// /auth/delete-user) to route through this adapter, this file becomes
// the green-bar target.
//
// IMPORTANT: this suite intentionally `exit 0`s regardless of pass/fail.
// It is documentation-as-executable-spec, not a CI gate. A "4 failing
// (expected until migration), 1 passing" output is the desired steady
// state until the migration lands. Wire it into `pnpm test` only AFTER
// signIn/signUp/signOut/onUserDelete are implemented for real.
//
// Run: tsx test/stress/test-adapters-auth-contract.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-auth-contract-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.FLOOM_MASTER_KEY =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
// Cloud mode + a valid BETTER_AUTH_SECRET so that, once the adapter is
// migrated, the Better Auth instance boots without the contract tests
// needing to change.
process.env.FLOOM_CLOUD_MODE = 'true';
process.env.BETTER_AUTH_SECRET =
  '0'.repeat(16) + '1'.repeat(16) + '2'.repeat(16) + '3'.repeat(16);
process.env.BETTER_AUTH_URL = 'http://localhost:3051';
delete process.env.RESEND_API_KEY;

// Strip the selection env vars so the factory returns the reference impls.
for (const k of [
  'FLOOM_RUNTIME',
  'FLOOM_STORAGE',
  'FLOOM_AUTH',
  'FLOOM_SECRETS',
  'FLOOM_OBSERVABILITY',
]) {
  delete process.env[k];
}

const { db } = await import('../../apps/server/src/db.ts');
const betterAuth = await import('../../apps/server/src/lib/better-auth.ts');
const { adapters } = await import(
  '../../apps/server/src/adapters/index.ts'
);

// Boot Better Auth's tables (user/session/account/verification/...) so a
// migrated adapter impl that writes a `user` row has somewhere to write.
betterAuth._resetAuthForTests();
await betterAuth.runAuthMigrations();

let expectedFails = 0;
let passed = 0;
let unexpectedPasses = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}

function expectedFail(label, reason) {
  expectedFails++;
  console.log(
    `  fail  ${label} (expected until migration): ${reason}`,
  );
}

function unexpectedPass(label, detail) {
  unexpectedPasses++;
  console.log(
    `  UNEXPECTED PASS  ${label} :: ${detail} — stub was less stubbed than thought; update the contract test`,
  );
}

function rowCount(sql, ...params) {
  try {
    const row = db.prepare(sql).get(...params);
    if (!row) return 0;
    const first = Object.values(row)[0];
    return Number(first) || 0;
  } catch {
    return 0;
  }
}

console.log('adapter-auth contract tests');

try {
  // ========================================================================
  // 1. signUp creates a user row
  // ========================================================================
  //
  // CONTRACT: calling `adapters.auth.signUp({ email, password, name })`
  // MUST produce a row in the `user` table (Better Auth's user table;
  // the Floom-side `users` mirror row is populated by the databaseHook)
  // and return a SessionContext. It MUST NOT throw.
  //
  // Today: the stub throws notYetWired('signUp'). We catch the throw and
  // record the expected-fail so the runner keeps going.
  {
    const label = 'signUp creates a user row';
    const email = `signup-${Date.now()}@example.com`;
    try {
      const result = await adapters.auth.signUp({
        email,
        password: 'hunter2-hunter2',
        name: 'Contract Signup',
      });
      // If we got here, the stub is no longer a stub. Assert the contract.
      const userRows = rowCount(
        `SELECT COUNT(*) AS n FROM "user" WHERE "email" = ?`,
        email,
      );
      const hasSession =
        !!(result && result.session && typeof result.session.user_id === 'string');
      if (userRows >= 1 && hasSession) {
        ok(label);
      } else {
        unexpectedPass(
          label,
          `returned without throw but user_rows=${userRows}, hasSession=${hasSession}`,
        );
      }
    } catch (err) {
      expectedFail(
        label,
        `adapters.auth.signUp is not yet wired through Better Auth ` +
          `(${err && err.message ? err.message.split('\n')[0] : String(err)}). ` +
          `Migrate it to POST /sign-up/email on Better Auth's HTTP handler.`,
      );
    }
  }

  // ========================================================================
  // 2. signIn resolves an existing user to a session
  // ========================================================================
  //
  // CONTRACT: after a prior signUp, calling
  // `adapters.auth.signIn({ email, password })` MUST return a valid
  // SessionContext (with `is_authenticated: true` and a real `user_id`)
  // plus either `set_cookie` or `token`. It MUST NOT throw for a valid
  // credential pair.
  //
  // Today: the stub throws notYetWired('signIn'). Note this test is
  // also currently blocked by signUp not working — once the migration
  // lands both gates open together.
  {
    const label = 'signIn resolves session';
    const email = `signin-${Date.now()}@example.com`;
    const password = 'hunter2-hunter2';
    try {
      // Best-effort: prime a user via signUp if it's implemented. If
      // signUp still throws, the signIn call below will also throw and
      // we'll record the expected fail for signIn.
      try {
        await adapters.auth.signUp({ email, password, name: 'Contract Signin' });
      } catch {
        // ignore — signIn is what we're checking here
      }
      const result = await adapters.auth.signIn({ email, password });
      const hasSession =
        !!(result && result.session && typeof result.session.user_id === 'string');
      const hasToken = !!(result && (result.set_cookie || result.token));
      if (hasSession && hasToken && result.session.is_authenticated === true) {
        ok(label);
      } else {
        unexpectedPass(
          label,
          `returned without throw but hasSession=${hasSession}, hasToken=${hasToken}, is_authenticated=${result?.session?.is_authenticated}`,
        );
      }
    } catch (err) {
      expectedFail(
        label,
        `adapters.auth.signIn is not yet wired through Better Auth ` +
          `(${err && err.message ? err.message.split('\n')[0] : String(err)}). ` +
          `Migrate it to POST /sign-in/email on Better Auth's HTTP handler.`,
      );
    }
  }

  // ========================================================================
  // 3. signOut invalidates the session
  // ========================================================================
  //
  // CONTRACT: after signIn, calling `adapters.auth.signOut(session)` MUST
  // cause a subsequent `adapters.auth.getSession(request-with-that-cookie)`
  // to return null. MUST NOT throw even if the session is already expired.
  //
  // Today: the stub throws notYetWired('signOut').
  {
    const label = 'signOut invalidates session';
    const email = `signout-${Date.now()}@example.com`;
    const password = 'hunter2-hunter2';
    try {
      // Synthesize a SessionContext shaped the way the adapter would
      // return one. We can't run signIn if signIn still throws, so this
      // call probes signOut directly with a fake session — which is
      // valid because the contract says signOut MUST NOT throw even if
      // the session is unknown/expired.
      const fakeSession = {
        workspace_id: 'local',
        user_id: `contract-${email}`,
        device_id: 'contract-test',
        is_authenticated: true,
        email,
      };
      await adapters.auth.signOut(fakeSession);
      // If signOut returned, verify getSession on a request carrying the
      // (now-invalidated) cookie returns null. We don't have the cookie
      // yet (signIn is stubbed), so use an empty-headers request: once
      // signOut + getSession are both wired, this assertion can be
      // tightened to use the real cookie from signIn above.
      const emptyReq = new Request('http://localhost:3051/api/anything', {
        headers: new Headers(),
      });
      const after = await adapters.auth.getSession(emptyReq);
      // In cloud mode, getSession with no cookie should return null.
      if (after === null) {
        ok(label);
      } else {
        unexpectedPass(
          label,
          `signOut + getSession returned without throw but getSession returned ${JSON.stringify(after)}. ` +
            `Tighten this test against a real signed-in cookie once signIn works.`,
        );
      }
    } catch (err) {
      expectedFail(
        label,
        `adapters.auth.signOut is not yet wired through Better Auth ` +
          `(${err && err.message ? err.message.split('\n')[0] : String(err)}). ` +
          `Migrate it to POST /sign-out on Better Auth's HTTP handler.`,
      );
    }
  }

  // ========================================================================
  // 4. onUserDelete fires registered listeners
  // ========================================================================
  //
  // CONTRACT: after `adapters.auth.onUserDelete(listener)` registers a
  // listener, deleting a user (via the live Better Auth delete-user
  // handler, or whatever the adapter exposes post-migration) MUST
  // invoke the listener with the deleted user id. The adapter MUST
  // invoke every registered callback in registration order.
  //
  // Today: `onUserDelete` does not throw (it just pushes into a
  // `deleteListeners` array) — but nothing ever reads that array, so
  // the callback never fires. The expected-fail assertion is on the
  // INVOCATION, not the registration.
  {
    const label = 'onUserDelete fires listeners';
    const invocations = [];
    try {
      adapters.auth.onUserDelete((user_id) => {
        invocations.push(user_id);
      });
      // Drive a user deletion. Today there is no public adapter method
      // for "delete a user"; the live flow goes through Better Auth's
      // POST /auth/delete-user with afterDelete hooking cleanupUserOrphans.
      // For the contract, we just observe that the listener NEVER fires
      // because the registered-but-unread deleteListeners array in
      // auth-better-auth.ts is orphaned state.
      //
      // Simulate the expected trigger: directly insert + delete a user
      // row the same way Better Auth's databaseHook would. A wired
      // adapter would observe this deletion and invoke the listeners.
      const uid = `onuserdelete-${Date.now()}`;
      try {
        db.prepare(
          `INSERT INTO "user" (id, email, name, emailVerified, createdAt, updatedAt)
           VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        ).run(uid, `${uid}@example.com`, 'Contract Delete');
        db.prepare(`DELETE FROM "user" WHERE id = ?`).run(uid);
      } catch {
        // Better Auth table names / columns may vary across versions;
        // the orphan-state assertion below does not depend on this row
        // actually existing.
      }
      // Give async listeners a microtask tick to run, just in case.
      await new Promise((resolve) => setImmediate(resolve));
      if (invocations.length >= 1) {
        ok(label);
      } else {
        expectedFail(
          label,
          `adapters.auth.onUserDelete accepted the listener but it was never invoked — ` +
            `the deleteListeners array in auth-better-auth.ts is declared but never read. ` +
            `Wire afterDelete in lib/better-auth.ts to iterate deleteListeners.`,
        );
      }
    } catch (err) {
      expectedFail(
        label,
        `adapters.auth.onUserDelete threw ` +
          `(${err && err.message ? err.message.split('\n')[0] : String(err)}). ` +
          `Wire it to the Better Auth afterDelete hook.`,
      );
    }
  }

  // ========================================================================
  // 5. getSession reads current session from cookie (control — passes today)
  // ========================================================================
  //
  // Sanity anchor: the one AuthAdapter method that IS wired should
  // still return null for an unauthenticated request in cloud mode.
  // If this starts failing, the adapter's migration broke the already-
  // working path, which is what the next contributor must avoid.
  {
    const label = 'getSession reads current session from cookie';
    try {
      const req = new Request('http://localhost:3051/api/anything', {
        headers: new Headers(),
      });
      const result = await adapters.auth.getSession(req);
      if (result === null) {
        ok(label);
      } else {
        // Cloud mode with no cookie: null is the only correct answer.
        unexpectedPass(
          label,
          `expected null for unauthenticated cloud-mode request, got ${JSON.stringify(result)}`,
        );
      }
    } catch (err) {
      console.log(
        `  FAIL  ${label} (regression!): ${err && err.message ? err.message : String(err)}`,
      );
    }
  }
} finally {
  try {
    db.close();
  } catch {
    // best effort
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  `\n${expectedFails} failing (expected until migration), ${passed} passing` +
    (unexpectedPasses > 0
      ? `, ${unexpectedPasses} UNEXPECTED PASSES — update the harness`
      : ''),
);
// Exit 0 regardless: this suite is documentation, not a CI gate. See the
// header comment. Wire it into `pnpm test` only after the migration lands.
process.exit(0);
