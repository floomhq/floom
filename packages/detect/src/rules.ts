/**
 * Core auto-detect heuristics. Ported from `/tmp/analyze_repos_v3.py` into
 * TypeScript, with the 5 Suite H fixes wired in.
 *
 * The v3 analyzer scored 95.3% on the deployable universe (H1 doc). The
 * Suite H follow-up showed that "static score" does not equal "runtime
 * success": 3/10 runtime passes on a sample of high-scoring repos. The 5
 * Suite H fixes (workdir, pnpm, uv, src-layout, php-ext) are projected to
 * lift that to 8/10. This module is the single source of truth for all of
 * them.
 *
 * Source of truth for the heuristics: `/tmp/analyze_repos_v3.py`.
 */
import type { Runtime } from './types.ts';
import { detectPnpm } from './pnpm-detect.ts';
import { detectUv } from './uv-detect.ts';
import { detectSrcLayout } from './src-layout.ts';
import { detectPhpExtensions } from './php-ext.ts';
import { detectWorkdir, type FileEntry } from './workdir.ts';

export interface RepoSnapshot {
  /** owner/name — informational only. */
  fullName?: string;
  /** README.md contents if available. */
  readme?: string;
  /**
   * Full filetree (relative POSIX paths). We use this for workdir detection
   * and src-layout heuristics.
   */
  files: FileEntry[];
  /**
   * Map from relative path to file contents. Only needs entries for the
   * files the heuristics care about: package.json, pyproject.toml,
   * composer.json, go.mod, Cargo.toml, *.py at workdir root.
   */
  fileContents?: Record<string, string>;
  /** Optional description (from GitHub API). */
  description?: string;
}

export interface DetectResult {
  runtime: Runtime | 'php' | 'ruby' | 'unknown';
  build?: string;
  run?: string;
  workdir: string;
  /** Concrete Suite H fixes that fired. */
  fixesApplied: string[];
  /** Diagnostic notes from each detection pass. */
  notes: string[];
  /** Non-fatal warnings surfaced to the caller. */
  warnings: string[];
  /** Unknown PHP extensions that will probably still break the build. */
  unknownPhpExtensions?: string[];
}

/**
 * Runtime detection from the set of manifests present in a given directory.
 * Returns 'unknown' if nothing recognisable is found.
 */
function runtimeFromManifests(files: Set<string>): Runtime | 'php' | 'ruby' | 'unknown' {
  if (files.has('Dockerfile') || files.has('docker-compose.yml') || files.has('docker-compose.yaml') || files.has('compose.yml')) {
    return 'docker';
  }
  if (files.has('pyproject.toml') || files.has('requirements.txt') || files.has('setup.py')) {
    return 'python3.12';
  }
  if (files.has('package.json')) return 'node20';
  if (files.has('Cargo.toml')) return 'rust';
  if (files.has('go.mod')) return 'go1.22';
  if (files.has('composer.json')) return 'php';
  if (files.has('Gemfile')) return 'ruby';
  return 'unknown';
}

/**
 * Slice the filetree to only the files that live directly inside `workdir`
 * (non-recursive). Returns their basenames.
 */
function filesInDir(files: FileEntry[], workdir: string): string[] {
  const prefix = workdir ? workdir + '/' : '';
  const result: string[] = [];
  for (const f of files) {
    if (f.type !== 'file') continue;
    if (workdir === '') {
      if (!f.path.includes('/')) result.push(f.path);
    } else if (f.path.startsWith(prefix)) {
      const rest = f.path.slice(prefix.length);
      if (!rest.includes('/')) result.push(rest);
    }
  }
  return result;
}

function filesUnderDir(files: FileEntry[], workdir: string): string[] {
  const prefix = workdir ? workdir + '/' : '';
  return files
    .filter((f) => f.type === 'file' && (workdir === '' || f.path.startsWith(prefix)))
    .map((f) => (workdir ? f.path.slice(prefix.length) : f.path));
}

/**
 * The main detect entry point. Takes a RepoSnapshot and returns the
 * detected runtime + build + run + workdir, with fixes applied.
 */
export function detect(repo: RepoSnapshot): DetectResult {
  const notes: string[] = [];
  const warnings: string[] = [];
  const fixes: string[] = [];

  // -------------------------------------------------------------------
  // Suite H fix #4: workdir detection (deepest manifest)
  // -------------------------------------------------------------------
  const workdirResult = detectWorkdir(repo.files);
  if (!workdirResult) {
    return {
      runtime: 'unknown',
      workdir: '',
      fixesApplied: [],
      notes: ['No manifest file found anywhere in the tree'],
      warnings: ['Repository does not look like a standard software project'],
    };
  }
  const workdir = workdirResult.workdir;
  if (workdir) {
    fixes.push(`workdir-detect: using "${workdir}" (found ${workdirResult.manifest})`);
    notes.push(`workdir set to "${workdir}"`);
  }

  // -------------------------------------------------------------------
  // Runtime detection at the chosen workdir
  // -------------------------------------------------------------------
  const siblings = new Set(filesInDir(repo.files, workdir));
  const runtime = runtimeFromManifests(siblings);
  notes.push(`runtime=${runtime} from [${[...siblings].join(', ')}]`);

  const contents = repo.fileContents ?? {};
  const cwd = workdir ? `cd ${workdir} && ` : '';
  const pathFor = (name: string) => (workdir ? `${workdir}/${name}` : name);

  let build: string | undefined;
  let run: string | undefined;
  let unknownPhpExtensions: string[] | undefined;

  switch (runtime) {
    case 'python3.12':
    case 'python3.11': {
      const pyprojectRaw = contents[pathFor('pyproject.toml')];

      // Suite H fix #3: uv detection
      const pyFileHeaders: Record<string, string> = {};
      for (const f of siblings) {
        if (f.endsWith('.py')) {
          const content = contents[pathFor(f)];
          if (content) pyFileHeaders[f] = content;
        }
      }
      const uv = detectUv({
        pyprojectTomlRaw: pyprojectRaw,
        pyFileHeaders,
        siblingFiles: [...siblings],
      });
      if (uv.isUvProject) {
        fixes.push(`uv-detect: ${uv.reason}`);
        build = cwd + (uv.build ?? 'pip install uv && uv sync');
        if (uv.scriptFile) {
          run = cwd + `uv run ${uv.scriptFile}`;
        }
        notes.push(`uv project detected, build=${build}`);
      }

      // Suite H fix #2: src layout
      if (!build) {
        const allUnderWorkdir = filesUnderDir(repo.files, workdir);
        const src = detectSrcLayout({
          pyprojectTomlRaw: pyprojectRaw,
          files: allUnderWorkdir,
        });
        if (src.isSrcLayout && src.build) {
          fixes.push(`src-layout: ${src.reason}`);
          build = cwd + src.build;
          notes.push(`src/ layout detected, using ${src.build} instead of -e .`);
        }
      }

      // Default Python build rules (from v3 analyzer)
      if (!build) {
        if (siblings.has('pyproject.toml')) {
          build = cwd + 'pip install -e .';
        } else if (siblings.has('requirements.txt')) {
          build = cwd + 'pip install -r requirements.txt';
        } else if (siblings.has('setup.py')) {
          build = cwd + 'pip install -e .';
        }
      }

      // Run command: prefer pyproject [project.scripts] entry, then README,
      // then file convention fallback.
      if (!run) {
        run = detectPythonRun(siblings, pyprojectRaw, cwd, repo.readme ?? '');
      }
      break;
    }

    case 'node20':
    case 'node22': {
      const packageJsonRaw = contents[pathFor('package.json')];

      // Suite H fix #1: pnpm workspace protocol
      const pnpm = detectPnpm({
        packageJsonRaw,
        siblingFiles: [...siblings],
      });
      if (pnpm.isPnpmWorkspace) {
        fixes.push(`pnpm-detect: ${pnpm.reason}`);
        // Install pnpm first (not in default e2b template, per Suite H
        // failure #7), then run pnpm install. Using npm's pnpm shim avoids
        // the multi-step npm install -g pnpm dance.
        build = cwd + 'npm install -g pnpm && pnpm install';
        notes.push(`pnpm workspace, build=${build}`);
      } else if (siblings.has('pnpm-lock.yaml')) {
        build = cwd + 'npm install -g pnpm && pnpm install';
        fixes.push('pnpm-detect: pnpm-lock.yaml present');
      } else if (siblings.has('yarn.lock')) {
        build = cwd + 'yarn install';
      } else if (siblings.has('bun.lockb')) {
        build = cwd + 'bun install';
      } else {
        build = cwd + 'npm install';
      }

      if (packageJsonRaw) {
        run = detectNodeRun(packageJsonRaw, cwd);
      }
      if (!run) run = cwd + 'npm start';
      break;
    }

    case 'go1.22': {
      // Suite H fix #4 already moved us into the subdir with go.mod.
      build = cwd + 'go build -o app .';
      run = cwd + './app';
      break;
    }

    case 'rust': {
      build = cwd + 'cargo build --release';
      run = cwd + './target/release/app';
      warnings.push(
        'Rust release build may OOM on the default 512MB e2b template '
        + '(Suite H aichat failure). Consider a 2GB template.',
      );
      break;
    }

    case 'docker': {
      build = cwd + 'docker build -t app .';
      run = cwd + 'docker run --rm app';
      warnings.push(
        'Docker runtime: building Docker inside an e2b sandbox requires '
        + 'Docker-in-Docker or a custom template. Default e2b template does '
        + 'not ship docker.',
      );
      break;
    }

    case 'php': {
      const composerRaw = contents[pathFor('composer.json')];

      // Suite H fix #5: PHP extensions
      const php = detectPhpExtensions({ composerJsonRaw: composerRaw });
      if (php.aptPackages.length > 0) {
        fixes.push(
          `php-ext: auto-installing ${php.extensions.join(', ')} via ${php.aptPackages.join(' ')}`,
        );
        build = cwd + php.installPrefix + 'composer install';
      } else {
        build = cwd + 'composer install';
      }
      if (php.unknownExtensions.length > 0) {
        warnings.push(
          `Unknown PHP extensions not mapped to apt packages: ${php.unknownExtensions.join(', ')}. `
          + 'Build will likely fail; extend EXT_TO_APT in src/detect/php-ext.ts.',
        );
        unknownPhpExtensions = php.unknownExtensions;
      }
      run = cwd + 'php -S 0.0.0.0:8080';
      break;
    }

    case 'ruby': {
      build = cwd + 'bundle install';
      run = cwd + 'bundle exec ruby main.rb';
      break;
    }

    default:
      break;
  }

  return {
    runtime,
    build,
    run,
    workdir,
    fixesApplied: fixes,
    notes,
    warnings,
    ...(unknownPhpExtensions ? { unknownPhpExtensions } : {}),
  };
}

/**
 * Detect the Python run command by inspecting pyproject.toml scripts,
 * README code blocks, and file conventions. Ported from v3 analyzer.
 */
function detectPythonRun(
  siblings: Set<string>,
  pyprojectRaw: string | undefined,
  cwd: string,
  readme: string,
): string | undefined {
  // 1) [project.scripts] from pyproject.toml
  if (pyprojectRaw) {
    const section = pyprojectRaw.match(/\[project\.scripts\]([\s\S]*?)(?:\n\[|$)/);
    const poetrySection = pyprojectRaw.match(/\[tool\.poetry\.scripts\]([\s\S]*?)(?:\n\[|$)/);
    const body = (section ?? poetrySection)?.[1];
    if (body) {
      const line = body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#'));
      if (line) {
        const m = line.match(/^"?([\w-]+)"?\s*=/);
        if (m) return `${cwd}${m[1]}`;
      }
    }
  }

  // 2) README usage blocks
  const fences = [...readme.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/g)];
  for (const fence of fences) {
    const lines = fence[1]!.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/^\$\s*/, '').trim();
      if (!line || line.startsWith('#')) continue;
      if (/install|setup|build|pip install|uv add/.test(line)) continue;
      const pythonMatch = line.match(/^(python3?\s+(?:-m\s+)?[\w\-./]+)/);
      if (pythonMatch) return `${cwd}${pythonMatch[1]}`;
      const uvMatch = line.match(/^(uv\s+run\s+[\w\-./]+)/);
      if (uvMatch) return `${cwd}${uvMatch[1]}`;
    }
  }

  // 3) File-convention fallback
  for (const candidate of ['main.py', 'app.py', 'cli.py', 'run.py', '__main__.py', 'server.py']) {
    if (siblings.has(candidate)) return `${cwd}python ${candidate}`;
  }
  // Wider keyword-based pattern (Suite A insight: many Python CLIs name their
  // entry with a meaningful prefix like `generate_*.py`, `run_*.py`,
  // `bridge_*.py`, etc). We pick the SHORTEST matching name so a file called
  // `generate_theses.py` is preferred over `generate_accelerator_thesis.py`
  // when both match — shorter names are usually the more generic entrypoint.
  const keywordMatches = [...siblings]
    .filter((f) => f.endsWith('.py') && /^(server|mcp|cli|bot|agent|main|entry|start|run|bridge|generate|execute|launch)_?/i.test(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (keywordMatches.length > 0) {
    return `${cwd}python ${keywordMatches[0]}`;
  }
  // Fallback: single .py file at root
  const pyFiles = [...siblings].filter((f) => f.endsWith('.py'));
  if (pyFiles.length === 1) return `${cwd}python ${pyFiles[0]}`;
  // Last-resort: multi-file Python library with no clear entry → probably a
  // package that's `pip install`ed and exposes a CLI matching the repo name.
  // Caller can use `{reponame} --help` via smokeWithHelp. We return undefined
  // here and let the generator mark it as draft.
  return undefined;
}

/**
 * Detect the Node run command by looking at package.json `bin`, `scripts.start`,
 * and `main`. Ported from v3 analyzer.
 */
function detectNodeRun(packageJsonRaw: string, cwd: string): string | undefined {
  try {
    const parsed = JSON.parse(packageJsonRaw) as Record<string, unknown>;
    const bin = parsed['bin'];
    if (typeof bin === 'string') return `${cwd}${bin}`;
    if (bin && typeof bin === 'object') {
      const first = Object.keys(bin as Record<string, unknown>)[0];
      if (first) return `${cwd}${first}`;
    }
    const scripts = parsed['scripts'];
    if (scripts && typeof scripts === 'object' && (scripts as Record<string, unknown>)['start']) {
      return `${cwd}npm start`;
    }
    const main = parsed['main'];
    if (typeof main === 'string') return `${cwd}node ${main}`;
  } catch {
    return undefined;
  }
  return undefined;
}
