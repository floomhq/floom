// Docker-per-app runner. Ported from the marketplace with the floom-SDK shim
// and workspace-scoped lookups removed. Signature-compatible with runner.ts.
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedManifest } from '../types.js';
import { db } from '../db.js';
import {
  CONTAINER_INPUTS_DIR,
  materializeFileInputs,
} from '../lib/file-inputs.js';
import { prepareDockerNetworkPolicy } from './network-policy.js';

const docker = new Docker();

export const BUILD_TIMEOUT = Number(process.env.BUILD_TIMEOUT || 600_000);
export const RUNNER_TIMEOUT = Number(process.env.RUNNER_TIMEOUT || 300_000);
export const RUNNER_MEMORY = process.env.RUNNER_MEMORY || '512m';
export const RUNNER_CPUS = Number(process.env.RUNNER_CPUS || 1);

function parseMemory(value: string): number {
  const match = value.trim().toLowerCase().match(/^(\d+)([kmg])?$/);
  if (!match) return 512 * 1024 * 1024;
  const num = Number(match[1]);
  const unit = match[2];
  if (unit === 'g') return num * 1024 * 1024 * 1024;
  if (unit === 'm') return num * 1024 * 1024;
  if (unit === 'k') return num * 1024;
  return num;
}

export const imageTag = (appId: string) => `floom-chat-app-${appId}:latest`;

function entrypointPath(runtime: 'python' | 'node' = 'python'): string {
  const filename = runtime === 'node' ? 'entrypoint.mjs' : 'entrypoint.py';
  const here = dirname(fileURLToPath(import.meta.url));
  // here is either .../server/src/services or .../server/dist/services
  const candidates = [
    join(here, '..', 'lib', filename),
    join(here, '..', '..', 'src', 'lib', filename),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`${filename} not found; checked: ${candidates.join(', ')}`);
}

function buildPythonDockerfile(manifest: NormalizedManifest): string {
  const deps = manifest.python_dependencies || [];
  const pipInstall =
    deps.length > 0
      ? `RUN pip install --no-cache-dir ${deps.map((d) => `'${d.replace(/'/g, "\\'")}'`).join(' ')}`
      : '# no python dependencies';
  const extraAptPkgs = (manifest.apt_packages || [])
    .map((p) => p.replace(/[^a-zA-Z0-9_.+-]/g, ''))
    .filter(Boolean);
  const aptInstall =
    extraAptPkgs.length > 0
      ? `RUN apt-get update && apt-get install -y --no-install-recommends git ${extraAptPkgs.join(' ')} && rm -rf /var/lib/apt/lists/*`
      : `RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*`;
  // Sandbox hardening: create a non-root `app` user (uid 1000) and drop to it
  // after COPY. HostConfig also enforces --user 1000:1000 as a defense in
  // depth, but baking USER into the image means the entrypoint starts
  // non-root even if HostConfig is misconfigured by a future change.
  return `FROM python:3.12-slim
${aptInstall}
RUN useradd -m -u 1000 -s /bin/sh app
WORKDIR /app
COPY . /app/
${pipInstall}
RUN chown -R app:app /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
USER 1000
ENTRYPOINT ["python", "/app/_entrypoint.py"]
`;
}

function buildNodeDockerfile(): string {
  // Sandbox hardening: node:22-slim already ships a `node` user (uid 1000).
  // Switch to it after install. HostConfig adds --user 1000:1000 defense-in-
  // depth regardless.
  return `FROM node:22-slim
WORKDIR /app
COPY . /app/
RUN if [ -f package.json ]; then npm install --omit=dev; fi
RUN chown -R node:node /app
ENV NODE_ENV=production
USER 1000
ENTRYPOINT ["node", "--experimental-strip-types", "/app/_entrypoint.mjs"]
`;
}

function ensurePackageJson(codeDir: string, nodeDeps: Record<string, string>): void {
  const pkgPath = join(codeDir, 'package.json');
  if (existsSync(pkgPath)) return;
  if (Object.keys(nodeDeps).length === 0) return;
  const pkg = {
    name: 'floom-app',
    private: true,
    type: 'module',
    dependencies: nodeDeps,
  };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

export async function buildAppImage(
  appId: string,
  codeDir: string,
  manifest: NormalizedManifest,
): Promise<{ tag: string; logs: string }> {
  const runtime = manifest.runtime || 'python';
  if (runtime === 'node') {
    copyFileSync(entrypointPath('node'), join(codeDir, '_entrypoint.mjs'));
    ensurePackageJson(codeDir, manifest.node_dependencies || {});
    writeFileSync(join(codeDir, 'Dockerfile'), buildNodeDockerfile());
  } else {
    copyFileSync(entrypointPath('python'), join(codeDir, '_entrypoint.py'));
    writeFileSync(join(codeDir, 'Dockerfile'), buildPythonDockerfile(manifest));
  }

  const tag = imageTag(appId);
  const stream = await docker.buildImage(
    { context: codeDir, src: ['.'] },
    { t: tag, rm: true, forcerm: true },
  );

  const logs: string[] = [];
  let buildError: Error | null = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      buildError = new Error(`Build timed out after ${BUILD_TIMEOUT}ms`);
      reject(buildError);
    }, BUILD_TIMEOUT);
    docker.modem.followProgress(
      stream,
      (err, output) => {
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        const errEvent = (output || []).find((e: { errorDetail?: unknown; error?: unknown }) => e.errorDetail || e.error);
        if (errEvent) {
          const msg =
            (typeof errEvent.error === 'string' ? errEvent.error : null) ||
            (errEvent.errorDetail && typeof (errEvent.errorDetail as { message?: string }).message === 'string'
              ? (errEvent.errorDetail as { message: string }).message
              : null) ||
            'Build failed';
          reject(new Error(msg));
          return;
        }
        resolve();
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) logs.push(String(event.stream));
        if (event.error) logs.push('ERROR: ' + String(event.error));
      },
    );
  });

  return { tag, logs: logs.join('') };
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
}

export async function runAppContainer(opts: {
  appId: string;
  runId: string;
  action: string;
  inputs: Record<string, unknown>;
  secrets: Record<string, string>;
  manifest: NormalizedManifest;
  image?: string;
  timeoutMs?: number;
  memory?: string;
  cpus?: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? RUNNER_TIMEOUT;
  const memoryBytes = parseMemory(opts.memory ?? RUNNER_MEMORY);
  const cpus = opts.cpus ?? RUNNER_CPUS;

  // Materialize any `{__file, content_b64}` envelopes in `inputs` to
  // a host temp dir, rewriting the input values to in-container paths
  // like "/floom/inputs/data.csv". When there are no file envelopes,
  // this is a zero-cost no-op: hostDir is '' and inputs is returned
  // unchanged. The mount is added only when files are present so
  // non-file apps keep their existing bind profile.
  const materialized = materializeFileInputs(opts.runId, opts.inputs);
  const binds: string[] = [];
  if (materialized.mountSource) {
    // Read-only bind: the app can read but never overwrite its inputs.
    // This also keeps the host-side envelope off the container FS so a
    // malicious app can't exfiltrate another run's files by reading /tmp.
    binds.push(`${materialized.mountSource}:${CONTAINER_INPUTS_DIR}:ro`);
  }
  const configArg = JSON.stringify({
    action: opts.action,
    inputs: materialized.inputs,
  });
  const env = [
    ...Object.entries(opts.secrets).map(([k, v]) => `${k}=${v}`),
  ];

  let imageName = opts.image;
  if (!imageName) {
    const appRow = db
      .prepare('SELECT docker_image FROM apps WHERE id = ?')
      .get(opts.appId) as { docker_image: string | null } | undefined;
    imageName = appRow?.docker_image || imageTag(opts.appId);
  }

  let networkPolicy;
  try {
    networkPolicy = await prepareDockerNetworkPolicy(docker, opts.runId, opts.manifest);
    env.push(...networkPolicy.env);
    let container;
    try {
      container = await docker.createContainer({
        Image: imageName,
        name: `floom-chat-run-${opts.runId}`,
        Cmd: [configArg],
        Env: env,
        // Force non-root inside the container even if the image's USER is
        // root (defense in depth — Dockerfiles above also set USER 1000).
        // Format is "uid:gid"; 1000:1000 is the conventional first unpriv
        // user on both debian-slim and node-slim bases we build from.
        User: '1000:1000',
        HostConfig: {
          AutoRemove: false,
          Memory: memoryBytes,
          MemorySwap: memoryBytes,
          NanoCpus: Math.floor(cpus * 1e9),
          NetworkMode: networkPolicy.networkMode,
          Binds: binds,
          // Sandbox hardening (2026-04-23, CSO P1-1):
          //   no-new-privileges — blocks setuid escalation inside container
          //     (e.g. a malicious binary calling setuid to regain root).
          //   CapDrop ALL            — user apps are HTTP handlers; they
          //     need zero Linux capabilities. Dropping all eliminates
          //     net_raw, sys_admin, etc. Outbound TCP via the userspace
          //     runtime still works because it doesn't require capabilities.
          //   ReadonlyRootfs         — root FS is read-only. Writable area
          //     is only the /tmp tmpfs below (64 MB, noexec). Prevents
          //     persistence attacks and most container-escape primers.
          //   Tmpfs /tmp             — writable scratch space that vanishes
          //     when the container exits. Sized at 64 MB; apps that need
          //     more should request an explicit volume via manifest.
          //   PidsLimit 256          — fork-bomb protection.
          SecurityOpt: ['no-new-privileges:true'],
          CapDrop: ['ALL'],
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
          PidsLimit: 256,
        },
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
    } catch (err) {
      // Launch blocker fix (2026-04-20): the marketplace-minted seed apps
      // carry docker_image tags that aren't built on this host (see
      // services/seed.ts). Dockerode throws `(HTTP code 404) no such
      // container - No such image: <tag>` which, before this guard, was
      // bubbling up as a generic Floom-side crash and the /p/:slug runner
      // surface rendered "Something broke inside Floom". Re-throw as a
      // tagged error so the upstream classifier can label the run
      // `app_unavailable` — the creator published a broken image, not us.
      const msg = (err as Error).message || '';
      if (/no such image|No such image|HTTP code 404/i.test(msg)) {
        const e = new Error(
          `This app's container image "${imageName}" isn't available on this Floom instance. The app creator needs to publish it.`,
        );
        (e as Error & { floom_error_class?: string }).floom_error_class =
          'app_unavailable';
        throw e;
      }
      throw err;
    }

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    stdoutStream.on('data', (c) => {
      const buf = Buffer.from(c);
      stdoutChunks.push(buf);
      if (opts.onOutput) opts.onOutput(buf.toString('utf8'), 'stdout');
    });
    stderrStream.on('data', (c) => {
      const buf = Buffer.from(c);
      stderrChunks.push(buf);
      if (opts.onOutput) opts.onOutput(buf.toString('utf8'), 'stderr');
    });

    const attachStream = await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
    });
    container.modem.demuxStream(attachStream, stdoutStream, stderrStream);

    const startedAt = Date.now();
    let timedOut = false;

    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs),
    );

    const result = await Promise.race([waitPromise, timeoutPromise]);

    if (result === 'timeout') {
      timedOut = true;
      try {
        await container.kill();
      } catch {
        // container may already be gone
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    let exitCode = -1;
    let oomKilled = false;
    try {
      const info = await container.inspect();
      exitCode = info.State.ExitCode ?? -1;
      oomKilled = Boolean(info.State.OOMKilled);
    } catch {
      // inspect can fail if the container vanished
    }

    try {
      await container.remove({ force: true });
    } catch {
      // best-effort
    }

    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      timedOut,
      oomKilled,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    // Always clean up the materialized-inputs temp dir, whether the
    // container ran to completion, timed out, or failed to even create.
    // The dir lives under /tmp so the OS would eventually scrub it, but
    // a long-lived dev server piling up per-run tmp dirs is a real foot-
    // gun — clean up proactively.
    materialized.cleanup();
    if (networkPolicy) await networkPolicy.cleanup();
  }
}

export async function removeAppImage(appId: string): Promise<void> {
  try {
    const image = docker.getImage(imageTag(appId));
    await image.remove({ force: true });
  } catch {
    // image may not exist
  }
}
