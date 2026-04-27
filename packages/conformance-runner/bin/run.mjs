#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONCERNS = new Set([
  'runtime',
  'storage',
  'auth',
  'secrets',
  'observability',
]);

function usage() {
  console.error(
    [
      'Usage:',
      '  node packages/conformance-runner/bin/run.mjs --concern <runtime|storage|auth|secrets|observability> --adapter <name|module|path>',
      '',
      'Examples:',
      '  node packages/conformance-runner/bin/run.mjs --concern storage --adapter sqlite',
      '  node packages/conformance-runner/bin/run.mjs --concern runtime --adapter ./my-runtime-adapter.mjs',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--concern') {
      out.concern = argv[++i];
    } else if (arg === '--adapter') {
      out.adapter = argv[++i];
    } else if (arg === '-h' || arg === '--help') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function prefixStream(stream, prefix, write) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      write(`${prefix}${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffered) write(`${prefix}${buffered}\n`);
  });
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  usage();
  process.exit(2);
}

if (args.help) {
  usage();
  process.exit(0);
}

if (!CONCERNS.has(args.concern) || !args.adapter) {
  usage();
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const suite = join(
  repoRoot,
  'test',
  'stress',
  `test-adapters-${args.concern}-contract.mjs`,
);

if (!existsSync(suite)) {
  console.error(`[conformance:${args.concern}] missing suite: ${suite}`);
  process.exit(2);
}

const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const command = existsSync(tsxBin) ? tsxBin : 'tsx';
const env = {
  ...process.env,
  [`FLOOM_${args.concern.toUpperCase()}`]: args.adapter,
  FLOOM_CONFORMANCE_CONCERN: args.concern,
  FLOOM_CONFORMANCE_ADAPTER: args.adapter,
};

if (args.concern === 'secrets' && args.adapter === '@floomhq/secrets-gcp-kms') {
  env.FLOOM_GCP_KMS_MOCK = '1';
  env.FLOOM_GCP_KMS_KEY_NAME =
    'projects/test/locations/global/keyRings/test/cryptoKeys/test';
}

console.log(
  `[conformance:${args.concern}] adapter=${args.adapter} suite=${suite}`,
);

const child = spawn(command, [suite], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

prefixStream(child.stdout, `[conformance:${args.concern}] `, (text) =>
  process.stdout.write(text),
);
prefixStream(child.stderr, `[conformance:${args.concern}:err] `, (text) =>
  process.stderr.write(text),
);

child.on('error', (err) => {
  console.error(`[conformance:${args.concern}] failed to start: ${err.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error(`[conformance:${args.concern}] suite terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
