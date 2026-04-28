#!/usr/bin/env node
// Launch-demo seeder unit tests.
//
// Exercises:
//   1. fingerprintDemoContext is deterministic for identical content
//   2. ignored directories do not churn the fingerprint
//   3. content changes produce a new fingerprint + image tag

import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-launch-demos-'));
process.env.DATA_DIR = join(tmp, 'data');

const {
  fingerprintDemoContext,
  imageTagForDemo,
  DEMOS,
} = await import('../../apps/server/src/services/launch-demos.ts');

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

const contextDir = join(tmp, 'demo');
mkdirSync(contextDir, { recursive: true });
writeFileSync(join(contextDir, 'Dockerfile'), 'FROM python:3.12-slim\n');
writeFileSync(join(contextDir, 'main.py'), 'print("hello")\n');

const baseFingerprint = fingerprintDemoContext(contextDir);
const baseTag = imageTagForDemo({ slug: 'competitor-lens' }, contextDir);

log(
  'fingerprintDemoContext: deterministic',
  baseFingerprint === fingerprintDemoContext(contextDir),
);
log(
  'imageTagForDemo: prefixes with slug + ctx- hash',
  /^floom-demo-competitor-lens:ctx-[0-9a-f]{16}$/.test(baseTag),
);

mkdirSync(join(contextDir, '__pycache__'), { recursive: true });
writeFileSync(join(contextDir, '__pycache__', 'ignored.pyc'), 'noise');
log(
  'fingerprintDemoContext: ignores __pycache__ churn',
  baseFingerprint === fingerprintDemoContext(contextDir),
);

writeFileSync(join(contextDir, 'main.py'), 'print("hello v2")\n');
const changedFingerprint = fingerprintDemoContext(contextDir);
const changedTag = imageTagForDemo({ slug: 'competitor-lens' }, contextDir);
log(
  'fingerprintDemoContext: content changes update fingerprint',
  changedFingerprint !== baseFingerprint,
);
log(
  'imageTagForDemo: content changes update image tag',
  changedTag !== baseTag,
);

rmSync(tmp, { recursive: true, force: true });

// Regression guard (Federico 2026-04-23, updated 2026-04-25 after roster
// swap): every launch demo that routes through the BYOK gate must declare
// GEMINI_API_KEY in its seeded manifest, otherwise the runner will not
// inject the server-side key and free-tier runs return an auth_error
// instead of succeeding. Original incident: Federico asked "shouldnt
// resume_screener have a gemini api key secret?" — all 3 manifests did
// declare it. The roster was swapped on 2026-04-25 to bounded <5s demos
// (competitor-lens, ai-readiness-audit, pitch-coach); the same invariant
// applies to the new 3. This test prevents silent regression.
const BYOK_GATED = ['competitor-lens', 'ai-readiness-audit', 'pitch-coach'];
for (const slug of BYOK_GATED) {
  const demo = DEMOS.find((d) => d.slug === slug);
  log(
    `launch demo ${slug} is present in seeder`,
    demo !== undefined,
    demo ? undefined : 'DEMOS missing the slug entry',
  );
  if (!demo) continue;
  const secrets = demo.manifest?.secrets_needed ?? [];
  log(
    `launch demo ${slug} declares GEMINI_API_KEY`,
    secrets.includes('GEMINI_API_KEY'),
    `secrets_needed = ${JSON.stringify(secrets)}`,
  );
}

const linkedinRoaster = DEMOS.find((d) => d.slug === 'linkedin-roaster');
log(
  'launch demo linkedin-roaster is present in seeder',
  linkedinRoaster !== undefined,
  linkedinRoaster ? undefined : 'DEMOS missing the slug entry',
);

console.log(`\npassed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
