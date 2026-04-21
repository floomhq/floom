#!/usr/bin/env node
// Regression test for OPENAPI-INGEST-SECURITY-SCHEMES (2026-04-21):
//
// The OpenAPI ingester used to read OpenAPI 3.x
// `components.securitySchemes` only, missing two latent bugs:
//
//   1. Swagger 2.x specs declare `securityDefinitions` at the spec root,
//      not under `components`. Those were silently ignored, so any
//      operation requiring `api_key` via Swagger 2 got rendered as a
//      plaintext textbox in the run form (the request-level `api_key`
//      header parameter also appeared as a plain input).
//
//   2. Even on OpenAPI 3 specs, creators sometimes declare the auth key
//      as a regular parameter (name `api_key`, `apikey`, `X-API-Key`,
//      `access_token`, etc.) without wiring up `security` / `securitySchemes`.
//      The ingester emitted these as `type: text` inputs, meaning the UI
//      rendered the API key as a visible form field that gets logged and
//      stored un-scoped alongside normal request data.
//
// Fix: (a) merge OpenAPI 3 `components.securitySchemes` + Swagger 2
// `securityDefinitions` via `collectSecuritySchemes`, and (b) regex-
// lift any parameter whose name matches the AUTH_PARAM_REGEX into
// `secrets_needed` and remove it from the action's `inputs`.
//
// Run: node test/stress/test-ingest-swagger2-and-regex.mjs

process.env.FLOOM_MAX_ACTIONS_PER_APP = '0';

const {
  specToManifest,
  dereferenceSpec,
  deriveSecretsFromSpec,
  collectSecuritySchemes,
} = await import('../../apps/server/dist/services/openapi-ingest.js');

if (typeof specToManifest !== 'function') {
  console.error('FAIL: specToManifest is not exported from openapi-ingest');
  process.exit(1);
}
if (typeof collectSecuritySchemes !== 'function') {
  console.error('FAIL: collectSecuritySchemes is not exported from openapi-ingest');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function assertEqual(label, actual, expected) {
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

function mkAppSpec(slug, displayName) {
  return {
    slug,
    type: 'proxied',
    openapi_spec_url: 'https://example.test/openapi.json',
    display_name: displayName,
    auth: 'none',
  };
}

function buildManifest(spec, slug, displayName) {
  const derived = deriveSecretsFromSpec(spec);
  return specToManifest(spec, mkAppSpec(slug, displayName), derived);
}

// ---------- Test 1: OpenAPI 3 with explicit securitySchemes ----------

console.log('Test 1: OpenAPI 3 spec with components.securitySchemes (apiKey header)');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'OAS3', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    security: [{ api_key: [] }],
    components: {
      securitySchemes: {
        api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Your API key' },
      },
    },
    paths: {
      '/resource': {
        get: {
          operationId: 'getResource',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };

  const manifest = buildManifest(spec, 'oas3-apikey', 'OAS3 ApiKey');
  assertIncludes(
    'manifest.secrets_needed includes api_key (scheme name)',
    manifest.secrets_needed,
    'api_key',
  );
  assertEqual(
    'getResource.secrets_needed === [api_key]',
    manifest.actions.getResource.secrets_needed,
    ['api_key'],
  );
  const plaintextInputs = manifest.actions.getResource.inputs.filter((i) =>
    /api[-_]?key|x-api-key/i.test(i.name),
  );
  assertEqual(
    'no plaintext input named api_key / X-API-Key on getResource',
    plaintextInputs.map((i) => i.name),
    [],
  );
}

// ---------- Test 2: Swagger 2.0 with securityDefinitions ----------

console.log('\nTest 2: Swagger 2.0 spec with root-level securityDefinitions');
{
  const spec = {
    swagger: '2.0',
    info: { title: 'Swagger2', version: '1.0' },
    host: 'example.com',
    basePath: '/v2',
    schemes: ['https'],
    security: [{ api_key: [] }],
    securityDefinitions: {
      api_key: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Legacy Swagger-2 API key',
      },
    },
    paths: {
      '/widget': {
        get: {
          operationId: 'getWidget',
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };

  const schemes = collectSecuritySchemes(spec);
  assertEqual(
    'collectSecuritySchemes surfaces Swagger-2 securityDefinitions',
    Object.keys(schemes).sort(),
    ['api_key'],
  );
  assertEqual(
    'api_key scheme type carried through from Swagger 2',
    schemes.api_key.type,
    'apiKey',
  );

  const manifest = buildManifest(spec, 'swagger2-apikey', 'Swagger 2 ApiKey');
  assertIncludes(
    'Swagger-2 manifest.secrets_needed includes api_key',
    manifest.secrets_needed,
    'api_key',
  );
  assertEqual(
    'Swagger-2 getWidget.secrets_needed === [api_key]',
    manifest.actions.getWidget.secrets_needed,
    ['api_key'],
  );
}

// ---------- Test 3: Regex fallback lifts auth-ish param names ----------

console.log('\nTest 3: regex fallback — creator forgot to declare a security scheme');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'NoScheme', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    // No security, no securitySchemes.
    paths: {
      '/search': {
        get: {
          operationId: 'search',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'api_key', in: 'query', required: true, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };

  const manifest = buildManifest(spec, 'regex-lift', 'Regex Lift');
  assertIncludes(
    'app-level secrets_needed includes api_key (regex lift)',
    manifest.secrets_needed,
    'api_key',
  );
  assertEqual(
    'search.secrets_needed === [api_key] from regex lift',
    manifest.actions.search.secrets_needed,
    ['api_key'],
  );
  const leakedInputs = manifest.actions.search.inputs.filter((i) => i.name === 'api_key');
  assertEqual(
    'search.inputs no longer contains a plaintext api_key input',
    leakedInputs,
    [],
  );
  // Non-auth inputs (like `q`) must still be there.
  assertIncludes(
    'search.inputs still contains non-auth `q` param',
    manifest.actions.search.inputs.map((i) => i.name),
    'q',
  );
}

// ---------- Test 4: Regex fallback handles header-prefixed names ----------

console.log('\nTest 4: regex fallback — header_X-API-Key stripped + lifted');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'HeaderKey', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    paths: {
      '/call': {
        get: {
          operationId: 'call',
          parameters: [
            // Header param — ingest will rename it to `header_X-API-Key`.
            { name: 'X-API-Key', in: 'header', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };

  const manifest = buildManifest(spec, 'header-lift', 'Header Lift');
  assertIncludes(
    'header-prefixed X-API-Key is lifted (stripped back to bare name)',
    manifest.actions.call.secrets_needed,
    'X-API-Key',
  );
  assertNotIncludes(
    'header_X-API-Key no longer appears as an input',
    manifest.actions.call.inputs.map((i) => i.name),
    'header_X-API-Key',
  );
  assertIncludes(
    'non-auth `limit` query param still present',
    manifest.actions.call.inputs.map((i) => i.name),
    'limit',
  );
}

// ---------- Test 5: Regex does not over-match ----------

console.log('\nTest 5: regex does NOT lift non-auth params that merely contain "key"');
{
  const spec = {
    openapi: '3.0.0',
    info: { title: 'NoLift', version: '1.0' },
    servers: [{ url: 'https://example.com' }],
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [
            { name: 'sort_key', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'keywords', in: 'query', required: false, schema: { type: 'string' } },
            { name: 'publicKey', in: 'query', required: false, schema: { type: 'string' } },
          ],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  };

  const manifest = buildManifest(spec, 'no-lift', 'No Lift');
  assertEqual(
    'sort_key / keywords / publicKey are NOT lifted (regex is anchored)',
    manifest.actions.listItems.secrets_needed,
    [],
  );
  const inputNames = manifest.actions.listItems.inputs.map((i) => i.name).sort();
  assertEqual(
    'listItems.inputs still contains all three original params',
    inputNames,
    ['keywords', 'publicKey', 'sort_key'],
  );
}

// ---------- Summary ----------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
