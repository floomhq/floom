/**
 * GitHub clone helpers for the deploy pipeline.
 *
 * Two modes:
 *   (a) fetchSnapshotFromApi — no sandbox needed. Uses the GitHub public API
 *       to grab the filetree + select file contents. Fast. Used for
 *       auto-detect before we spin up an e2b sandbox.
 *   (b) cloneInSandbox — runs `git clone --depth 1` inside an e2b sandbox.
 *       Slower (1-3s) but gets the full working tree for the build step.
 *
 * We use (a) for detection (no sandbox spin-up cost) and (b) for the
 * build/smoke phase (we need the actual files).
 */
import type { Sandbox } from '@e2b/code-interpreter';
import { runShell } from '../runtime/executor.ts';
import type { FileEntry } from '@floom/detect';
import type { RepoSnapshot } from '@floom/detect';
import { logger } from '../lib/logger.ts';

export interface FetchSnapshotOptions {
  /** GitHub token for private repos (optional). */
  githubToken?: string;
  /** Branch or commit SHA to fetch. Defaults to the repo's default branch. */
  ref?: string;
  /**
   * Paths to fetch file contents for. Keeping this small avoids chewing
   * through the GitHub API rate limit on large repos. Defaults to all
   * manifest files + README.
   */
  includeContents?: string[];
}

export interface GithubRepoRef {
  owner: string;
  name: string;
}

export function parseRepoUrl(repoUrl: string): GithubRepoRef {
  // Accept owner/name shorthand and full https://github.com URLs.
  const shortMatch = repoUrl.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shortMatch) return { owner: shortMatch[1]!, name: shortMatch[2]! };

  const urlMatch = repoUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/);
  if (urlMatch) return { owner: urlMatch[1]!, name: urlMatch[2]! };

  throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
}

/**
 * Fetch a repo snapshot via the GitHub API: filetree + README + manifests.
 * Runs outside any sandbox. Used by auto-detect before deciding whether to
 * spin up an e2b sandbox.
 */
export async function fetchSnapshotFromApi(
  repoUrl: string,
  opts: FetchSnapshotOptions = {},
): Promise<RepoSnapshot> {
  const { owner, name } = parseRepoUrl(repoUrl);
  const headers: Record<string, string> = {
    'User-Agent': 'floom-e2b-runtime',
    'Accept': 'application/vnd.github.v3+json',
  };
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // 1) Repo metadata (for default branch + description)
  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
  if (!metaRes.ok) {
    throw new Error(
      `GitHub API returned ${metaRes.status} for ${owner}/${name}: ${await metaRes.text()}`,
    );
  }
  const meta = await metaRes.json() as {
    default_branch: string;
    description?: string;
  };
  const ref = opts.ref ?? meta.default_branch;

  // 2) Full tree, recursive. This is one API call and gives us the whole
  // filetree in a single response.
  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${ref}?recursive=1`,
    { headers },
  );
  if (!treeRes.ok) {
    throw new Error(
      `GitHub tree fetch failed (${treeRes.status}): ${await treeRes.text()}`,
    );
  }
  const tree = await treeRes.json() as {
    tree: Array<{ path: string; type: 'blob' | 'tree' }>;
    truncated?: boolean;
  };

  const files: FileEntry[] = tree.tree.map((e) => ({
    path: e.path,
    type: e.type === 'blob' ? 'file' : 'dir',
  }));

  if (tree.truncated) {
    logger.warn('github tree truncated', { repo: `${owner}/${name}`, ref });
  }

  // 3) Fetch contents for manifest files + README. We fetch at most ~20
  // files to stay inside the API rate limit.
  const wantedBasenames = new Set([
    'package.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
    'pyproject.toml',
    'requirements.txt',
    'setup.py',
    'uv.lock',
    'composer.json',
    'go.mod',
    'Cargo.toml',
    'Gemfile',
    'Dockerfile',
    'README.md',
    'README.rst',
    'README',
  ]);

  const fileContents: Record<string, string> = {};
  const toFetch = files
    .filter((f) => {
      if (f.type !== 'file') return false;
      const basename = f.path.split('/').pop() ?? '';
      return wantedBasenames.has(basename);
    })
    .slice(0, 25);

  // Also fetch Python files at shallow depth so uv-detect can check PEP 723
  // headers. Limit to 5 to stay reasonable.
  const pyShallow = files
    .filter(
      (f) =>
        f.type === 'file'
        && f.path.endsWith('.py')
        && f.path.split('/').length <= 2,
    )
    .slice(0, 5);
  toFetch.push(...pyShallow);

  for (const f of toFetch) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${f.path}`;
    try {
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (res.ok) {
        fileContents[f.path] = await res.text();
      }
    } catch (err) {
      logger.debug('github raw fetch failed', { path: f.path, err: String(err) });
    }
  }

  const readmeKey = Object.keys(fileContents).find((k) => /^README/i.test(k));
  const readme = readmeKey ? fileContents[readmeKey] : '';

  return {
    fullName: `${owner}/${name}`,
    description: meta.description ?? '',
    files,
    fileContents,
    readme,
  };
}

/**
 * Clone a GitHub repo into the sandbox. Returns the absolute path where
 * the repo landed (used as the build cwd).
 *
 * We try `/home/user/workspace` first (the default user's home) and fall
 * back to `/tmp/workspace` if that fails. `/workspace` at the root is NOT
 * writable by the default user in e2b's base template.
 *
 * `git clone --depth 1` is used to minimise bandwidth; Suite H showed this
 * takes ~1-3s for typical small repos.
 */
export const WORKSPACE_PATH = '/home/user/workspace';

export async function cloneInSandbox(
  sandbox: Sandbox,
  repoUrl: string,
  opts: { branch?: string; githubToken?: string } = {},
): Promise<{ cloneMs: number; workspacePath: string }> {
  const { owner, name } = parseRepoUrl(repoUrl);
  const branch = opts.branch;
  const branchFlag = branch ? `--branch ${branch}` : '';
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  const url = token
    ? `https://${token}@github.com/${owner}/${name}.git`
    : `https://github.com/${owner}/${name}.git`;

  const t0 = Date.now();
  const result = await runShell(
    sandbox,
    `rm -rf ${WORKSPACE_PATH} && git clone --depth 1 ${branchFlag} ${url} ${WORKSPACE_PATH} 2>&1`,
    { timeoutMs: 120_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git clone failed (exit ${result.exitCode}): ${result.stdout}`);
  }
  return { cloneMs: Date.now() - t0, workspacePath: WORKSPACE_PATH };
}
