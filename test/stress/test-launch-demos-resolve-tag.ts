#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-launch-demos-resolve-'));
process.env.DATA_DIR = join(tmp, 'data');

type LaunchDemoDockerLike =
  import('../../apps/server/src/services/launch-demos.ts').LaunchDemoDockerLike;
type SeedLogger = import('../../apps/server/src/services/launch-demos.ts').SeedLogger;

type LogEntry = {
  level: 'log' | 'warn' | 'error';
  args: unknown[];
};

function createLogger(): { logger: SeedLogger; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  return {
    logger: {
      log: (...args) => logs.push({ level: 'log', args }),
      warn: (...args) => logs.push({ level: 'warn', args }),
      error: (...args) => logs.push({ level: 'error', args }),
    },
    logs,
  };
}

function createDockerMock(opts: {
  imageChecks: Record<string, boolean[]>;
  buildResult: 'success' | 'failure';
  buildError?: string;
}): LaunchDemoDockerLike & { buildCalls: string[]; inspectCalls: string[] } {
  const sequences = new Map(
    Object.entries(opts.imageChecks).map(([tag, values]) => [tag, [...values]]),
  );
  const buildCalls: string[] = [];
  const inspectCalls: string[] = [];
  const stream = {};

  return {
    buildCalls,
    inspectCalls,
    async ping() {
      return undefined;
    },
    async buildImage(_file, buildOpts) {
      buildCalls.push(buildOpts.t);
      return stream;
    },
    getImage(tag) {
      return {
        inspect: async () => {
          inspectCalls.push(tag);
          const seq = sequences.get(tag) ?? [false];
          const exists = seq.length > 1 ? seq.shift()! : (seq[0] ?? false);
          sequences.set(tag, seq);
          if (!exists) throw new Error(`missing image: ${tag}`);
          return { Id: tag };
        },
      };
    },
    modem: {
      followProgress(_stream, onFinished) {
        if (opts.buildResult === 'failure') {
          onFinished(new Error(opts.buildError ?? 'build failed'));
          return;
        }
        onFinished(null, []);
      },
    },
  };
}

function contextDir(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), 'FROM python:3.12-slim\n');
  writeFileSync(join(dir, 'main.py'), 'print("ok")\n');
  return dir;
}

async function run() {
  const { imageTagForDemo, resolveDemoImageTag } = await import(
    '../../apps/server/src/services/launch-demos.ts'
  );
  const demo = { slug: 'lead-scorer' };

  {
    const dir = contextDir('case-a');
    const imageTag = imageTagForDemo(demo, dir);
    const docker = createDockerMock({
      imageChecks: { [imageTag]: [false, true] },
      buildResult: 'success',
    });
    const { logger } = createLogger();
    const result = await resolveDemoImageTag({
      contextPath: dir,
      demo,
      docker,
      logger,
      persistedImageTag: null,
    });
    assert.deepEqual(result, { kind: 'ready', imageTag });
    assert.equal(docker.buildCalls.length, 1);
  }

  {
    const dir = contextDir('case-b');
    const imageTag = imageTagForDemo(demo, dir);
    const previousTag = 'floom-demo-lead-scorer:ctx-prev';
    const docker = createDockerMock({
      imageChecks: {
        [imageTag]: [false],
        [previousTag]: [true],
      },
      buildResult: 'failure',
      buildError: 'boom',
    });
    const { logger, logs } = createLogger();
    const result = await resolveDemoImageTag({
      contextPath: dir,
      demo,
      docker,
      logger,
      persistedImageTag: previousTag,
    });
    assert.deepEqual(result, { kind: 'keep_previous', imageTag: previousTag });
    assert.equal(docker.buildCalls.length, 1);
    assert.ok(
      logs.some(
        (entry) =>
          entry.level === 'error' &&
          entry.args.join(' ').includes(`${demo.slug}: build failed:`) &&
          entry.args.join(' ').includes('boom'),
      ),
    );
  }

  {
    const dir = contextDir('case-c');
    const imageTag = imageTagForDemo(demo, dir);
    const docker = createDockerMock({
      imageChecks: { [imageTag]: [false] },
      buildResult: 'failure',
      buildError: 'boom',
    });
    const { logger } = createLogger();
    const result = await resolveDemoImageTag({
      contextPath: dir,
      demo,
      docker,
      logger,
      persistedImageTag: null,
    });
    assert.deepEqual(result, { kind: 'missing', imageTag });
    assert.equal(docker.buildCalls.length, 1);
  }

  {
    const dir = contextDir('case-d');
    const imageTag = imageTagForDemo(demo, dir);
    const docker = createDockerMock({
      imageChecks: { [imageTag]: [false, false] },
      buildResult: 'success',
    });
    const { logger } = createLogger();
    const result = await resolveDemoImageTag({
      contextPath: dir,
      demo,
      docker,
      logger,
      persistedImageTag: null,
    });
    assert.deepEqual(result, { kind: 'missing', imageTag });
    assert.equal(docker.buildCalls.length, 1);
  }

  {
    const dir = contextDir('case-e');
    const imageTag = imageTagForDemo(demo, dir);
    const docker = createDockerMock({
      imageChecks: { [imageTag]: [true] },
      buildResult: 'success',
    });
    const { logger } = createLogger();
    const result = await resolveDemoImageTag({
      contextPath: dir,
      demo,
      docker,
      logger,
      persistedImageTag: null,
    });
    assert.deepEqual(result, { kind: 'ready', imageTag });
    assert.equal(docker.buildCalls.length, 0);
  }
}

async function main() {
  try {
    await run();
    console.log('launch-demos resolveDemoImageTag: ok');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
