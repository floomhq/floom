/**
 * GitHub metadata fetch — used by the pipeline's auto-detect phase before
 * a full clone. Calls the public GitHub API to grab the filetree + a few
 * manifest files. No provider / sandbox / docker required: runs in the
 * Floom server process.
 *
 * The full clone (`git clone`) lives in each RuntimeProvider's
 * `clone()` implementation; metadata fetch is provider-agnostic because
 * every provider needs the same detect input.
 */
import type { FileEntry, RepoSnapshot as DetectRepoSnapshot } from '@floom/detect';

import { logger } from '../lib/logger.ts';

export interface FetchSnapshotOptions {
  /** GitHub token for private repos (optional). */
  githubToken?: string;
  /** Branch or commit SHA to fetch. Defaults to the repo's default branch. */
  ref?: string;
}

export interface GithubRepoRef {
  owner: string;
  name: string;
}

export function parseRepoUrl(repoUrl: string): GithubRepoRef {
  const shortMatch = repoUrl.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shortMatch) return { owner: shortMatch[1]!, name: shortMatch[2]! };

  const urlMatch = repoUrl.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/);
  if (urlMatch) return { owner: urlMatch[1]!, name: urlMatch[2]! };

  throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
}

/**
 * Fetch a repo snapshot via the GitHub API: filetree + README + manifests.
 * Used by auto-detect to decide runtime/build/run before the provider has
 * to do a full clone.
 */
export async function fetchSnapshotFromApi(
  repoUrl: string,
  opts: FetchSnapshotOptions = {},
): Promise<DetectRepoSnapshot> {
  const { owner, name } = parseRepoUrl(repoUrl);
  const headers: Record<string, string> = {
    'User-Agent': 'floom-runtime',
    Accept: 'application/vnd.github.v3+json',
  };
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const metaRes = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
  if (!metaRes.ok) {
    throw new Error(
      `GitHub API returned ${metaRes.status} for ${owner}/${name}: ${await metaRes.text()}`,
    );
  }
  const meta = (await metaRes.json()) as {
    default_branch: string;
    description?: string;
  };
  const ref = opts.ref ?? meta.default_branch;

  const treeRes = await fetch(
    `https://api.github.com/repos/${owner}/${name}/git/trees/${ref}?recursive=1`,
    { headers },
  );
  if (!treeRes.ok) {
    throw new Error(
      `GitHub tree fetch failed (${treeRes.status}): ${await treeRes.text()}`,
    );
  }
  const tree = (await treeRes.json()) as {
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
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
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
