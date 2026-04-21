#!/usr/bin/env node
// Docker-image ingest pipeline.
//   - ingest_app MCP tool exposes docker_image_ref + secret_bindings.
//   - Flag off → docker_image_ref rejected with docker_publish_disabled error.
//   - Flag on → ingestAppFromDockerImage() persists app row with app_type='docker',
//     docker_image=<ref>, creator_override policy per secret binding, and copies
//     the caller's vault plaintext into app_creator_secrets when available.
//   - OpenAPI ingest path is untouched.
//
// Uses a mock Docker client + skipPull/skipInspect hooks so it runs without a
// live daemon.
//
// Run: node test/stress/test-docker-image-ingest.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = mkdtempSync(join(tmpdir(), 'floom-docker-ingest-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
process.env.PUBLIC_URL = 'http://localhost';
// A deterministic master key for the vault: 32 random bytes → hex (64 chars).
process.env.FLOOM_MASTER_KEY = randomBytes(32).toString('hex');

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

async function callAdmin(mcpRouter, body) {
  const res = await mcpRouter.fetch(
    new Request('http://localhost/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  return { status: res.status, json, text };
}

function parseToolText(resp) {
  const raw = resp.json?.result?.content?.[0]?.text;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

console.log('Docker-image ingest pipeline');

try {
  const { db } = await import('../../apps/server/dist/db.js');
  const { mcpRouter } = await import('../../apps/server/dist/routes/mcp.js');
  const ingestMod = await import(
    '../../apps/server/dist/services/docker-image-ingest.js'
  );
  const userSecrets = await import(
    '../../apps/server/dist/services/user_secrets.js'
  );
  const appCreatorSecrets = await import(
    '../../apps/server/dist/services/app_creator_secrets.js'
  );

  // ===================================================================
  // 1. tools/list — ingest_app now advertises docker_image_ref
  // ===================================================================
  const list = await callAdmin(mcpRouter, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
  const tools = list.json?.result?.tools || [];
  const ingestTool = tools.find((t) => t.name === 'ingest_app');
  log(
    'ingest_app exposes docker_image_ref in inputSchema',
    Boolean(ingestTool?.inputSchema?.properties?.docker_image_ref),
  );
  log(
    'ingest_app exposes secret_bindings in inputSchema',
    Boolean(ingestTool?.inputSchema?.properties?.secret_bindings),
  );
  log(
    'ingest_app exposes manifest override in inputSchema',
    Boolean(ingestTool?.inputSchema?.properties?.manifest),
  );

  // ===================================================================
  // 2. Flag off (default) — docker_image_ref rejected via MCP surface
  // ===================================================================
  delete process.env.FLOOM_ENABLE_DOCKER_PUBLISH;
  log(
    'isDockerPublishEnabled() is false by default',
    ingestMod.isDockerPublishEnabled() === false,
  );
  const disabledCall = await callAdmin(mcpRouter, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'ingest_app',
      arguments: { docker_image_ref: 'ghcr.io/floomhq/ig-nano-scout:latest' },
    },
  });
  const disabledPayload = parseToolText(disabledCall);
  log(
    'docker_image_ref with flag off returns isError',
    disabledCall.json?.result?.isError === true,
  );
  log(
    'flag-off error code is docker_publish_disabled',
    disabledPayload?.error === 'docker_publish_disabled',
    JSON.stringify(disabledPayload),
  );

  // ===================================================================
  // 3. Flag on — ingestAppFromDockerImage persists the row end-to-end
  // ===================================================================
  process.env.FLOOM_ENABLE_DOCKER_PUBLISH = 'true';
  log(
    'isDockerPublishEnabled() is true when flag=true',
    ingestMod.isDockerPublishEnabled() === true,
  );

  // Pre-populate the caller's vault so the ingest copies it into
  // app_creator_secrets automatically. We use the synthetic 'local'
  // workspace/user that db.ts bootstraps on first run — avoids having to
  // create a full workspace+user+DEK chain in the test.
  const ctx = {
    user_id: 'local',
    workspace_id: 'local',
    is_authenticated: true,
    session_id: 'sess-test',
    source: 'test',
  };
  userSecrets.set(ctx, 'instagram_session_id', 'vault-plaintext-value');

  const mockDocker = {};

  const result = await ingestMod.ingestAppFromDockerImage({
    docker_image_ref: 'ghcr.io/floomhq/ig-nano-scout:latest',
    name: 'IG Nano Scout',
    description: 'Pulls Instagram profile data via nano-scout',
    category: 'data',
    secret_bindings: { IG_SESSIONID: 'instagram_session_id' },
    workspace_id: 'local',
    author_user_id: 'local',
    visibility: 'private',
    dockerClient: mockDocker,
    skipPull: true,
    skipInspect: true,
    ctx,
  });

  log(
    'ingestAppFromDockerImage returns created=true',
    result.created === true,
    JSON.stringify(result),
  );
  log('result carries slug', typeof result.slug === 'string' && result.slug.length > 0);
  log('result carries name', result.name === 'IG Nano Scout');

  const row = db
    .prepare(
      'SELECT id, slug, name, app_type, docker_image, workspace_id, author, visibility, manifest, category FROM apps WHERE slug = ?',
    )
    .get(result.slug);
  log('row exists in apps table', Boolean(row));
  log(
    'row app_type is docker',
    row?.app_type === 'docker',
    `app_type=${row?.app_type}`,
  );
  log(
    'row docker_image matches input ref',
    row?.docker_image === 'ghcr.io/floomhq/ig-nano-scout:latest',
    row?.docker_image,
  );
  log('row workspace_id matches caller', row?.workspace_id === 'local');
  log('row author matches caller', row?.author === 'local');
  log('row visibility honored', row?.visibility === 'private');
  log('row category stored', row?.category === 'data');

  // Manifest should carry the declared secret in secrets_needed.
  let parsedManifest = null;
  try {
    parsedManifest = JSON.parse(row.manifest);
  } catch {
    // leave null
  }
  log(
    'synthesized manifest includes IG_SESSIONID in secrets_needed',
    Array.isArray(parsedManifest?.secrets_needed) &&
      parsedManifest.secrets_needed.includes('IG_SESSIONID'),
    JSON.stringify(parsedManifest?.secrets_needed),
  );
  log(
    'synthesized manifest has a single action',
    parsedManifest &&
      typeof parsedManifest.actions === 'object' &&
      Object.keys(parsedManifest.actions).length >= 1,
  );

  // Secret policy should exist with creator_override.
  const policy = appCreatorSecrets.getPolicy(row.id, 'IG_SESSIONID');
  log(
    'secret policy is creator_override',
    policy === 'creator_override',
    `got ${policy}`,
  );

  // And the creator value should have been copied from the vault.
  log(
    'creator value copied from caller vault',
    appCreatorSecrets.hasCreatorValue(row.id, 'IG_SESSIONID') === true,
  );

  // Placeholder secret row must exist so per-app UI sees the binding.
  const secretRow = db
    .prepare('SELECT name FROM secrets WHERE app_id = ? AND name = ?')
    .get(row.id, 'IG_SESSIONID');
  log('secrets table has placeholder row for binding', Boolean(secretRow));

  // ===================================================================
  // 4. Re-ingest with same slug + same workspace → update, not SlugTaken
  // ===================================================================
  const reIngest = await ingestMod.ingestAppFromDockerImage({
    docker_image_ref: 'ghcr.io/floomhq/ig-nano-scout:latest',
    slug: result.slug,
    name: 'IG Nano Scout v2',
    workspace_id: 'local',
    author_user_id: 'local',
    dockerClient: mockDocker,
    skipPull: true,
    skipInspect: true,
    ctx,
  });
  log(
    're-ingest from same workspace returns created=false',
    reIngest.created === false,
    JSON.stringify(reIngest),
  );
  const updatedRow = db
    .prepare('SELECT name FROM apps WHERE slug = ?')
    .get(result.slug);
  log('re-ingest updates name', updatedRow?.name === 'IG Nano Scout v2');

  // ===================================================================
  // 5. Slug collision from a different workspace → SlugTakenError
  // ===================================================================
  db.prepare('UPDATE apps SET workspace_id = ? WHERE slug = ?').run(
    'other-ws',
    result.slug,
  );
  let slugTaken = null;
  try {
    await ingestMod.ingestAppFromDockerImage({
      docker_image_ref: 'ghcr.io/floomhq/ig-nano-scout:latest',
      workspace_id: 'another-ws',
      author_user_id: 'another-user',
      dockerClient: mockDocker,
      skipPull: true,
      skipInspect: true,
    });
  } catch (err) {
    slugTaken = err;
  }
  log(
    'cross-workspace slug collision throws SlugTakenError',
    Boolean(slugTaken) && slugTaken.name === 'SlugTakenError',
    slugTaken ? `${slugTaken.name}: ${slugTaken.message}` : 'no error thrown',
  );

  // ===================================================================
  // 6. Bad image reference is rejected before any daemon call
  // ===================================================================
  let badRef = null;
  try {
    await ingestMod.ingestAppFromDockerImage({
      docker_image_ref: 'not a ref!!',
      workspace_id: 'local',
      author_user_id: 'local',
      dockerClient: mockDocker,
      skipPull: true,
      skipInspect: true,
    });
  } catch (err) {
    badRef = err;
  }
  log(
    'invalid docker_image_ref is rejected',
    Boolean(badRef) && badRef.code === 'invalid_image_ref',
    badRef ? `${badRef.code}: ${badRef.message}` : 'no error thrown',
  );

  // ===================================================================
  // 7a. parseRegistry — extracts registry hostname from image refs
  // ===================================================================
  log(
    'parseRegistry(ghcr.io/org/repo:tag) is ghcr.io',
    ingestMod.parseRegistry('ghcr.io/openpaper-dev/ig-nano-scout:cli-v1') === 'ghcr.io',
  );
  log(
    'parseRegistry(docker.io/library/alpine:latest) is docker.io',
    ingestMod.parseRegistry('docker.io/library/alpine:latest') === 'docker.io',
  );
  log(
    'parseRegistry(library/alpine) defaults to docker.io',
    ingestMod.parseRegistry('library/alpine') === 'docker.io',
  );
  log(
    'parseRegistry(alpine:3.19) defaults to docker.io',
    ingestMod.parseRegistry('alpine:3.19') === 'docker.io',
  );
  log(
    'parseRegistry(custom:5000/team/app:v1) keeps port',
    ingestMod.parseRegistry('registry.example.com:5000/team/app:v1') ===
      'registry.example.com:5000',
  );
  log(
    'parseRegistry(localhost:5000/foo/bar) keeps port (colon heuristic)',
    ingestMod.parseRegistry('localhost:5000/foo/bar') === 'localhost:5000',
  );
  log(
    'parseRegistry(floomhq/ig-nano-scout) (no dot in prefix) defaults docker.io',
    ingestMod.parseRegistry('floomhq/ig-nano-scout') === 'docker.io',
  );

  // ===================================================================
  // 7b. loadRegistryAuth — reads FLOOM_REGISTRY_AUTH env var safely
  // ===================================================================
  const savedAuth = process.env.FLOOM_REGISTRY_AUTH;

  delete process.env.FLOOM_REGISTRY_AUTH;
  log(
    'loadRegistryAuth returns undefined when env unset',
    ingestMod.loadRegistryAuth('ghcr.io') === undefined,
  );

  process.env.FLOOM_REGISTRY_AUTH = '{not valid json';
  log(
    'loadRegistryAuth returns undefined on malformed JSON',
    ingestMod.loadRegistryAuth('ghcr.io') === undefined,
  );

  process.env.FLOOM_REGISTRY_AUTH = JSON.stringify({
    'ghcr.io': {
      username: 'test-user',
      serveraddress: 'ghcr.io',
      password: 'test-pat-xyz',
    },
  });
  const ghcrAuth = ingestMod.loadRegistryAuth('ghcr.io');
  log(
    'loadRegistryAuth returns entry for matching registry',
    ghcrAuth?.username === 'test-user' && ghcrAuth?.password === 'test-pat-xyz',
  );
  log(
    'loadRegistryAuth returns undefined for unmatched registry',
    ingestMod.loadRegistryAuth('registry.gitlab.com') === undefined,
  );

  // Restore prior env.
  if (savedAuth === undefined) {
    delete process.env.FLOOM_REGISTRY_AUTH;
  } else {
    process.env.FLOOM_REGISTRY_AUTH = savedAuth;
  }

  // ===================================================================
  // 7c. pullImage passes authconfig to docker.pull when registry has auth
  // ===================================================================
  process.env.FLOOM_REGISTRY_AUTH = JSON.stringify({
    'ghcr.io': {
      username: 'openpaper-dev',
      serveraddress: 'ghcr.io',
      password: 'ghcr-pat-secret',
    },
  });

  let capturedPullArgs = null;
  const passThroughStream = new (await import('node:stream')).Readable({
    read() {
      this.push(null);
    },
  });
  const capturingDocker = {
    pull: async (ref, opts) => {
      capturedPullArgs = { ref, opts };
      return passThroughStream;
    },
    modem: {
      followProgress: (_stream, onFinished) => {
        // Immediately resolve with no errors so pullImage returns cleanly.
        onFinished(null, []);
      },
    },
  };

  // Drive pullImage indirectly via a full ingest call with skipPull=false.
  // We bypass the outer flag check by setting it earlier.
  process.env.FLOOM_ENABLE_DOCKER_PUBLISH = 'true';
  await ingestMod.ingestAppFromDockerImage({
    docker_image_ref: 'ghcr.io/openpaper-dev/ig-nano-scout:cli-v1',
    slug: 'auth-pull-smoke',
    name: 'auth pull smoke',
    workspace_id: 'local',
    author_user_id: 'local',
    dockerClient: capturingDocker,
    skipInspect: true,
    ctx,
  });
  log(
    'pullImage forwarded imageRef to docker.pull',
    capturedPullArgs?.ref === 'ghcr.io/openpaper-dev/ig-nano-scout:cli-v1',
  );
  log(
    'pullImage passed authconfig for ghcr.io',
    capturedPullArgs?.opts?.authconfig?.username === 'openpaper-dev' &&
      capturedPullArgs?.opts?.authconfig?.password === 'ghcr-pat-secret',
  );

  // Now with no auth entry for the registry — opts should be empty.
  process.env.FLOOM_REGISTRY_AUTH = JSON.stringify({
    'gitlab.example.com': { username: 'x', password: 'y', serveraddress: 'gitlab.example.com' },
  });
  capturedPullArgs = null;
  await ingestMod.ingestAppFromDockerImage({
    docker_image_ref: 'ghcr.io/openpaper-dev/ig-nano-scout:cli-v1',
    slug: 'auth-pull-nomatch',
    name: 'auth pull nomatch',
    workspace_id: 'local',
    author_user_id: 'local',
    dockerClient: capturingDocker,
    skipInspect: true,
    ctx,
  });
  log(
    'pullImage omits authconfig when no registry entry matches',
    capturedPullArgs?.opts?.authconfig === undefined,
  );

  // Surface pull auth failure (401) as DockerImageIngestError, not a 500.
  const failingDocker = {
    pull: async () => passThroughStream,
    modem: {
      followProgress: (_stream, onFinished) => {
        onFinished(null, [
          {
            errorDetail: {
              message:
                '(HTTP code 401) unexpected - Head "https://ghcr.io/v2/openpaper-dev/ig-nano-scout/manifests/cli-v1": unauthorized',
            },
          },
        ]);
      },
    },
  };
  delete process.env.FLOOM_REGISTRY_AUTH;
  let pullErr = null;
  try {
    await ingestMod.ingestAppFromDockerImage({
      docker_image_ref: 'ghcr.io/openpaper-dev/ig-nano-scout:cli-v1',
      slug: 'auth-pull-401',
      name: 'auth pull 401',
      workspace_id: 'local',
      author_user_id: 'local',
      dockerClient: failingDocker,
      skipInspect: true,
      ctx,
    });
  } catch (err) {
    pullErr = err;
  }
  log(
    'private-registry pull without auth surfaces pull_failed with 401 text',
    Boolean(pullErr) &&
      pullErr.code === 'pull_failed' &&
      /401|unauthorized/i.test(pullErr.message),
    pullErr ? `${pullErr.code}: ${pullErr.message}` : 'no error thrown',
  );

  if (savedAuth === undefined) {
    delete process.env.FLOOM_REGISTRY_AUTH;
  } else {
    process.env.FLOOM_REGISTRY_AUTH = savedAuth;
  }

  // ===================================================================
  // 8. Flag off short-circuits ingestAppFromDockerImage itself
  // ===================================================================
  delete process.env.FLOOM_ENABLE_DOCKER_PUBLISH;
  let flagOff = null;
  try {
    await ingestMod.ingestAppFromDockerImage({
      docker_image_ref: 'ghcr.io/floomhq/ig-nano-scout:latest',
      workspace_id: 'local',
      author_user_id: 'local',
      dockerClient: mockDocker,
      skipPull: true,
      skipInspect: true,
    });
  } catch (err) {
    flagOff = err;
  }
  log(
    'ingestAppFromDockerImage rejects when flag is off',
    Boolean(flagOff) && flagOff.code === 'docker_publish_disabled',
    flagOff ? `${flagOff.code}: ${flagOff.message}` : 'no error thrown',
  );
  process.env.FLOOM_ENABLE_DOCKER_PUBLISH = 'true';

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
