import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { db } from '../db.js';
import { newAppId, newBuildId } from '../lib/ids.js';
import { buildAppImage } from './docker.js';
import { ManifestError, normalizeManifest } from './manifest.js';
import type { NormalizedManifest } from '../types.js';

export type GithubBuildStatus =
  | 'detecting'
  | 'cloning'
  | 'building'
  | 'publishing'
  | 'published'
  | 'error';

export interface GithubBuildRecord {
  build_id: string;
  app_slug: string | null;
  github_url: string;
  repo_owner: string;
  repo_name: string;
  branch: string;
  manifest_path: string | null;
  manifest_options: string | null;
  requested_name: string | null;
  requested_slug: string | null;
  workspace_id: string;
  user_id: string;
  status: GithubBuildStatus;
  error: string | null;
  docker_image: string | null;
  commit_sha: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

export interface FormattedGithubBuild {
  build_id: string;
  status: GithubBuildStatus;
  error?: string;
  code?: string;
  slug?: string;
  manifest_paths?: string[];
}

interface ParsedGithubUrl {
  owner: string;
  repo: string;
  branch?: string;
  normalizedUrl: string;
}

interface GithubRepoMeta {
  default_branch: string;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class GithubDeployError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'GithubDeployError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const PRIVATE_REPO_MESSAGE =
  "repo private or doesn't exist; for private repos install Floom GitHub App (coming week 1)";

const terminalStatuses = new Set<GithubBuildStatus>(['published', 'error']);
const queue: string[] = [];
const queued = new Set<string>();
let draining = false;

export function parsePublicGithubUrl(input: string): ParsedGithubUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new GithubDeployError(400, 'invalid_github_url', 'github_url must be a valid URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new GithubDeployError(
      400,
      'invalid_github_url',
      'github_url must be https://github.com/<owner>/<repo>',
    );
  }
  if (url.search || url.hash) {
    throw new GithubDeployError(
      400,
      'invalid_github_url',
      'github_url must not include query parameters or fragments',
    );
  }

  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length !== 2 && !(parts.length >= 4 && parts[2] === 'tree')) {
    throw new GithubDeployError(
      400,
      'invalid_github_url',
      'github_url must be https://github.com/<owner>/<repo> or https://github.com/<owner>/<repo>/tree/<branch>',
    );
  }
  const [owner, repo] = parts;
  if (!owner || !repo || !isGithubName(owner) || !isGithubName(repo)) {
    throw new GithubDeployError(
      400,
      'invalid_github_url',
      'github_url owner and repo must use GitHub-safe characters',
    );
  }
  let branch: string | undefined;
  if (parts.length >= 4) {
    branch = parts.slice(3).join('/');
    validateBranch(branch);
  }
  if (parts.length > 2 && parts[2] !== 'tree') {
    throw new GithubDeployError(
      400,
      'invalid_github_url',
      'github_url only supports /tree/<branch> paths beyond owner/repo',
    );
  }
  return {
    owner,
    repo,
    branch,
    normalizedUrl: `https://github.com/${owner}/${repo}`,
  };
}

export async function createGithubBuild(args: {
  github_url: string;
  branch?: string;
  name?: string;
  slug?: string;
  manifest_path?: string;
  workspace_id: string;
  user_id: string;
}): Promise<GithubBuildRecord> {
  const parsed = parsePublicGithubUrl(args.github_url);
  const requestedBranch = args.branch || parsed.branch;
  if (requestedBranch) validateBranch(requestedBranch);
  if (args.manifest_path) validateManifestPath(args.manifest_path);

  const meta = await fetchPublicRepoMeta(parsed.owner, parsed.repo);
  const branch = requestedBranch || meta.default_branch;
  validateBranch(branch);

  const preflight = await preflightManifestSelection({
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    manifestPath: args.manifest_path || null,
  });
  const slug = uniqueSlug(args.slug || preflight.slug || preflight.manifest.name);

  const buildId = newBuildId();
  db.prepare(
    `INSERT INTO builds (
       build_id, app_slug, github_url, repo_owner, repo_name, branch,
       manifest_path, requested_name, requested_slug, workspace_id, user_id,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detecting')`,
  ).run(
    buildId,
    slug,
    parsed.normalizedUrl,
    parsed.owner,
    parsed.repo,
    branch,
    preflight.path,
    args.name || null,
    args.slug || null,
    args.workspace_id,
    args.user_id,
  );
  enqueueGithubBuild(buildId);
  return getGithubBuild(buildId)!;
}

async function preflightManifestSelection(args: {
  owner: string;
  repo: string;
  branch: string;
  manifestPath: string | null;
}): Promise<{ path: string | null; manifest: NormalizedManifest; slug?: string }> {
  if (process.env.FLOOM_GITHUB_DEPLOY_DISABLE_PREFLIGHT === 'true') {
    return {
      path: args.manifestPath,
      manifest: {
        name: 'GitHub App',
        description: '',
        actions: { run: { label: 'Run', inputs: [], outputs: [] } },
        runtime: 'python',
        python_dependencies: [],
        node_dependencies: {},
        secrets_needed: [],
        manifest_version: '2.0',
      },
    };
  }
  let cloneRoot: string | null = null;
  try {
    const clone = await cloneRepo(args);
    cloneRoot = clone.root;
    const selected = await selectManifest(clone.checkout, args.manifestPath);
    if (selected.kind === 'multiple') {
      throw new GithubDeployError(
        409,
        'manifest_picker',
        'multiple floom.yaml files found; choose manifest_path and retry',
        { manifest_paths: selected.paths },
      );
    }
    const loaded = await loadAndValidateManifest(path.join(clone.checkout, selected.path));
    return { path: selected.path, manifest: loaded.manifest, slug: loaded.slug };
  } finally {
    if (cloneRoot) {
      await rm(cloneRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export function getGithubBuild(buildId: string): GithubBuildRecord | undefined {
  return db.prepare('SELECT * FROM builds WHERE build_id = ?').get(buildId) as
    | GithubBuildRecord
    | undefined;
}

export function formatGithubBuild(row: GithubBuildRecord): FormattedGithubBuild {
  const out: FormattedGithubBuild = {
    build_id: row.build_id,
    status: row.status,
  };
  if (row.app_slug) out.slug = row.app_slug;
  if (row.error) {
    try {
      const parsed = JSON.parse(row.error) as { message?: string; code?: string };
      out.error = parsed.message || row.error;
      if (parsed.code) out.code = parsed.code;
    } catch {
      out.error = row.error;
    }
  }
  if (row.manifest_options) {
    try {
      const paths = JSON.parse(row.manifest_options);
      if (Array.isArray(paths) && paths.every((p) => typeof p === 'string')) {
        out.manifest_paths = paths;
      }
    } catch {
      // ignore malformed stored options
    }
  }
  return out;
}

export function enqueueGithubBuild(buildId: string): void {
  if (queued.has(buildId)) return;
  queued.add(buildId);
  queue.push(buildId);
  void drainQueue();
}

export function startGithubBuildWorker(): void {
  if (process.env.FLOOM_DISABLE_GITHUB_BUILD_WORKER === 'true') return;
  const rows = db
    .prepare(
      `SELECT build_id FROM builds
       WHERE status IN ('detecting', 'cloning', 'building', 'publishing')
       ORDER BY started_at ASC`,
    )
    .all() as { build_id: string }[];
  for (const row of rows) enqueueGithubBuild(row.build_id);
}

export async function runGithubBuildNow(buildId: string): Promise<GithubBuildRecord> {
  await processBuild(buildId);
  const row = getGithubBuild(buildId);
  if (!row) throw new Error(`build not found after processing: ${buildId}`);
  return row;
}

export function verifyGithubWebhookSignature(body: string, signature: string | null): boolean {
  const secret = process.env.FLOOM_GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected =
    'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
  const got = Buffer.from(signature);
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function createGithubRebuildFromWebhook(body: string): Promise<
  | { ignored: true; reason: string }
  | { ignored: false; build: GithubBuildRecord }
> {
  let event: {
    ref?: string;
    repository?: {
      html_url?: string;
      full_name?: string;
      name?: string;
      owner?: { name?: string; login?: string };
    };
  };
  try {
    event = JSON.parse(body);
  } catch {
    throw new GithubDeployError(400, 'invalid_payload', 'webhook body must be JSON');
  }

  const ref = event.ref || '';
  const prefix = 'refs/heads/';
  if (!ref.startsWith(prefix)) {
    return { ignored: true, reason: 'not_a_branch_push' };
  }
  const branch = ref.slice(prefix.length);
  validateBranch(branch);

  const repo = event.repository;
  const htmlUrl = repo?.html_url;
  let parsed: ParsedGithubUrl;
  if (htmlUrl) {
    parsed = parsePublicGithubUrl(htmlUrl);
  } else {
    const fullName = repo?.full_name;
    const owner = repo?.owner?.login || repo?.owner?.name;
    const name = repo?.name;
    const [fullOwner, fullRepo] = fullName ? fullName.split('/') : [];
    parsed = parsePublicGithubUrl(
      `https://github.com/${owner || fullOwner}/${name || fullRepo}`,
    );
  }

  const previous = db
    .prepare(
      `SELECT * FROM builds
       WHERE lower(repo_owner) = lower(?)
         AND lower(repo_name) = lower(?)
         AND branch = ?
         AND status = 'published'
         AND app_slug IS NOT NULL
       ORDER BY completed_at DESC, updated_at DESC
       LIMIT 1`,
    )
    .get(parsed.owner, parsed.repo, branch) as GithubBuildRecord | undefined;

  if (!previous) {
    return { ignored: true, reason: 'no_published_build_for_branch' };
  }

  const buildId = newBuildId();
  db.prepare(
    `INSERT INTO builds (
       build_id, app_slug, github_url, repo_owner, repo_name, branch,
       manifest_path, requested_name, requested_slug, workspace_id, user_id,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'detecting')`,
  ).run(
    buildId,
    previous.app_slug,
    previous.github_url,
    previous.repo_owner,
    previous.repo_name,
    branch,
    previous.manifest_path,
    previous.requested_name,
    previous.app_slug,
    previous.workspace_id,
    previous.user_id,
  );
  enqueueGithubBuild(buildId);
  return { ignored: false, build: getGithubBuild(buildId)! };
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const buildId = queue.shift()!;
      queued.delete(buildId);
      await processBuild(buildId).catch((err) => {
        console.error(`[github-deploy] build ${buildId} failed:`, err);
      });
    }
  } finally {
    draining = false;
  }
}

async function processBuild(buildId: string): Promise<void> {
  const row = getGithubBuild(buildId);
  if (!row || terminalStatuses.has(row.status)) return;

  let cloneRoot: string | null = null;
  try {
    setBuildStatus(buildId, 'cloning');
    const parsed = parsePublicGithubUrl(row.github_url);
    const clone = await cloneRepo({
      owner: parsed.owner,
      repo: parsed.repo,
      branch: row.branch,
    });
    cloneRoot = clone.root;

    const manifestChoice = await selectManifest(clone.checkout, row.manifest_path);
    if (manifestChoice.kind === 'multiple') {
      db.prepare(
        `UPDATE builds
            SET status='error',
                error=?,
                manifest_options=?,
                completed_at=datetime('now'),
                updated_at=datetime('now')
          WHERE build_id=?`,
      ).run(
        JSON.stringify({
          code: 'manifest_picker',
          message: 'multiple floom.yaml files found; choose manifest_path and retry',
        }),
        JSON.stringify(manifestChoice.paths),
        buildId,
      );
      return;
    }

    const parsedManifest = await loadAndValidateManifest(
      path.join(clone.checkout, manifestChoice.path),
    );
    const manifestDir = path.dirname(path.join(clone.checkout, manifestChoice.path));

    const slug = row.app_slug || uniqueSlug(row.requested_slug || parsedManifest.slug || parsedManifest.manifest.name);
    const existing = db
      .prepare('SELECT id FROM apps WHERE slug = ?')
      .get(slug) as { id: string } | undefined;
    const appId = existing?.id || newAppId();

    setBuildStatus(buildId, 'building', { app_slug: slug, manifest_path: manifestChoice.path });
    const image = await buildImageForManifest(appId, manifestDir, parsedManifest.manifest, buildId);

    setBuildStatus(buildId, 'publishing', {
      docker_image: image,
      commit_sha: clone.commitSha,
    });
    publishPrivateDockerApp({
      appId,
      slug,
      image,
      manifest: parsedManifest.manifest,
      category: parsedManifest.category,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      created: !existing,
    });
    db.prepare(
      `UPDATE builds
          SET status='published',
              app_slug=?,
              docker_image=?,
              commit_sha=?,
              error=NULL,
              completed_at=datetime('now'),
              updated_at=datetime('now')
        WHERE build_id=?`,
    ).run(slug, image, clone.commitSha, buildId);
  } catch (err) {
    const normalized = normalizeBuildError(err);
    db.prepare(
      `UPDATE builds
          SET status='error',
              error=?,
              completed_at=datetime('now'),
              updated_at=datetime('now')
        WHERE build_id=?`,
    ).run(JSON.stringify(normalized), buildId);
  } finally {
    if (cloneRoot) {
      await rm(cloneRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function fetchPublicRepoMeta(owner: string, repo: string): Promise<GithubRepoMeta> {
  const url = githubApiRepoUrl(owner, repo);
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'floom-github-deploy',
  };
  const head = await fetch(url, { method: 'HEAD', headers });
  if (head.status === 403 || head.status === 404) {
    throw new GithubDeployError(403, 'repo_private_or_missing', PRIVATE_REPO_MESSAGE);
  }
  if (!head.ok) {
    throw new GithubDeployError(
      502,
      'github_api_error',
      `GitHub repo check failed with HTTP ${head.status}`,
    );
  }

  const get = await fetch(url, { method: 'GET', headers });
  if (get.status === 403 || get.status === 404) {
    throw new GithubDeployError(403, 'repo_private_or_missing', PRIVATE_REPO_MESSAGE);
  }
  if (!get.ok) {
    throw new GithubDeployError(
      502,
      'github_api_error',
      `GitHub repo metadata failed with HTTP ${get.status}`,
    );
  }
  const json = (await get.json()) as { default_branch?: unknown };
  if (typeof json.default_branch !== 'string' || json.default_branch.length === 0) {
    throw new GithubDeployError(
      502,
      'github_api_error',
      'GitHub repo metadata did not include default_branch',
    );
  }
  return { default_branch: json.default_branch };
}

function githubApiRepoUrl(owner: string, repo: string): string {
  const base = (process.env.FLOOM_GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/$/, '');
  return `${base}/repos/${owner}/${repo}`;
}

async function cloneRepo(args: {
  owner: string;
  repo: string;
  branch: string;
}): Promise<{ root: string; checkout: string; commitSha: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'floom-github-build-'));
  const checkout = path.join(root, args.repo);
  const cloneUrl = githubCloneUrl(args.owner, args.repo);
  const result = await runCmd(
    'git',
    ['clone', '--depth', '1', '-b', args.branch, cloneUrl, checkout],
    {
      timeoutMs: Number(process.env.FLOOM_GITHUB_CLONE_TIMEOUT_MS || 120_000),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    },
  );
  if (result.exitCode !== 0 || result.timedOut) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    const detail = result.timedOut ? 'timed out' : `exit ${result.exitCode}`;
    throw new GithubDeployError(
      422,
      'clone_failed',
      `git clone failed (${detail}): ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }

  const sha = await runCmd('git', ['rev-parse', 'HEAD'], { cwd: checkout, timeoutMs: 5000 });
  return {
    root,
    checkout,
    commitSha: sha.exitCode === 0 ? sha.stdout.trim() : '',
  };
}

function githubCloneUrl(owner: string, repo: string): string {
  const template = process.env.FLOOM_GITHUB_CLONE_URL_TEMPLATE;
  if (template) {
    return template.replaceAll('{owner}', owner).replaceAll('{repo}', repo);
  }
  return `https://github.com/${owner}/${repo}.git`;
}

async function selectManifest(
  checkout: string,
  requestedPath: string | null,
): Promise<{ kind: 'single'; path: string } | { kind: 'multiple'; paths: string[] }> {
  if (requestedPath) {
    const safe = validateManifestPath(requestedPath);
    if (!existsSync(path.join(checkout, safe))) {
      throw new GithubDeployError(
        422,
        'manifest_not_found',
        `manifest_path not found: ${safe}`,
      );
    }
    return { kind: 'single', path: safe };
  }

  const candidates: string[] = [];
  if (existsSync(path.join(checkout, 'floom.yaml'))) candidates.push('floom.yaml');
  const examples = path.join(checkout, 'examples');
  if (existsSync(examples)) {
    const entries = await readdir(examples, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = `examples/${entry.name}/floom.yaml`;
      if (existsSync(path.join(checkout, rel))) candidates.push(rel);
    }
  }

  if (candidates.length === 0) {
    throw new GithubDeployError(
      422,
      'manifest_not_found',
      'No floom.yaml found at repo root or examples/<name>/floom.yaml',
    );
  }
  if (candidates.length > 1) {
    return { kind: 'multiple', paths: candidates.sort() };
  }
  return { kind: 'single', path: candidates[0]! };
}

async function loadAndValidateManifest(file: string): Promise<{
  manifest: NormalizedManifest;
  slug?: string;
  category?: string;
}> {
  let raw: unknown;
  try {
    raw = parseYaml(await readFile(file, 'utf8'));
  } catch (err) {
    throw new GithubDeployError(
      422,
      'manifest_invalid',
      `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const manifest = normalizeManifest(raw);
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return {
      manifest,
      slug: typeof obj.slug === 'string' ? obj.slug : undefined,
      category: typeof obj.category === 'string' ? obj.category : undefined,
    };
  } catch (err) {
    if (err instanceof ManifestError) {
      throw new GithubDeployError(
        422,
        'manifest_invalid',
        `manifest validation failed: ${err.message}`,
        { field: err.field },
      );
    }
    throw err;
  }
}

async function buildImageForManifest(
  appId: string,
  manifestDir: string,
  manifest: NormalizedManifest,
  buildId: string,
): Promise<string> {
  if (process.env.FLOOM_GITHUB_DEPLOY_SKIP_DOCKER === 'true') {
    return `floom-github-build-${buildId}:test`;
  }
  const result = await buildAppImage(appId, manifestDir, manifest);
  return result.tag;
}

function publishPrivateDockerApp(args: {
  appId: string;
  slug: string;
  image: string;
  manifest: NormalizedManifest;
  category?: string;
  workspaceId: string;
  userId: string;
  created: boolean;
}): void {
  if (args.created) {
    db.prepare(
      `INSERT INTO apps (
         id, slug, name, description, manifest, status, docker_image, code_path,
         category, author, icon, app_type, base_url, auth_type, auth_config,
         openapi_spec_url, openapi_spec_cached, visibility, is_async,
         webhook_url, timeout_ms, retries, async_mode, workspace_id, publish_status
       ) VALUES (
         ?, ?, ?, ?, ?, 'active', ?, ?,
         ?, ?, NULL, 'docker', NULL, NULL, NULL,
         NULL, NULL, 'private', 0,
         NULL, NULL, 0, NULL, ?, 'published'
       )`,
    ).run(
      args.appId,
      args.slug,
      args.manifest.name,
      args.manifest.description,
      JSON.stringify(args.manifest),
      args.image,
      `github:${args.slug}`,
      args.category || null,
      args.userId,
      args.workspaceId,
    );
    return;
  }

  db.prepare(
    `UPDATE apps SET
       name=?,
       description=?,
       manifest=?,
       status='active',
       docker_image=?,
       code_path=?,
       category=?,
       app_type='docker',
       base_url=NULL,
       auth_type=NULL,
       auth_config=NULL,
       openapi_spec_url=NULL,
       openapi_spec_cached=NULL,
       visibility='private',
       is_async=0,
       webhook_url=NULL,
       timeout_ms=NULL,
       retries=0,
       async_mode=NULL,
       workspace_id=?,
       author=?,
       publish_status='published',
       updated_at=datetime('now')
     WHERE id=?`,
  ).run(
    args.manifest.name,
    args.manifest.description,
    JSON.stringify(args.manifest),
    args.image,
    `github:${args.slug}`,
    args.category || null,
    args.workspaceId,
    args.userId,
    args.appId,
  );
}

function setBuildStatus(
  buildId: string,
  status: GithubBuildStatus,
  fields: Partial<Pick<GithubBuildRecord, 'app_slug' | 'manifest_path' | 'docker_image' | 'commit_sha'>> = {},
): void {
  const updates = ['status = ?', 'updated_at = datetime(\'now\')'];
  const values: unknown[] = [status];
  for (const key of ['app_slug', 'manifest_path', 'docker_image', 'commit_sha'] as const) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  values.push(buildId);
  db.prepare(`UPDATE builds SET ${updates.join(', ')} WHERE build_id = ?`).run(...values);
}

function uniqueSlug(input: string): string {
  const base = slugify(input) || `app-${randomUUID().slice(0, 8)}`;
  let candidate = base;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM apps WHERE slug = ?').get(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/g, '');
}

function validateManifestPath(input: string): string {
  const normalized = input.replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    normalized !== 'floom.yaml' &&
    !/^examples\/[^/]+\/floom\.yaml$/.test(normalized)
  ) {
    throw new GithubDeployError(
      400,
      'invalid_manifest_path',
      'manifest_path must be floom.yaml or examples/<dirname>/floom.yaml',
    );
  }
  if (normalized.includes('..')) {
    throw new GithubDeployError(400, 'invalid_manifest_path', 'manifest_path cannot contain ..');
  }
  return normalized;
}

function validateBranch(branch: string): void {
  if (
    typeof branch !== 'string' ||
    branch.trim() !== branch ||
    branch.length === 0 ||
    branch.length > 200 ||
    branch.startsWith('-') ||
    /[\0-\x1f\x7f\\]/.test(branch)
  ) {
    throw new GithubDeployError(400, 'invalid_branch', 'branch is not a valid git ref name');
  }
}

function isGithubName(input: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(input) && input !== '.' && input !== '..';
}

function normalizeBuildError(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof GithubDeployError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return {
    code: 'build_failed',
    message: err instanceof Error ? err.message : String(err),
  };
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
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
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + err.message, timedOut });
    });
  });
}
