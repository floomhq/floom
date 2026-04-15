#!/usr/bin/env node
// Blast Radius — proxied-mode HTTP server. Clones a public git repo, diffs a
// base ref against a head ref, and returns the list of changed files plus a
// naive set of files likely "affected" by those changes (import matches).
//
// Pure Node.js; shells out to the system `git` binary. No external npm deps.
//
// Run: node examples/blast-radius/server.mjs
// Env: PORT=4113 (default), WORK_DIR=/tmp/blast-radius (default)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname } from 'node:path';

const PORT = Number(process.env.PORT || 4113);
const MAX_FILES_SCAN = 2000;
const MAX_FILE_BYTES = 500_000;

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Blast Radius',
    version: '0.2.0',
    description:
      'Find all files affected by your changes. Clone a public git repo and report files touched by a branch diff plus likely-affected files via import matches.',
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/analyze': {
      post: {
        operationId: 'analyze',
        summary: 'Analyze a repo diff',
        description:
          'Clone a public git repo, compute the diff between base and head refs, return changed + affected files.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['repo_url'],
                properties: {
                  repo_url: {
                    type: 'string',
                    description: 'Public HTTPS git URL (https://github.com/owner/repo).',
                  },
                  base_branch: {
                    type: 'string',
                    description: 'Base ref to diff against. Defaults to HEAD~5.',
                    default: 'HEAD~5',
                  },
                  head_ref: {
                    type: 'string',
                    description: 'Head ref to check out before diffing.',
                    default: 'HEAD',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Diff results',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    summary: { type: 'string' },
                    changed: { type: 'array' },
                    affected: { type: 'array' },
                    tests: { type: 'array' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// ---------- git helpers ----------

function run(cmd, args, cwd, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const to = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (c) => (stdout += c.toString('utf-8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf-8')));
    child.on('error', (e) => {
      clearTimeout(to);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(to);
      if (code !== 0) {
        return reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
      }
      resolve(stdout);
    });
  });
}

function validateRepoUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('repo_url is not a valid URL');
  }
  if (u.protocol !== 'https:') {
    throw new Error('repo_url must use https://');
  }
  if (!/^[\w.-]+$/.test(u.hostname)) {
    throw new Error('repo_url hostname is invalid');
  }
  return u.toString();
}

function sanitizeRef(ref) {
  // Allow alphanumerics, dashes, underscores, slashes, dots, and HEAD~N
  if (!/^[A-Za-z0-9._/~^-]+$/.test(ref)) {
    throw new Error(`invalid ref: ${ref}`);
  }
  return ref;
}

async function analyze({ repo_url, base_branch = 'HEAD~5', head_ref = 'HEAD' }) {
  const url = validateRepoUrl(repo_url);
  const base = sanitizeRef(base_branch);
  const head = sanitizeRef(head_ref);
  const workDir = mkdtempSync(join(tmpdir(), 'blast-radius-'));
  try {
    // Shallow clone first, then deepen as needed for HEAD~N diffs
    await run('git', ['clone', '--depth', '50', '--no-tags', url, workDir], undefined, 90_000);
    if (head !== 'HEAD') {
      try {
        await run('git', ['checkout', head], workDir);
      } catch {
        // ignore, we'll diff from HEAD
      }
    }
    // Resolve base ref to a commit sha (tolerate HEAD~N syntax)
    let baseRef = base;
    try {
      const sha = (await run('git', ['rev-parse', base], workDir)).trim();
      baseRef = sha || base;
    } catch {
      // fall back to HEAD~5 if the requested base ref doesn't exist
      baseRef = 'HEAD~5';
      try {
        await run('git', ['rev-parse', baseRef], workDir);
      } catch {
        baseRef = 'HEAD~1';
      }
    }
    const diffOut = await run('git', ['diff', '--name-only', `${baseRef}...HEAD`], workDir);
    const changed = diffOut
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    // Find tests: any file under tests/ or test/ or __tests__/ or *.test.* or *.spec.*
    const tests = changed.filter(
      (f) =>
        /(^|\/)tests?\//.test(f) ||
        /__tests__/.test(f) ||
        /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) ||
        /_test\.(py|go)$/.test(f),
    );

    // Affected: files that import a changed file (crude grep over source files)
    const affected = new Set();
    const importCandidates = walkSourceFiles(workDir, MAX_FILES_SCAN);
    const changedBaseNames = new Set(
      changed.map((f) => basenameNoExt(f)).filter((b) => b.length >= 3),
    );
    for (const file of importCandidates) {
      if (affected.size >= 200) break;
      let text;
      try {
        const stat = statSync(file);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      for (const bn of changedBaseNames) {
        if (text.includes(bn)) {
          affected.add(relative(workDir, file));
          break;
        }
      }
    }

    const summary = [
      `Repo: ${url}`,
      `Diff: ${baseRef}...HEAD`,
      `Changed files: ${changed.length}`,
      `Test files: ${tests.length}`,
      `Files likely affected (import match): ${affected.size}`,
    ].join('\n');

    return {
      summary,
      changed,
      affected: Array.from(affected),
      tests,
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function walkSourceFiles(root, limit) {
  const SRC_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java']);
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'venv', '.venv', '__pycache__']);
  const out = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= limit) break;
      if (IGNORE.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        if (SRC_EXT.has(extname(e.name))) out.push(full);
      }
    }
  }
  return out;
}

function basenameNoExt(p) {
  const parts = p.split('/');
  const last = parts[parts.length - 1] || '';
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(0, dot) : last;
}

// ---------- HTTP plumbing ----------

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/openapi.json') return sendJson(res, 200, spec);
    if (req.method === 'GET' && url.pathname === '/health')
      return sendJson(res, 200, { ok: true, service: 'blast-radius' });

    if (req.method === 'POST' && url.pathname === '/analyze') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json body' });
      }
      if (typeof body.repo_url !== 'string') {
        return sendJson(res, 400, { error: "missing required field 'repo_url'" });
      }
      try {
        const out = await analyze(body);
        return sendJson(res, 200, out);
      } catch (err) {
        return sendJson(res, 500, { error: 'analyze_failed', message: err.message });
      }
    }

    sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    console.error('[blast-radius]', err);
    sendJson(res, 500, { error: 'internal error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[blast-radius] listening on http://localhost:${PORT}`);
  console.log(`[blast-radius] spec at  http://localhost:${PORT}/openapi.json`);
});
