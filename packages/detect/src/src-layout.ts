/**
 * Suite H fix #2: Python `src/` layout detection.
 *
 * crewAI failed because its source lives in `src/crewai/` and pyproject.toml
 * uses setuptools with `[tool.setuptools.packages.find]` pointing at `src/`.
 * `pip install -e .` from the repo root "succeeds" but installs a 4KB
 * `UNKNOWN` package (setuptools's empty fallback) instead of the real
 * library.
 *
 * Rules:
 *   - If pyproject.toml contains `[tool.setuptools.packages.find]` AND there
 *     is a `src/` directory in the workdir, the package uses src layout.
 *   - If pyproject.toml has `packages = ["src.*"]` or similar, same thing.
 *   - If the repo has only `src/<pkg>/__init__.py` and no package file at
 *     the root, infer src layout.
 *
 * Fix: install with `pip install .` (NOT `-e .` — editable on src layout
 * works but is less reliable across pip versions). Alternative: keep `-e .`
 * but add `--config-settings editable_mode=compat`. We pick `pip install .`
 * because it's simpler and has one dependency (pip itself) instead of a
 * config-setting flag that varies by pip version.
 */

export interface SrcLayoutInput {
  pyprojectTomlRaw?: string;
  /** All paths relative to workdir. */
  files?: string[];
}

export interface SrcLayoutResult {
  isSrcLayout: boolean;
  /** Replacement build command. */
  build?: string;
  reason: string;
}

export function detectSrcLayout(input: SrcLayoutInput): SrcLayoutResult {
  const pyproject = input.pyprojectTomlRaw ?? '';
  const files = input.files ?? [];

  const hasPyprojectFindDirective =
    /\[tool\.setuptools\.packages\.find\]/.test(pyproject)
    || /packages\s*=\s*\[[^\]]*['"]src/.test(pyproject)
    || /package-dir\s*=\s*\{\s*"?[\w-]*"?\s*=\s*"?src"?/.test(pyproject);

  const hasSrcDir = files.some(
    (f) => f === 'src' || f.startsWith('src/'),
  );

  const hasRootPackageInit = files.some(
    (f) => /^[^/]+\/__init__\.py$/.test(f) && !f.startsWith('src/'),
  );

  if (hasPyprojectFindDirective && hasSrcDir) {
    return {
      isSrcLayout: true,
      build: 'pip install .',
      reason: 'pyproject uses src/ layout with setuptools.packages.find',
    };
  }

  if (hasSrcDir && !hasRootPackageInit && /\[tool\.setuptools\]/.test(pyproject)) {
    return {
      isSrcLayout: true,
      build: 'pip install .',
      reason: 'src/ layout inferred, no root package',
    };
  }

  return { isSrcLayout: false, reason: 'not src layout' };
}
