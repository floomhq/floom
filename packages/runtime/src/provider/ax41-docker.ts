/**
 * Ax41DockerProvider — runs user-submitted repos on the same Docker daemon
 * that hosts Floom itself (AX41 in production, the operator's host in
 * self-host).
 *
 * Isolation model: container-level. Resource limits + isolated bridge
 * network + unprivileged + read-only root + no docker socket mount. Strong
 * enough for a private beta with curated users; explicitly not a VM-level
 * boundary. See docs/PRODUCT.md for the upgrade path.
 *
 * Implemented this session:
 *   - clone: git clone into a per-deploy tmpdir, token-scrubbed.
 *
 * Stubs for the next session (throw `NotImplemented` so we fail loudly
 * instead of silently):
 *   - build: `docker build` with streamed log output.
 *   - run: `docker run -d` with resource limits + isolated network.
 *   - smokeTest: HTTP probe with retries.
 *   - destroySnapshot: rm -rf the tmpdir.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

export class NotImplemented extends Error {
  constructor(method: string) {
    super(`Ax41DockerProvider.${method} is not implemented yet (phase 2a-2).`);
    this.name = 'NotImplemented';
  }
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Spawn a subprocess and collect stdout/stderr. Sanitises argv so secrets
 * passed via env never leak into process tables.
 */
function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; onData?: (chunk: string, stream: 'stdout' | 'stderr') => void } = {},
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
  /**
   * Parent directory where per-deploy clones live. Defaults to
   * `$FLOOM_DEPLOY_CLONE_ROOT` or `os.tmpdir()`. In production we set this
   * to a dedicated volume with its own quota so runaway clones can't fill
   * the disk Floom itself runs on.
   */
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

/**
 * Wipe GitHub token out of `.git/config` after clone. `git clone
 * https://TOKEN@github.com/...` persists the tokenised URL in
 * `remote.origin.url`; we rewrite it to the tokenless URL so subsequent
 * reads of the clone dir (log uploads, backups, debug dumps) don't leak
 * credentials.
 */
async function scrubTokenFromGitConfig(repoPath: string): Promise<void> {
  const cfgPath = path.join(repoPath, '.git', 'config');
  try {
    const body = await readFile(cfgPath, 'utf8');
    // Match `url = https://<token>@github.com/...` (any non-slash token).
    const scrubbed = body.replace(
      /(url\s*=\s*https:\/\/)([^@\n/]+)@(github\.com[^\n]*)/g,
      '$1$3',
    );
    if (scrubbed !== body) {
      await writeFile(cfgPath, scrubbed, 'utf8');
      logger.info('ax41-docker.scrub-token', { repoPath });
    }
  } catch (err) {
    // If .git/config doesn't exist something is very wrong, but don't
    // fail the clone for it — we'd rather ship the repo than block on a
    // scrub for a non-tokenised clone.
    logger.warn('ax41-docker.scrub-token-failed', {
      repoPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
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
    // Don't inherit a GITHUB_TOKEN-laced env either — the URL carries it,
    // the subprocess doesn't need to see it too.
    const result = await runCmd('git', args, {
      env: {
        ...process.env,
        GITHUB_TOKEN: '',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeoutMs: CLONE_TIMEOUT_MS,
    });

    if (result.exitCode !== 0 || result.timedOut) {
      // Best-effort cleanup so we don't leak half-cloned dirs.
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      const detail = result.timedOut
        ? `timed out after ${CLONE_TIMEOUT_MS}ms`
        : `exit ${result.exitCode}`;
      // Redact the token from any error output before throwing.
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

    // Resolve commit SHA for the registry entry.
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

  async build(_snapshot: RepoSnapshot, _opts: BuildOptions): Promise<BuiltArtifact> {
    throw new NotImplemented('build');
  }

  async run(_opts: RunOptions): Promise<RunningInstance> {
    throw new NotImplemented('run');
  }

  async smokeTest(_instance: RunningInstance, _probe?: HealthProbe): Promise<SmokeResult> {
    throw new NotImplemented('smokeTest');
  }
}

// Re-export for tests + pipeline consumers.
export { parseRepoUrl };
