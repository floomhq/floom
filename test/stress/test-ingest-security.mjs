#!/usr/bin/env node
// Regression test for the OpenAPI → Floom secret-derivation pipeline.
//
// Two overlapping behaviors are covered:
//
// (a) App-level `manifest.secrets_needed` must list every secret a user
//     could ever need to configure. We derive this by walking
//     `components.securitySchemes` directly — presence of a scheme is
//     treated as a request for that secret, even when the spec omits
//     `security` requirement blocks. This is the fix for the secrets
//     deadlock (2026-04-20): specs with schemes but no `security`
//     requirements used to produce empty `secrets_needed`, leaving
//     users with an API that returns 401/403 and a Studio panel that
//     shows "nothing to configure".
//
//     Naming rules (encoded in `deriveAuthFromSpec`):
//       - apiKey  → UPPER_SNAKE_CASE of the scheme's `name` attr
//                   (fallback: scheme key)
//       - bearer  → "BEARER_TOKEN" (or "<KEY>_BEARER_TOKEN" if multi)
//       - basic   → "BASIC_AUTH_USER" + "BASIC_AUTH_PASS"
//       - oauth2  → skipped (handled out-of-band)
//
// (b) Per-action `actions.<name>.secrets_needed` respects per-operation
//     `security` overrides (OpenAPI 3.x §4.8.10): operation-level
//     replaces global, alternatives are OR-combined. The proxied-runner
//     blocks each action only when ITS required secrets are missing, so
//     public ops run even when other ops in the same spec need auth.
//
// Run: node test/stress/test-ingest-security.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

process.env.FLOOM_MAX_ACTIONS_PER_APP = '0';

const { specToManifest, dereferenceSpec, deriveSecretsFromSpec, deriveAuthFromSpec } =
  await import('../../apps/server/dist/services/openapi-ingest.js');

if (typeof specToManifest !== 'function') {
  console.error('FAIL: specToManifest is not exported from openapi-ingest');
  process.exit(1);
}
if (typeof deriveSecretsFromSpec !== 'function') {
  console.error('FAIL: deriveSecretsFromSpec is not exported from openapi-ingest');
  process.exit(1);
}
if (typeof deriveAuthFromSpec !== 'function') {
  console.error('FAIL: deriveAuthFromSpec is not exported from openapi-ingest');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assertDeepEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${e}`);
    console.log(`        actual:   ${a}`);
  }
}

function assertIncludes(label, arr, value) {
  if (Array.isArray(arr) && arr.includes(value)) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected ${JSON.stringify(arr)} to include ${JSON.stringify(value)}`);
  }
}

function assertNotIncludes(label, arr, value) {
  if (!Array.isArray(arr) || !arr.includes(value)) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        expected ${JSON.stringify(arr)} to NOT include ${JSON.stringify(value)}`);
  }
}

const CACHE_DIR = '/tmp/floom-stress-specs';
const PETSTORE_URL = 'https://petstore3.swagger.io/api/v3/openapi.json';

async function fetchPetstore() {
  const cachePath = `${CACHE_DIR}/petstore-security.json`;
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  }
  console.log(`  [fetch] ${PETSTORE_URL}`);
  const res = await fetch(PETSTORE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${PETSTORE_URL}`);
  const spec = await res.json();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(spec));
  return spec;
}

// Build an ingest-style appSpec object.
function mkAppSpec(slug, displayName) {
  return {
    slug,
    type: 'proxied',
    openapi_spec_url: 'https://example.test/openapi.json',
    display_name: displayName,
    auth: 'none',
  };
}

// Mirror the production call path in ingestAppFromUrl:
//   const { secrets, authSchemes } = deriveAuthFromSpec(spec);
//   specToManifest(spec, appSpec, secrets, authSchemes);
// This exercises both the derivation logic and the manifest assembly.
function buildManifest(spec, slug, displayName) {
  const derived = deriveAuthFromSpec(spec);
  return specToManifest(
    spec,
    mkAppSpec(slug, displayName),
    derived.secrets,
    derived.authSchemes,
  );
}

// ---------- Test 1: real petstore spec ----------

console.log('Test 1: real petstore spec → per-action secrets_needed');
{
  const raw = await fetchPetstore();
  const spec = await dereferenceSpec(raw);
  const manifest = buildManifest(spec, 'petstore-test', 'Petstore');

  // App-level: petstore declares `api_key` (apiKey scheme, name="api_key")
  // and `petstore_auth` (oauth2). Only api_key produces a manifest
  // secret, normalized to UPPER_SNAKE_CASE of its `name` attribute.
  assertDeepEqual(
    'petstore app-level secrets_needed is [API_KEY] (from api_key scheme)',
    manifest.secrets_needed,
    ['API_KEY'],
  );

  // Per-action: the demo-critical operations must NOT require API_KEY.
  const findPetsByStatus = manifest.actions.findPetsByStatus;
  if (!findPetsByStatus) {
    failed++;
    console.log('  FAIL  petstore manifest missing findPetsByStatus');
  } else {
    assertDeepEqual(
      'findPetsByStatus.secrets_needed === [] (uses petstore_auth oauth2)',
      findPetsByStatus.secrets_needed,
      [],
    );
  }

  const addPet = manifest.actions.addPet;
  if (!addPet) {
    failed++;
    console.log('  FAIL  petstore manifest missing addPet');
  } else {
    assertDeepEqual(
      'addPet.secrets_needed === [] (uses petstore_auth oauth2)',
      addPet.secrets_needed,
      [],
    );
  }

  const getInventory = manifest.actions.getInventory;
  if (!getInventory) {
    failed++;
    console.log('  FAIL  petstore manifest missing getInventory');
  } else {
    assertDeepEqual(
      'getInventory.secrets_needed === [API_KEY] (strict op-level requirement)',
      getInventory.secrets_needed,
      ['API_KEY'],
    );
  }

  // getPetById has alternatives (api_key OR petstore_auth) → intersection
  // is empty → not strictly required.
  const getPetById = manifest.actions.getPetById;
  if (!getPetById) {
    failed++;
    console.log('  FAIL  petstore manifest missing getPetById');
  } else {
    assertDeepEqual(
      'getPetById.secrets_needed === [] (alternatives, intersection is empty)',
      getPetById.secrets_needed,
      [],
    );
  }

  // auth_schemes field surfaces the apiKey scheme's transport info so
  // the runner knows where to inject the credential.
  if (!Array.isArray(manifest.auth_schemes)) {
    failed++;
    console.log('  FAIL  petstore manifest missing auth_schemes array');
  } else {
    assertDeepEqual(
      'petstore auth_schemes describes the api_key header',
      manifest.auth_schemes,
      [{ key: 'API_KEY', type: 'apiKey', in: 'header', name: 'api_key' }],
    );
  }
}

// ---------- Test 2: global api_key security, no operation override ----------

console.log('\nTest 2: global api_key security, operation does NOT override');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ api_key: [] }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    paths: {
      '/thing': {
        get: {
          operationId: 'getThing',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'global-inherit', 'Global Inherit');
  assertIncludes(
    'secrets_needed includes X_API_KEY (normalized from name attr)',
    manifest.secrets_needed,
    'X_API_KEY',
  );
}

// ---------- Test 3: operation security: [] overrides global ----------

console.log('\nTest 3: operation security: [] overrides global (OpenAPI 3)');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ api_key: [] }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    paths: {
      '/public': {
        get: {
          operationId: 'getPublic',
          security: [], // explicit override: no auth for this op
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'empty-override', 'Empty Override');
  // App-level still surfaces X_API_KEY because the scheme is declared —
  // users may want to configure it even though the only ingested op is
  // explicitly public. Per-action secrets_needed stays [] so the runner
  // does not block getPublic.
  assertDeepEqual(
    'app-level secrets_needed includes X_API_KEY from scheme walk',
    manifest.secrets_needed,
    ['X_API_KEY'],
  );
  assertDeepEqual(
    'getPublic.secrets_needed === [] (explicit security: [] override)',
    manifest.actions.getPublic.secrets_needed,
    [],
  );
}

// ---------- Test 4: operation security: [{other}] overrides global ----------

console.log('\nTest 4: operation security references a DIFFERENT scheme');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ api_key: [] }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
        other_key: { type: 'apiKey', name: 'X-Other-Key', in: 'header' },
      },
    },
    paths: {
      '/other': {
        get: {
          operationId: 'getOther',
          security: [{ other_key: [] }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'other-override', 'Other Override');
  // Both schemes are declared, so both appear app-level. Per-action
  // secrets_needed still respects the override (only X_OTHER_KEY).
  assertIncludes(
    'app-level secrets_needed includes X_OTHER_KEY',
    manifest.secrets_needed,
    'X_OTHER_KEY',
  );
  assertIncludes(
    'app-level secrets_needed includes X_API_KEY (scheme is declared)',
    manifest.secrets_needed,
    'X_API_KEY',
  );
  assertDeepEqual(
    'getOther.secrets_needed === [X_OTHER_KEY] (op override narrows it)',
    manifest.actions.getOther.secrets_needed,
    ['X_OTHER_KEY'],
  );
}

// ---------- Test 5: operation-level security only, no global ----------

console.log('\nTest 5: no global security, operation declares api_key');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    paths: {
      '/secure': {
        get: {
          operationId: 'getSecure',
          security: [{ api_key: [] }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'op-level', 'Op Level');
  assertIncludes(
    'secrets_needed includes X_API_KEY from scheme declaration',
    manifest.secrets_needed,
    'X_API_KEY',
  );
  assertDeepEqual(
    'getSecure.secrets_needed === [X_API_KEY]',
    manifest.actions.getSecure.secrets_needed,
    ['X_API_KEY'],
  );
}

// ---------- Test 6: no security anywhere ----------

console.log('\nTest 6: no security declared anywhere');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    paths: {
      '/ping': {
        get: {
          operationId: 'ping',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'no-sec', 'No Sec');
  assertDeepEqual(
    'secrets_needed empty when no security declared',
    manifest.secrets_needed,
    [],
  );
}

// ---------- Test 7: mixed operations — one requires, one public ----------

console.log('\nTest 7: mixed ops — one public, one requires api_key');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Mixed', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ api_key: [] }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    },
    paths: {
      '/public': {
        get: {
          operationId: 'publicOp',
          security: [], // no auth
          responses: { '200': { description: 'ok' } },
        },
      },
      '/private': {
        post: {
          operationId: 'privateOp',
          // inherits global security (api_key)
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'mixed', 'Mixed');
  assertIncludes(
    'secrets_needed includes X_API_KEY (privateOp still requires it)',
    manifest.secrets_needed,
    'X_API_KEY',
  );
  assertDeepEqual(
    'publicOp.secrets_needed === [] (explicit security: [] override)',
    manifest.actions.publicOp.secrets_needed,
    [],
  );
}

// ---------- Test 8: alternatives (A OR B) — neither strictly required ----------

console.log('\nTest 8: op-level alternatives (A OR B) — neither strictly required');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Alternatives', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
        oauth2: {
          type: 'oauth2',
          flows: { implicit: { authorizationUrl: 'https://example.com/oauth', scopes: {} } },
        },
      },
    },
    paths: {
      '/either': {
        get: {
          operationId: 'getEither',
          // Caller may choose api_key OR oauth2. Intersection is empty,
          // so neither scheme is strictly required.
          security: [{ api_key: [] }, { oauth2: [] }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'alternatives', 'Alternatives');
  // Even when every op offers alternatives (so none is strictly
  // required), the scheme is declared and thus appears app-level so the
  // user can configure it up-front. The per-action list stays empty so
  // the runner does not block the op.
  assertIncludes(
    'app-level secrets_needed includes X_API_KEY (scheme is declared)',
    manifest.secrets_needed,
    'X_API_KEY',
  );
  assertDeepEqual(
    'getEither.secrets_needed === [] (alternatives — nothing strictly required)',
    manifest.actions.getEither.secrets_needed,
    [],
  );
}

// ---------- Test 9: http bearer scheme ----------

console.log('\nTest 9: http bearer scheme → BEARER_TOKEN');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Bearer', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/me': {
        get: {
          operationId: 'getMe',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'bearer-app', 'Bearer App');
  assertDeepEqual(
    'bearer single-scheme secrets_needed === [BEARER_TOKEN]',
    manifest.secrets_needed,
    ['BEARER_TOKEN'],
  );
  assertDeepEqual(
    'bearer single-scheme auth_schemes[0]',
    manifest.auth_schemes,
    [{ key: 'BEARER_TOKEN', type: 'bearer' }],
  );
}

// ---------- Test 10: http basic scheme ----------

console.log('\nTest 10: http basic scheme → USER + PASS pair');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Basic', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ basicAuth: [] }],
    components: {
      securitySchemes: {
        basicAuth: { type: 'http', scheme: 'basic' },
      },
    },
    paths: {
      '/admin': {
        get: {
          operationId: 'getAdmin',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'basic-app', 'Basic App');
  assertDeepEqual(
    'basic scheme emits BASIC_AUTH_USER + BASIC_AUTH_PASS',
    manifest.secrets_needed,
    ['BASIC_AUTH_USER', 'BASIC_AUTH_PASS'],
  );
}

// ---------- Test 11: multiple bearer schemes are disambiguated ----------

console.log('\nTest 11: multiple bearer schemes → prefixed keys');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Two Bearers', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    components: {
      securitySchemes: {
        adminBearer: { type: 'http', scheme: 'bearer' },
        userBearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths: {
      '/ping': {
        get: { operationId: 'ping', responses: { '200': { description: 'ok' } } },
      },
    },
  };
  const manifest = buildManifest(spec, 'two-bearers', 'Two Bearers');
  assertIncludes(
    'secrets_needed includes ADMIN_BEARER_BEARER_TOKEN',
    manifest.secrets_needed,
    'ADMIN_BEARER_BEARER_TOKEN',
  );
  assertIncludes(
    'secrets_needed includes USER_BEARER_BEARER_TOKEN',
    manifest.secrets_needed,
    'USER_BEARER_BEARER_TOKEN',
  );
  assertNotIncludes(
    'secrets_needed does NOT include plain BEARER_TOKEN when multiple bearers exist',
    manifest.secrets_needed,
    'BEARER_TOKEN',
  );
}

// ---------- Test 12: schemes without `security` still surface ----------

console.log('\nTest 12: spec declares schemes but no `security` → still surfaced');
{
  // Real-world deadlock case (2026-04-20): spec ships with
  // components.securitySchemes but forgets global/per-op `security`.
  // Upstream still rejects unauthenticated requests with 401 at
  // runtime, so we must list the scheme anyway — otherwise Studio
  // shows nothing to configure and the user is stranded.
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Deadlock', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    components: {
      securitySchemes: {
        myToken: { type: 'apiKey', name: 'X-My-Token', in: 'header' },
      },
    },
    paths: {
      '/thing': {
        get: {
          operationId: 'getThing',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const manifest = buildManifest(spec, 'deadlock', 'Deadlock');
  assertDeepEqual(
    'schemes surface even without `security` blocks',
    manifest.secrets_needed,
    ['X_MY_TOKEN'],
  );
  assertDeepEqual(
    'auth_schemes describes the apiKey transport',
    manifest.auth_schemes,
    [{ key: 'X_MY_TOKEN', type: 'apiKey', in: 'header', name: 'X-My-Token' }],
  );
}

// ---------- Summary ----------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
