#!/usr/bin/env node
// Unit test for resolveBaseUrl: auto-extract base URL from spec.servers[]
// (OpenAPI 3.x) and spec.host/basePath (Swagger 2.0), with variable
// substitution and explicit override precedence.
//
// Run: node test/stress/test-resolve-base-url.mjs

import { resolveBaseUrl } from '../../apps/server/dist/services/openapi-ingest.js';

let passed = 0;
let failed = 0;

function assertEq(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`    expected: ${expected}`);
    console.log(`    actual:   ${actual}`);
  }
}

console.log('resolveBaseUrl tests');

// OpenAPI 3.x: spec.servers[0].url
assertEq(
  resolveBaseUrl(
    { servers: [{ url: 'https://api.openai.com/v1' }] },
    { slug: 'openai', type: 'proxied' },
  ),
  'https://api.openai.com/v1',
  'openai /v1 from servers[0]',
);

// Stripe: first server
assertEq(
  resolveBaseUrl(
    { servers: [{ url: 'https://api.stripe.com/v1' }] },
    { slug: 'stripe', type: 'proxied' },
  ),
  'https://api.stripe.com/v1',
  'stripe /v1 from servers[0]',
);

// Petstore
assertEq(
  resolveBaseUrl(
    {
      servers: [
        { url: 'https://petstore3.swagger.io/api/v3' },
        { url: 'https://petstore.swagger.io/v2' },
      ],
    },
    { slug: 'petstore', type: 'proxied' },
  ),
  'https://petstore3.swagger.io/api/v3',
  'petstore first of 2 servers',
);

// Variable substitution (e.g. Slack)
assertEq(
  resolveBaseUrl(
    {
      servers: [
        {
          url: 'https://{hostname}/api',
          variables: { hostname: { default: 'slack.com' } },
        },
      ],
    },
    { slug: 'slack', type: 'proxied' },
  ),
  'https://slack.com/api',
  'single variable substitution',
);

// Multiple variables (environment + region)
assertEq(
  resolveBaseUrl(
    {
      servers: [
        {
          url: 'https://{env}.api.example.com/{region}/v1',
          variables: {
            env: { default: 'prod' },
            region: { default: 'us' },
          },
        },
      ],
    },
    { slug: 'example', type: 'proxied' },
  ),
  'https://prod.api.example.com/us/v1',
  'two variable substitutions',
);

// Explicit override wins over servers[]
assertEq(
  resolveBaseUrl(
    { servers: [{ url: 'https://api.openai.com/v1' }] },
    {
      slug: 'openai',
      type: 'proxied',
      base_url: 'https://my-proxy.example.com/v1',
    },
  ),
  'https://my-proxy.example.com/v1',
  'apps.yaml base_url override wins over servers[]',
);

// Swagger 2.0 fallback: host + basePath
assertEq(
  resolveBaseUrl(
    {
      swagger: '2.0',
      host: 'petstore.swagger.io',
      basePath: '/v2',
      schemes: ['https'],
    },
    { slug: 'petstore', type: 'proxied' },
  ),
  'https://petstore.swagger.io/v2',
  'swagger 2.0 host + basePath',
);

// Swagger 2.0 without explicit schemes defaults to https
assertEq(
  resolveBaseUrl(
    { swagger: '2.0', host: 'api.example.com', basePath: '/v1' },
    { slug: 'example', type: 'proxied' },
  ),
  'https://api.example.com/v1',
  'swagger 2.0 defaults to https',
);

// No servers, no host, no override → null
assertEq(
  resolveBaseUrl({}, { slug: 'empty', type: 'proxied' }),
  null,
  'empty spec returns null',
);

// Server URL is relative and no fetch URL context → null
assertEq(
  resolveBaseUrl(
    { servers: [{ url: '/api' }] },
    { slug: 'relative', type: 'proxied' },
  ),
  null,
  'relative server URL with no fetch context returns null',
);

// Spec-relative server URL resolved against fetch URL (Petstore pattern)
assertEq(
  resolveBaseUrl(
    { servers: [{ url: '/api/v3' }] },
    { slug: 'petstore', type: 'proxied' },
    'https://petstore3.swagger.io/api/v3/openapi.json',
  ),
  'https://petstore3.swagger.io/api/v3',
  'petstore spec-relative server URL',
);

// Last-resort: no servers, no host, but fetch URL provides origin
assertEq(
  resolveBaseUrl(
    {},
    { slug: 'noservers', type: 'proxied' },
    'https://api.example.com/openapi.json',
  ),
  'https://api.example.com',
  'last-resort fetch URL origin',
);

// GitHub (no servers block in older spec, but has host in Swagger 2)
assertEq(
  resolveBaseUrl(
    { servers: [{ url: 'https://api.github.com' }] },
    { slug: 'github', type: 'proxied' },
  ),
  'https://api.github.com',
  'github root base',
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
