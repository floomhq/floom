#!/usr/bin/env node
// Contract tests for the AuthAdapter.
//
// These tests DEFINE what the AuthAdapter contract looks like from a
// caller's perspective. A conforming adapter reports 5 passing and exits 0;
// any failed assertion is counted in the tally and exits non-zero.
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

const selectedAuthAdapter = process.env.FLOOM_CONFORMANCE_ADAPTER || '';
const authMode =
  process.env.FLOOM_AUTH_MODE ||
  (selectedAuthAdapter.includes('auth-magic-link') ? 'magic-link' : 'password');
process.env.FLOOM_AUTH_MODE = authMode;
if (authMode === 'magic-link') {
  process.env.FLOOM_AUTH_MAGIC_LINK_SEND = 'false';
  process.env.FLOOM_AUTH_MAGIC_LINK_EXPOSE_TOKEN = 'true';
}

// Strip selection env vars for direct runs so the factory returns the
// reference impls. The conformance runner sets FLOOM_CONFORMANCE_CONCERN to
// preserve the selected concern under test.
const selectedConcern = process.env.FLOOM_CONFORMANCE_CONCERN;
for (const k of [
  'FLOOM_RUNTIME',
  'FLOOM_STORAGE',
  'FLOOM_AUTH',
  'FLOOM_SECRETS',
  'FLOOM_OBSERVABILITY',
]) {
  if (selectedConcern && k === `FLOOM_${selectedConcern.toUpperCase()}`) continue;
  delete process.env[k];
}

const { db } = await import('../../apps/server/src/db.ts');
const betterAuth = await import('../../apps/server/src/lib/better-auth.ts');
const { betterAuthAdapter } = await import(
  '../../apps/server/src/adapters/auth-better-auth.ts'
);
const { adapters } = await import(
  '../../apps/server/src/adapters/index.ts'
);
const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');
const { createMagicLinkAuthAdapter } = await import(
  '../../packages/auth-magic-link/src/index.ts'
);

// Boot Better Auth's tables (user/session/account/verification/...) so a
// migrated adapter impl that writes a `user` row has somewhere to write.
betterAuth._resetAuthForTests();
await betterAuth.runAuthMigrations();

let passed = 0;
let skipped = 0;
let failed = 0;
let httpPassed = 0;
let httpFailed = 0;

function ok(label) {
  passed++;
  console.log(`  ok    ${label}`);
}

function fail(label, reason) {
  failed++;
  console.log(`  FAIL  ${label}: ${reason}`);
}

function skip(label, reason) {
  skipped++;
  console.log(`  skip  ${label}: ${reason}`);
}

function httpOk(label) {
  httpPassed++;
  console.log(`  ok    http: ${label}`);
}

function httpFail(label, reason) {
  httpFailed++;
  console.log(`  FAIL  http: ${label}: ${reason}`);
}

function isSessionResult(result) {
  return !!(
    result &&
    result.session &&
    typeof result.session.user_id === 'string' &&
    result.session.user_id.length > 0 &&
    typeof result.session.workspace_id === 'string' &&
    result.session.workspace_id.length > 0
  );
}

function isMagicLinkSent(result) {
  return result?.status === 'magic-link-sent' && typeof result.email === 'string';
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

function firstCookieFromSetCookie(setCookie) {
  if (!setCookie) return undefined;
  const first = setCookie.split(';', 1)[0]?.trim();
  return first || undefined;
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
  {
    const label = 'signUp creates a user row';
    const email = `signup-${Date.now()}@example.com`;
    try {
      const result = await adapters.auth.signUp({
        email,
        password: 'hunter2-hunter2',
        name: 'Contract Signup',
      });
      if (authMode === 'magic-link') {
        const user = await adapters.storage.getUserByEmail(email);
        if (user?.email === email && isMagicLinkSent(result)) {
          ok(label);
        } else {
          fail(
            label,
            `storage_user=${JSON.stringify(user)}, status=${result?.status}`,
          );
        }
      } else {
        const userRows = rowCount(
          `SELECT COUNT(*) AS n FROM "user" WHERE "email" = ?`,
          email,
        );
        const hasSession = isSessionResult(result);
        if (userRows >= 1 && hasSession) {
          ok(label);
        } else {
          fail(
            label,
            `user_rows=${userRows}, hasSession=${hasSession}`,
          );
        }
      }
    } catch (err) {
      fail(
        label,
        err && err.message ? err.message.split('\n')[0] : String(err),
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
      if (authMode === 'magic-link') {
        const verified = await adapters.auth.verifyMagicLink?.(result?.debug_token || '');
        const hasSentStatus = isMagicLinkSent(result);
        const hasVerifiedSession = isSessionResult(verified);
        const resolved = verified?.token
          ? await adapters.auth.getSession(new Request('http://localhost:3051/api/anything', {
              headers: new Headers({
                authorization: `Bearer ${verified.token}`,
              }),
            }))
          : null;
        if (
          hasSentStatus &&
          hasVerifiedSession &&
          resolved?.user_id === verified.session.user_id &&
          typeof resolved?.workspace_id === 'string' &&
          resolved.workspace_id.length > 0
        ) {
          ok(label);
        } else {
          fail(
            label,
            `hasSentStatus=${hasSentStatus}, hasVerifiedSession=${hasVerifiedSession}, resolved=${JSON.stringify(resolved)}`,
          );
        }
      } else {
        const hasSession = isSessionResult(result);
        const hasToken = !!(result && (result.set_cookie || result.token));
        if (hasSession && hasToken && result.session.is_authenticated === true) {
          ok(label);
        } else {
          fail(
            label,
            `hasSession=${hasSession}, hasToken=${hasToken}, is_authenticated=${result?.session?.is_authenticated}`,
          );
        }
      }
    } catch (err) {
      fail(
        label,
        err && err.message ? err.message.split('\n')[0] : String(err),
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
  {
    const label = 'signOut invalidates session';
    const email = `signout-${Date.now()}@example.com`;
    const password = 'hunter2-hunter2';
    try {
      await adapters.auth.signUp({ email, password, name: 'Contract Signout' });
      const signedIn = await adapters.auth.signIn({ email, password });
      const verified =
        authMode === 'magic-link'
          ? await adapters.auth.verifyMagicLink?.(signedIn?.debug_token || '')
          : signedIn;
      const cookie = firstCookieFromSetCookie(verified?.set_cookie);
      await adapters.auth.signOut(verified.session);
      const headers =
        authMode === 'magic-link'
          ? new Headers({
              authorization: `Bearer ${verified.token}`,
              host: 'localhost:3051',
            })
          : new Headers({
              cookie,
              host: 'localhost:3051',
            });
      const after = await adapters.auth.getSession(new Request('http://localhost:3051/api/anything', {
        headers,
      }));
      if (after === null) {
        ok(label);
      } else {
        fail(
          label,
          `getSession returned ${JSON.stringify(after)} after signOut`,
        );
      }
    } catch (err) {
      fail(
        label,
        err && err.message ? err.message.split('\n')[0] : String(err),
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
  {
    const label = 'onUserDelete fires listeners';
    const invocations = [];
    try {
      if (authMode === 'magic-link') {
        adapters.auth.onUserDelete((user_id) => {
          invocations.push(user_id);
        });
        const email = `onuserdelete-${Date.now()}@example.com`;
        const signedUp = await adapters.auth.signUp({
          email,
          name: 'Contract Delete',
        });
        const verified = await adapters.auth.verifyMagicLink?.(
          signedUp?.debug_token || '',
        );
        const storageWithDelete = adapters.storage;
        if (!verified?.session?.user_id) {
          fail(label, `verified=${JSON.stringify(verified)}`);
        } else if (typeof storageWithDelete.deleteUser !== 'function') {
          fail(label, 'StorageAdapter implementation has no deleteUser test hook');
        } else {
          await storageWithDelete.deleteUser(verified.session.user_id);
          if (
            invocations.length === 1 &&
            invocations[0] === verified.session.user_id
          ) {
            ok(label);
          } else {
            fail(
              label,
              `invocations=${JSON.stringify(invocations)}, expected=${verified.session.user_id}`,
            );
          }
        }
      } else {
        adapters.auth.onUserDelete((user_id) => {
          invocations.push(user_id);
        });
        const email = `onuserdelete-${Date.now()}@example.com`;
        const password = 'hunter2-hunter2';
        const signedUp = await adapters.auth.signUp({
          email,
          password,
          name: 'Contract Delete',
        });
        const cookie = firstCookieFromSetCookie(signedUp.set_cookie);
        const auth = betterAuth.getAuth();
        await auth.api.deleteUser({
          body: { password },
          headers: new Headers({
            cookie,
            host: 'localhost:3051',
            origin: 'http://localhost:3051',
          }),
        });
        if (invocations.length === 1 && invocations[0] === signedUp.session.user_id) {
          ok(label);
        } else {
          fail(
            label,
            `invocations=${JSON.stringify(invocations)}, expected=${signedUp.session.user_id}`,
          );
        }
      }
    } catch (err) {
      fail(
        label,
        err && err.message ? err.message.split('\n')[0] : String(err),
      );
    }
  }

  // ========================================================================
  // 5. getSession reads the current session and resolves workspace context
  // ========================================================================
  //
  // CONTRACT: getSession(request) resolves an authenticated request to a
  // SessionContext with both user_id and workspace_id populated.
  {
    const label = 'getSession returns populated SessionContext';
    try {
      const email = `getsession-${Date.now()}@example.com`;
      const password = 'hunter2-hunter2';
      await adapters.auth.signUp({ email, password, name: 'Contract Session' });
      const signedIn = await adapters.auth.signIn({ email, password });
      const verified =
        authMode === 'magic-link'
          ? await adapters.auth.verifyMagicLink?.(signedIn?.debug_token || '')
          : signedIn;
      const headers =
        authMode === 'magic-link'
          ? new Headers({
              authorization: `Bearer ${verified?.token}`,
              host: 'localhost:3051',
            })
          : new Headers({
              cookie: firstCookieFromSetCookie(verified?.set_cookie),
              host: 'localhost:3051',
            });
      const result = await adapters.auth.getSession(
        new Request('http://localhost:3051/api/anything', { headers }),
      );
      if (
        result?.user_id === verified?.session?.user_id &&
        typeof result.workspace_id === 'string' &&
        result.workspace_id.length > 0
      ) {
        ok(label);
      } else {
        fail(
          label,
          `result=${JSON.stringify(result)}, verified=${JSON.stringify(verified)}`,
        );
      }
    } catch (err) {
      fail(label, err && err.message ? err.message : String(err));
    }
  }

  // ========================================================================
  // HTTP-level AuthAdapter.mountHttp contract
  // ========================================================================
  {
    const label = 'Better Auth mountHttp exposes session endpoint';
    try {
      const app = new Hono();
      await betterAuthAdapter.mountHttp(app, '/auth');
      const res = await app.request('http://localhost:3051/auth/session', {
        method: 'GET',
        headers: { host: 'localhost:3051' },
      });
      const body = await res.clone().text();
      if (res.status === 200 && body === 'null') {
        httpOk(label);
      } else {
        httpFail(label, `status=${res.status}, body=${body}`);
      }
    } catch (err) {
      httpFail(label, err && err.message ? err.message : String(err));
    }
  }

  {
    const label = 'magic-link mountHttp requests and verifies session';
    const sentEmails = [];
    try {
      const auth = createMagicLinkAuthAdapter({
        storage: adapters.storage,
        resendApiKey: 'test-resend-key',
        fromEmail: 'Floom <login@example.com>',
        jwtSecret: process.env.BETTER_AUTH_SECRET,
        jwtIssuer: 'floom-contract',
        baseUrl: 'http://localhost:3051',
        resendClient: {
          emails: {
            send: async (payload) => {
              sentEmails.push(payload);
              return { id: 'mock-email' };
            },
          },
        },
      });
      const app = new Hono();
      await auth.mountHttp(app, '/auth');
      const email = `http-magic-${Date.now()}@example.com`;
      const requestRes = await app.request(
        'http://localhost:3051/auth/magic-link/request',
        {
          method: 'POST',
          headers: {
            host: 'localhost:3051',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ email, name: 'HTTP Magic' }),
        },
      );
      if (requestRes.status === 202) {
        httpOk('magic-link request returns 202');
      } else {
        httpFail('magic-link request returns 202', `status=${requestRes.status}`);
      }
      if (sentEmails.length === 1 && sentEmails[0]?.to === email) {
        httpOk('magic-link request enqueues email');
      } else {
        httpFail(
          'magic-link request enqueues email',
          `sentEmails=${JSON.stringify(sentEmails)}`,
        );
      }
      const tokenMatch = String(sentEmails[0]?.html || '').match(/token=([^"&<]+)/);
      const token = tokenMatch ? decodeURIComponent(tokenMatch[1]) : '';
      const verifyRes = await app.request(
        `http://localhost:3051/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        {
          method: 'GET',
          headers: { host: 'localhost:3051' },
        },
      );
      const setCookie = verifyRes.headers.get('set-cookie');
      const cookie = firstCookieFromSetCookie(setCookie);
      const session = cookie
        ? await auth.getSession(
            new Request('http://localhost:3051/auth/session', {
              headers: new Headers({ cookie, host: 'localhost:3051' }),
            }),
          )
        : null;
      if (
        verifyRes.status === 302 &&
        verifyRes.headers.get('location') === 'http://localhost:3051' &&
        session?.email === email &&
        session.is_authenticated === true
      ) {
        httpOk('magic-link verify sets cookie and getSession resolves user');
      } else {
        httpFail(
          'magic-link verify sets cookie and getSession resolves user',
          `status=${verifyRes.status}, location=${verifyRes.headers.get('location')}, cookie=${setCookie}, session=${JSON.stringify(session)}`,
        );
      }
    } catch (err) {
      httpFail(label, err && err.message ? err.message : String(err));
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
  `\n${passed} passing, ${skipped} skipped, ${failed} failing`,
);
console.log(
  `${httpPassed} HTTP-level auth contract passing, ${httpFailed} failing`,
);
process.exit(failed === 0 && httpFailed === 0 ? 0 : 1);
