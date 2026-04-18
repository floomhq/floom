/**
 * Ax41DockerProvider — runs user-submitted repos on the same Docker daemon
 * that hosts Floom itself (AX41 in production, the operator's host in
 * self-host).
 *
 * Flow: `clone` → `build` (`docker build`, or generated Dockerfile +
 * `floom-entry.sh` when the repo has no Dockerfile) → `run` (`docker run`
 * with `-p 127.0.0.1::<port>`, memory + CPU limits) → `smokeTest` (HTTP
 * probe on loopback).
 *
 * Isolation model: container-level, loopback-only published ports. See
 * docs/PRODUCT.md.
 *
 * Requires `docker` on PATH and permission to talk to the daemon (same as
 * apps/server hosted-mode).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Manifest } from '../runtime/types.ts';
import { logger } from '../lib/logger.ts';
import type {
  BuildOptions,
  BuiltArtifact,
  HealthProbe,
  RepoSnapshot,
  RepoSource,
  RunOptions,
  RunningInstance,
  RuntimeProvider,
  SmokeResult,
} from './types.ts';

const CLONE_ROOT_ENV = 'FLOOM_DEPLOY_CLONE_ROOT';
const CLONE_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_TIMEOUT_MS = 600_000;
const DEFAULT_CONTAINER_PORT = 8080;
const DEFAULT_MEMORY_MB = 512;
const DEFAULT_CPUS = 1;

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCmd(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    onData?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : null;

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      opts.onData?.(text, 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      opts.onData?.(text, 'stderr');
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
      });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + err.message,
        timedOut,
      });
    });
  });
}

export interface Ax41DockerProviderOptions {
  cloneRoot?: string;
}

interface ParsedRepo {
  owner: string;
  name: string;
  fullName: string;
}

function parseRepoUrl(repoUrl: string): ParsedRepo {
  const short = repoUrl.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) {
    const owner = short[1]!;
    const name = short[2]!;
    return { owner, name, fullName: `${owner}/${name}` };
  }

  const url = repoUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/);
  if (url) {
    const owner = url[1]!;
    const name = url[2]!;
    return { owner, name, fullName: `${owner}/${name}` };
  }

  throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
}

async function scrubTokenFromGitConfig(repoPath: string): Promise<void> {
  const cfgPath = path.join(repoPath, '.git', 'config');
  try {
    const body = await readFile(cfgPath, 'utf8');
    const scrubbed = body.replace(
      /(url\s*=\s*https:\/\/)([^@\n/]+)@(github\.com[^\n]*)/g,
      '$1$3',
    );
    if (scrubbed !== body) {
      await writeFile(cfgPath, scrubbed, 'utf8');
      logger.info('ax41-docker.scrub-token', { repoPath });
    }
  } catch (err) {
    logger.warn('ax41-docker.scrub-token-failed', {
      repoPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function sanitizeImageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 120);
}

function baseImageForRuntime(runtime: Manifest['runtime']): string {
  switch (runtime) {
    case 'python3.12':
      return 'python:3.12-slim';
    case 'python3.11':
      return 'python:3.11-slim';
    case 'node20':
      return 'node:20-slim';
    case 'node22':
      return 'node:22-slim';
    case 'go1.22':
      return 'golang:1.22-alpine';
    case 'rust':
      return 'rust:1-slim';
    case 'docker':
    case 'auto':
    default:
      return 'python:3.12-slim';
  }
}

/**
 * First EXPOSE <port> in a Dockerfile, or null.
 */
function parseExposedPort(dockerfile: string): number | null {
  const m = dockerfile.match(/^\s*EXPOSE\s+(\d+)/im);
  return m ? Number(m[1]) : null;
}

function installDepsLine(runtime: Manifest['runtime']): string {
  if (runtime === 'go1.22') {
    return `RUN apk add --no-cache curl ca-certificates\n`;
  }
  if (runtime === 'rust') {
    return `RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*\n`;
  }
  return `RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*\n`;
}

function generatedDockerfile(manifest: Manifest, containerPort: number): string {
  const base = baseImageForRuntime(manifest.runtime);
  const buildBlock = manifest.build
    ? `RUN sh -c ${JSON.stringify(manifest.build)}\n`
    : '';
  return `FROM ${base}
WORKDIR /app
COPY . .
${installDepsLine(manifest.runtime)}${buildBlock}EXPOSE ${containerPort}
RUN chmod +x /app/floom-entry.sh
CMD ["/app/floom-entry.sh"]
`;
}

async function writeFloomEntryScript(ctx: string, manifest: Manifest, containerPort: number): Promise<void> {
  const script = `#!/bin/sh
set -e
cd /app
export PORT=${containerPort}
export HOST=0.0.0.0
exec sh -c ${JSON.stringify(manifest.run)}
`;
  await writeFile(path.join(ctx, 'floom-entry.sh'), script, { mode: 0o755 });
}

export class Ax41DockerProvider implements RuntimeProvider {
  readonly name = 'ax41-docker' as const;
  private readonly cloneRoot: string;

  constructor(opts: Ax41DockerProviderOptions = {}) {
    this.cloneRoot = opts.cloneRoot ?? process.env[CLONE_ROOT_ENV] ?? tmpdir();
  }

  async clone(source: RepoSource): Promise<RepoSnapshot> {
    const repo = parseRepoUrl(source.url);
    const ref = source.ref;
    const token = source.githubToken ?? process.env.GITHUB_TOKEN;

    const workDir = await mkdtemp(path.join(this.cloneRoot, 'floom-clone-'));
    const repoDir = path.join(workDir, repo.name);

    const cloneUrl = token
      ? `https://${token}@github.com/${repo.owner}/${repo.name}.git`
      : `https://github.com/${repo.owner}/${repo.name}.git`;

    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push(cloneUrl, repoDir);

    const started = Date.now();
    const result = await runCmd('git', args, {
      env: {
        ...process.env,
        GITHUB_TOKEN: '',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeoutMs: CLONE_TIMEOUT_MS,
    });

    if (result.exitCode !== 0 || result.timedOut) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      const detail = result.timedOut
        ? `timed out after ${CLONE_TIMEOUT_MS}ms`
        : `exit ${result.exitCode}`;
      const stderr = token
        ? result.stderr.replaceAll(token, '***')
        : result.stderr;
      throw new Error(
        `git clone ${repo.fullName} failed (${detail}): ${stderr.trim() || 'no output'}`,
      );
    }

    if (token) {
      await scrubTokenFromGitConfig(repoDir);
    }

    const shaResult = await runCmd('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir,
      timeoutMs: 5000,
    });
    const commitSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : '';

    logger.info('ax41-docker.clone-ok', {
      repo: repo.fullName,
      commitSha,
      cloneMs: Date.now() - started,
      repoDir,
    });

    return {
      localPath: repoDir,
      commitSha,
      fullName: repo.fullName,
      snapshotId: workDir,
    };
  }

  async destroySnapshot(snapshot: RepoSnapshot): Promise<void> {
    await rm(snapshot.snapshotId, { recursive: true, force: true });
    logger.info('ax41-docker.snapshot-destroyed', { snapshotId: snapshot.snapshotId });
  }

  async build(snapshot: RepoSnapshot, opts: BuildOptions): Promise<BuiltArtifact> {
    const { manifest, onLog } = opts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    const ctx = manifest.workdir
      ? path.join(snapshot.localPath, manifest.workdir)
      : snapshot.localPath;

    if (!existsSync(ctx)) {
      throw new Error(`Build context does not exist: ${ctx}`);
    }

    const tag = `floom-deploy-${sanitizeImageName(manifest.name)}:${snapshot.commitSha.slice(0, 12) || randomUUID().slice(0, 12)}`;
    const userDockerfile = path.join(ctx, 'Dockerfile');
    let dockerfilePath: string;
    let containerPort = DEFAULT_CONTAINER_PORT;

    if (existsSync(userDockerfile)) {
      dockerfilePath = 'Dockerfile';
      try {
        const df = await readFile(userDockerfile, 'utf8');
        const exposed = parseExposedPort(df);
        if (exposed) containerPort = exposed;
      } catch {
        // keep default
      }
    } else {
      await writeFloomEntryScript(ctx, manifest, containerPort);
      const genPath = path.join(ctx, 'Dockerfile.floom');
      const body = generatedDockerfile(manifest, containerPort);
      await writeFile(genPath, body, 'utf8');
      dockerfilePath = 'Dockerfile.floom';
      onLog?.(`[floom] wrote floom-entry.sh + ${dockerfilePath} (no Dockerfile in repo)\n`);
    }

    const t0 = Date.now();
    const logAll = (chunk: string, _s: 'stdout' | 'stderr') => {
      onLog?.(chunk);
    };

    const buildArgs = ['build', '-f', dockerfilePath, '-t', tag, '.'];
    const br = await runCmd('docker', buildArgs, {
      cwd: ctx,
      timeoutMs,
      onData: logAll,
    });

    if (br.exitCode !== 0 || br.timedOut) {
      const detail = br.timedOut ? `timed out after ${timeoutMs}ms` : `exit ${br.exitCode}`;
      throw new Error(`docker build failed (${detail}): ${(br.stderr || br.stdout).slice(-4000)}`);
    }

    const buildMs = Date.now() - t0;
    logger.info('ax41-docker.build-ok', { tag, buildMs, context: ctx });

    return {
      id: tag,
      provider: this.name,
      manifest,
      containerPort,
      metrics: { buildMs },
    };
  }

  async run(opts: RunOptions): Promise<RunningInstance> {
    const { artifact } = opts;
    const memMb = opts.limits?.memoryMb ?? artifact.manifest.memoryMb ?? DEFAULT_MEMORY_MB;
    const cpus = opts.limits?.cpus ?? DEFAULT_CPUS;
    const containerPort =
      opts.port ?? artifact.containerPort ?? DEFAULT_CONTAINER_PORT;

    const name = `floom-${sanitizeImageName(artifact.manifest.name)}-${randomUUID().slice(0, 8)}`;
    const publish = `127.0.0.1::${containerPort}`;

    const runArgs = [
      'run',
      '-d',
      '--name',
      name,
      '--rm',
      '-p',
      publish,
      '-m',
      `${memMb}m`,
      '--cpus',
      String(cpus),
      ...envToDockerArgs(opts.env ?? {}),
      artifact.id,
    ];

    const rr = await runCmd('docker', runArgs, { timeoutMs: 120_000 });
    if (rr.exitCode !== 0 || rr.timedOut) {
      throw new Error(
        `docker run failed: ${(rr.stderr || rr.stdout).slice(-2000)}`,
      );
    }

    const containerId = rr.stdout.trim();
    const portOut = await runCmd('docker', ['port', name, `${containerPort}/tcp`], {
      timeoutMs: 10_000,
    });
    const hostPort = parseDockerPortOutput(portOut.stdout);
    if (!hostPort) {
      await runCmd('docker', ['rm', '-f', name], {}).catch(() => {});
      throw new Error(`could not resolve host port for container ${name}: ${portOut.stdout}${portOut.stderr}`);
    }

    const url = `http://127.0.0.1:${hostPort}`;
    logger.info('ax41-docker.run-ok', { name, containerId, url });

    return {
      id: containerId,
      url,
      provider: this.name,
      async stop() {
        await runCmd('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
        logger.info('ax41-docker.stopped', { name });
      },
    };
  }

  async smokeTest(instance: RunningInstance, probe?: HealthProbe): Promise<SmokeResult> {
    const pathSuffix = probe?.path ?? '/';
    const maxAttempts = probe?.maxAttempts ?? 30;
    const delayMs = 1000;
    const okMin = probe?.okStatusRange?.[0] ?? 200;
    const okMax = probe?.okStatusRange?.[1] ?? 499;
    const reqTimeout = probe?.timeoutMs ?? 5000;

    let lastStatus: number | undefined;
    let lastError: string | undefined;
    let attempts = 0;

    for (let i = 0; i < maxAttempts; i++) {
      attempts = i + 1;
      const t0 = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), reqTimeout);
        const res = await fetch(new URL(pathSuffix, instance.url), {
          signal: controller.signal,
        });
        clearTimeout(timer);
        lastStatus = res.status;
        if (res.status >= okMin && res.status <= okMax) {
          return {
            passed: true,
            lastStatus: res.status,
            latencyMs: Date.now() - t0,
            attempts,
          };
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (i < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    return {
      passed: false,
      lastStatus,
      lastError,
      attempts,
    };
  }
}

function envToDockerArgs(env: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!k) continue;
    out.push('-e', `${k}=${v}`);
  }
  return out;
}

/** `docker port` prints `127.0.0.1:32768` per line */
function parseDockerPortOutput(s: string): number | null {
  const line = s.trim().split('\n')[0]?.trim();
  if (!line) return null;
  const m = line.match(/:(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export { parseRepoUrl };
