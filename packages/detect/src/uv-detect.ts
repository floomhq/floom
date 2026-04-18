/**
 * Suite H fix #3: uv script / uv project detection.
 *
 * karpathy/autoresearch failed because the repo has a `pyproject.toml` with
 * `uv` metadata but no `[project]` section that `pip install -e .` can use.
 * Trying to pip-install it produces an empty UNKNOWN package.
 *
 * Detection rules:
 *   1. `uv.lock` at the workdir -> it's a uv project; use `uv sync`.
 *   2. Any .py file at the workdir root starts with PEP 723 inline script
 *      metadata: `# /// script` ... `# ///`. We don't try to run the script
 *      directly — just switch the runner to `uv run <file>`.
 *   3. A `[tool.uv]` section in pyproject.toml also counts as a uv project.
 */

export interface UvDetectInput {
  pyprojectTomlRaw?: string;
  /** filename -> content for .py files near the workdir root. */
  pyFileHeaders?: Record<string, string>;
  siblingFiles?: string[];
}

export interface UvDetectResult {
  isUvProject: boolean;
  /** Recommended install command (replaces build). */
  build?: string;
  /** If a PEP 723 script is found, the file to run it as. */
  scriptFile?: string;
  reason: string;
}

export function detectUv(input: UvDetectInput): UvDetectResult {
  const siblings = new Set(input.siblingFiles ?? []);

  if (siblings.has('uv.lock')) {
    return {
      isUvProject: true,
      build: 'pip install uv && uv sync',
      reason: 'uv.lock present',
    };
  }

  const py = input.pyprojectTomlRaw ?? '';
  if (py.includes('[tool.uv]') || py.includes('[tool.uv.sources]')) {
    return {
      isUvProject: true,
      build: 'pip install uv && uv sync',
      reason: 'pyproject.toml has [tool.uv]',
    };
  }

  // PEP 723: /// script metadata in a .py file header.
  //   # /// script
  //   # dependencies = [ ... ]
  //   # ///
  for (const [filename, content] of Object.entries(input.pyFileHeaders ?? {})) {
    // Only look at the first ~40 lines — PEP 723 blocks are always at the top.
    const header = content.split('\n').slice(0, 40).join('\n');
    if (/#\s*\/\/\/\s*script/i.test(header)) {
      return {
        isUvProject: true,
        build: 'pip install uv',
        scriptFile: filename,
        reason: `PEP 723 inline metadata in ${filename}`,
      };
    }
  }

  return { isUvProject: false, reason: 'no uv signals' };
}
