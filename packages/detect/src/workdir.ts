/**
 * Suite H fix #4: `workdir` detection for monorepos.
 *
 * The old analyzer always assumed the buildable unit lives at the repo root
 * and recorded `workdir: ""`. Suite H's airflow-client-go failure
 * (`no non-test Go files`) was caused by the Go module living in a
 * subdirectory. We fix it by walking the filetree and picking the deepest
 * directory that contains a known manifest file (go.mod, package.json,
 * pyproject.toml, Cargo.toml).
 *
 * The rule: if there is a manifest at the root, prefer the root (most
 * common case, zero behavioural change). Otherwise pick the shallowest
 * subdirectory that has one. Ties are broken alphabetically so the result
 * is deterministic across runs.
 */

export const MANIFEST_FILENAMES = [
  'go.mod',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'requirements.txt',
  'setup.py',
  'composer.json',
  'Gemfile',
  'Dockerfile',
];

export interface FileEntry {
  /** Path relative to the repo root, POSIX separators. */
  path: string;
  type: 'file' | 'dir';
}

export interface WorkdirResult {
  /** Path relative to repo root (empty string = repo root). */
  workdir: string;
  /** Which manifest file was found there. */
  manifest: string;
}

/**
 * Find the best workdir for a repo given its file listing.
 *
 * @param files   All files+dirs the repo provides (nested OK)
 * @returns       { workdir, manifest } — workdir is empty string for repo root
 *                or throws if no recognisable manifest is found anywhere.
 */
export function detectWorkdir(files: FileEntry[]): WorkdirResult | null {
  // Rule 1: prefer root. If any manifest is at the top level, done.
  for (const mf of MANIFEST_FILENAMES) {
    if (files.some((f) => f.path === mf && f.type === 'file')) {
      return { workdir: '', manifest: mf };
    }
  }

  // Rule 2: collect all subdirectories containing manifests, then pick the
  // shallowest (tie-broken alphabetically). This means if a repo has
  // `go/go.mod` AND `python/pyproject.toml`, we pick go/ (alphabetically
  // first, both at depth 1). The auto-detect's runtime pass will then pick
  // its own runtime rules for that workdir.
  const candidates: { workdir: string; depth: number; manifest: string }[] = [];
  for (const f of files) {
    if (f.type !== 'file') continue;
    const segments = f.path.split('/');
    const basename = segments[segments.length - 1]!;
    if (!MANIFEST_FILENAMES.includes(basename)) continue;
    if (segments.length === 1) continue; // root already handled above
    const workdir = segments.slice(0, -1).join('/');
    candidates.push({ workdir, depth: segments.length - 1, manifest: basename });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.workdir.localeCompare(b.workdir);
  });

  const best = candidates[0]!;
  return { workdir: best.workdir, manifest: best.manifest };
}
