#!/usr/bin/env node
// ADR-016 outbound network policy regression tests.
//
// Covers:
//   - explicit empty allowlist => Docker NetworkMode=none blocks egress
//   - explicit allowlist => internal bridge + CONNECT proxy permits that domain
//   - denied domains are blocked by the proxy
//   - invalid manifest allowlist entries are rejected at publish validation

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

let passed = 0;
let failed = 0;

function log(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`);
  }
}

async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function buildCurlImage() {
  const dir = mkdtempSync(join(tmpdir(), 'floom-network-policy-'));
  const tag = `floom-network-policy-test:${randomUUID().slice(0, 12)}`;
  writeFileSync(
    join(dir, 'Dockerfile'),
    `FROM alpine:3.20
RUN apk add --no-cache curl && adduser -D -u 1000 app
USER 1000:1000
ENTRYPOINT ["/bin/sh", "-c", "set -eu; curl -sS --max-time 20 -o /tmp/floom-response \\"$TARGET_URL\\"; printf '__FLOOM_RESULT__{\\"ok\\":true,\\"outputs\\":{\\"ok\\":true}}\\\\n'"]
`,
  );
  await execFileAsync('docker', ['build', '-q', '-t', tag, dir], { timeout: 120_000 });
  return {
    tag,
    cleanup: async () => {
      await execFileAsync('docker', ['rmi', '-f', tag]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function manifest(allowedDomains) {
  return {
    name: 'Network Policy Test',
    description: 'Exercises ADR-016 outbound network policy',
    actions: {
      run: {
        label: 'Run',
        inputs: [],
        outputs: [{ name: 'response', label: 'Response', type: 'json' }],
      },
    },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: ['TARGET_URL'],
    manifest_version: '2.0',
    network: { allowed_domains: allowedDomains },
  };
}

async function runCurl(runAppContainer, image, allowedDomains, targetUrl) {
  return await runAppContainer({
    appId: 'test-app',
    runId: `net-${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    action: 'run',
    inputs: {},
    secrets: { TARGET_URL: targetUrl },
    manifest: manifest(allowedDomains),
    image,
    timeoutMs: 45_000,
  });
}

console.log('trust-safety network deny policy');

if (!(await dockerAvailable())) {
  console.error('Docker daemon is required for this stress test');
  process.exit(1);
}

const { runAppContainer } = await import('../../apps/server/dist/services/docker.js');
const { normalizeManifest, ManifestError } = await import(
  '../../apps/server/dist/services/manifest.js'
);

let image;
try {
  image = await buildCurlImage();

  {
    const result = await runCurl(
      runAppContainer,
      image.tag,
      [],
      'https://example.com/',
    );
    const blocked = result.exitCode !== 0 && /Could not resolve|Failed to connect|Network is unreachable|Connection refused/i.test(result.stderr);
    log(
      'empty allowlist blocks curl to example.com',
      blocked,
      `exit=${result.exitCode} stderr=${result.stderr.slice(0, 200)}`,
    );
    assert.equal(blocked, true);
  }

  {
    const result = await runCurl(
      runAppContainer,
      image.tag,
      ['api.openai.com'],
      'https://api.openai.com/v1/models',
    );
    log(
      'allowlist api.openai.com permits curl to api.openai.com',
      result.exitCode === 0,
      `exit=${result.exitCode} stderr=${result.stderr.slice(0, 200)}`,
    );
    assert.equal(result.exitCode, 0);
  }

  {
    const result = await runCurl(
      runAppContainer,
      image.tag,
      ['api.openai.com'],
      'https://example.com/',
    );
    const blocked = result.exitCode !== 0 && /CONNECT tunnel failed|Forbidden|Blocked by Floom network policy/i.test(result.stderr);
    log(
      'allowlist api.openai.com blocks curl to example.com',
      blocked,
      `exit=${result.exitCode} stderr=${result.stderr.slice(0, 200)}`,
    );
    assert.equal(blocked, true);
  }

  {
    let rejected = false;
    try {
      normalizeManifest(
        {
          ...manifest(['*']),
          manifest_version: '2.0',
        },
        { requireNetworkDeclaration: true },
      );
    } catch (err) {
      rejected = err instanceof ManifestError && /cannot be "\*"/.test(err.message);
    }
    log('manifest wildcard "*" is rejected at publish validation', rejected);
    assert.equal(rejected, true);
  }

  {
    let rejected = false;
    try {
      normalizeManifest(
        {
          ...manifest(['127.0.0.1']),
          manifest_version: '2.0',
        },
        { requireNetworkDeclaration: true },
      );
    } catch (err) {
      rejected = err instanceof ManifestError && /not an IP address/.test(err.message);
    }
    log('manifest private IP is rejected at publish validation', rejected);
    assert.equal(rejected, true);
  }
} finally {
  if (image) await image.cleanup();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
