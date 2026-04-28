#!/usr/bin/env node
// CLI account/apps management command routing tests.
//
// These run with FLOOM_DRY_RUN=1 so they verify shell parsing, typed command
// validation, endpoint selection, path escaping, and JSON body construction
// without requiring a live Floom server or credentials.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CLI = join(REPO_ROOT, 'cli/floom/bin/floom');
const API_URL = 'http://localhost:3999';

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

async function run(args, { input } = {}) {
  return await new Promise((resolve) => {
    const proc = spawn('bash', [CLI, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FLOOM_DRY_RUN: '1',
        FLOOM_API_URL: API_URL,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) proc.stdin.end(input);
    else proc.stdin.end();
  });
}

function bodyOf(stdout) {
  const line = stdout
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.startsWith('body: '));
  if (!line) return null;
  return JSON.parse(line.slice('body: '.length));
}

function includes(stdout, needle) {
  return stdout.includes(needle);
}

console.log('CLI account/apps management dry-run routing');

{
  const res = await run(['account', 'secrets', 'list']);
  log('account secrets list uses GET /api/secrets', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/secrets`), res.stdout + res.stderr);
}

{
  const res = await run(['account', 'secrets', 'set', 'API KEY', '--value', 'quoted "value"']);
  const body = bodyOf(res.stdout);
  log('account secrets set posts key/value JSON', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/secrets`) && body?.key === 'API KEY' && body?.value === 'quoted "value"', res.stdout + res.stderr);
}

{
  const res = await run(['account', 'secrets', 'set', 'STDIN_KEY', '--value-stdin'], { input: 'from stdin\nwith newline' });
  const body = bodyOf(res.stdout);
  log('account secrets set supports stdin values', res.code === 0 && body?.value === 'from stdin\nwith newline', res.stdout + res.stderr);
}

{
  const res = await run(['account', 'secrets', 'delete', 'API KEY']);
  log('account secrets delete URL-encodes key', res.code === 0 && includes(res.stdout, `DELETE ${API_URL}/api/secrets/API%20KEY`), res.stdout + res.stderr);
}

{
  const res = await run(['account', 'agent-tokens', 'create', '--label', 'Local Agent', '--scope', 'read-write', '--workspace-id', 'ws_123', '--rate-limit-per-minute', '120']);
  const body = bodyOf(res.stdout);
  log('agent-tokens create posts typed body', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/me/agent-keys`) && body?.label === 'Local Agent' && body?.scope === 'read-write' && body?.workspace_id === 'ws_123' && body?.rate_limit_per_minute === 120, res.stdout + res.stderr);
}

{
  const res = await run(['account', 'agent-tokens', 'list']);
  log('agent-tokens list uses GET endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/me/agent-keys`), res.stdout + res.stderr);
}

{
  const res = await run(['account', 'agent-tokens', 'create', '--label', 'Bad', '--scope', 'admin']);
  log('agent-tokens create rejects invalid scope before curl', res.code === 1 && res.stderr.includes('invalid --scope'), res.stdout + res.stderr);
}

{
  const res = await run(['account', 'agent-tokens', 'revoke', 'agtok_123']);
  log('agent-tokens revoke uses revoke endpoint', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/me/agent-keys/agtok_123/revoke`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'list']);
  log('apps list preserves existing endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/hub/mine`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'installed']);
  log('apps installed uses installed endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/hub/installed`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'list', '--help']);
  log('apps list help does not call API', res.code === 0 && res.stdout.includes('floom apps list') && !res.stdout.includes('DRY RUN'), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'fork', 'source app', '--slug', 'my-copy', '--name', 'My Copy']);
  const body = bodyOf(res.stdout);
  log('apps fork posts source slug and body', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/hub/source%20app/fork`) && body?.slug === 'my-copy' && body?.name === 'My Copy', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'claim', 'starter-app']);
  log('apps claim posts claim endpoint', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/hub/starter-app/claim`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'install', 'uuid']);
  log('apps install posts install endpoint', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/hub/uuid/install`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'uninstall', 'uuid']);
  log('apps uninstall deletes install endpoint', res.code === 0 && includes(res.stdout, `DELETE ${API_URL}/api/hub/uuid/install`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'update', 'my app', '--visibility', 'private', '--primary-action', 'search']);
  const body = bodyOf(res.stdout);
  log('apps update patches /api/hub/:slug', res.code === 0 && includes(res.stdout, `PATCH ${API_URL}/api/hub/my%20app`) && body?.visibility === 'private' && body?.primary_action === 'search', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'update', 'app-slug', '--run-rate-limit-per-hour', '12']);
  const body = bodyOf(res.stdout);
  log('apps update sets run rate limit', res.code === 0 && body?.run_rate_limit_per_hour === 12, res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'update', 'my app', '--visibility', 'public']);
  log('apps update rejects public visibility bypass', res.code !== 0 && includes(res.stderr, 'submit-review'), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'update', 'app-slug', '--clear-primary-action']);
  const body = bodyOf(res.stdout);
  log('apps update clears primary action with null', res.code === 0 && body && Object.hasOwn(body, 'primary_action') && body.primary_action === null, res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'delete', 'app-slug']);
  log('apps delete uses /api/hub/:slug', res.code === 0 && includes(res.stdout, `DELETE ${API_URL}/api/hub/app-slug`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'get', 'app slug']);
  log('apps get uses app detail endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/hub/app%20slug`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'source', 'get', 'app-slug']);
  log('apps source get uses source endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/hub/app-slug/source`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'source', 'openapi', 'app-slug']);
  log('apps source openapi uses raw OpenAPI endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/hub/app-slug/openapi.json`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'reviews', 'list', 'app-slug', '--limit', '7']);
  log('apps reviews list uses review endpoint with limit', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/apps/app-slug/reviews?limit=7`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'reviews', 'submit', 'app-slug', '--rating', '5', '--title', 'Nice', '--body-stdin'], { input: 'body text' });
  const body = bodyOf(res.stdout);
  log('apps reviews submit posts typed review body', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/apps/app-slug/reviews`) && body?.rating === 5 && body?.title === 'Nice' && body?.body === 'body text', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'renderer', 'get', 'app-slug']);
  log('apps renderer get uses renderer metadata endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/renderer/app-slug/meta`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'renderer', 'upload', 'app-slug', '--source-stdin', '--output-shape', 'table'], { input: 'export default function Renderer() { return null }' });
  const body = bodyOf(res.stdout);
  log('apps renderer upload posts source body', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/hub/app-slug/renderer`) && body?.source.includes('Renderer') && body?.output_shape === 'table', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'renderer', 'delete', 'app-slug']);
  log('apps renderer delete uses renderer delete endpoint', res.code === 0 && includes(res.stdout, `DELETE ${API_URL}/api/hub/app-slug/renderer`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'sharing', 'set', 'app-slug', '--state', 'link', '--comment', 'rotate', '--rotate-link-token']);
  const body = bodyOf(res.stdout);
  log('sharing set patches state body', res.code === 0 && includes(res.stdout, `PATCH ${API_URL}/api/me/apps/app-slug/sharing`) && body?.state === 'link' && body?.comment === 'rotate' && body?.link_token_rotate === true, res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'sharing', 'get', 'app-slug']);
  log('sharing get uses app sharing endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/me/apps/app-slug/sharing`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'sharing', 'invite', 'app-slug', '--email', 'person@example.com']);
  const body = bodyOf(res.stdout);
  log('sharing invite posts email body', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/me/apps/app-slug/sharing/invite`) && body?.email === 'person@example.com', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'sharing', 'revoke-invite', 'app-slug', 'invite 1']);
  log('sharing revoke-invite URL-encodes invite id', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/me/apps/app-slug/sharing/invite/invite%201/revoke`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'sharing', 'submit-review', 'app-slug']);
  log('sharing submit-review uses review endpoint', res.code === 0 && includes(res.stdout, `POST ${API_URL}/api/me/apps/app-slug/sharing/submit-review`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'secret-policies', 'list', 'app-slug']);
  log('secret-policies list uses GET endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/me/apps/app-slug/secret-policies`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'secret-policies', 'set', 'app-slug', 'OPENAI_API_KEY', '--policy', 'creator_override']);
  const body = bodyOf(res.stdout);
  log('secret-policies set uses PUT body', res.code === 0 && includes(res.stdout, `PUT ${API_URL}/api/me/apps/app-slug/secret-policies/OPENAI_API_KEY`) && body?.policy === 'creator_override', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'rate-limit', 'get', 'app-slug']);
  log('rate-limit get uses owner endpoint', res.code === 0 && includes(res.stdout, `GET ${API_URL}/api/me/apps/app-slug/rate-limit`), res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'rate-limit', 'set', 'app-slug', '--per-hour', 'default']);
  const body = bodyOf(res.stdout);
  log('rate-limit set supports default reset', res.code === 0 && includes(res.stdout, `PATCH ${API_URL}/api/me/apps/app-slug/rate-limit`) && body?.rate_limit_per_hour === null, res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'creator-secrets', 'set', 'app-slug', 'OPENAI_API_KEY', '--value-stdin'], { input: 'creator secret' });
  const body = bodyOf(res.stdout);
  log('creator-secrets set supports stdin values', res.code === 0 && includes(res.stdout, `PUT ${API_URL}/api/me/apps/app-slug/creator-secrets/OPENAI_API_KEY`) && body?.value === 'creator secret', res.stdout + res.stderr);
}

{
  const res = await run(['apps', 'creator-secrets', 'delete', 'app-slug', 'OPENAI_API_KEY']);
  log('creator-secrets delete uses DELETE endpoint', res.code === 0 && includes(res.stdout, `DELETE ${API_URL}/api/me/apps/app-slug/creator-secrets/OPENAI_API_KEY`), res.stdout + res.stderr);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
