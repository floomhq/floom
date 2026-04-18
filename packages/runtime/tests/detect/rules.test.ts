/**
 * Integration test for the top-level detect() function. Walks each of the
 * 10 Suite H repos through the fixed analyzer and asserts:
 *
 *   - The detected runtime / build / run match the expected post-fix values.
 *   - The `fixesApplied` array names the right Suite H fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '@floom/detect';
import type { RepoSnapshot } from '@floom/detect';

test('detect: BrowserMCP/mcp flips to pnpm', () => {
  const snap: RepoSnapshot = {
    fullName: 'BrowserMCP/mcp',
    readme: '# Browser MCP\n```bash\nnpm run build\n```',
    files: [
      { path: 'package.json', type: 'file' },
      { path: 'README.md', type: 'file' },
    ],
    fileContents: {
      'package.json': JSON.stringify({
        name: 'mcp',
        dependencies: { '@browsermcp/core': 'workspace:*' },
      }),
    },
  };
  const result = detect(snap);
  assert.equal(result.runtime, 'node20');
  assert.match(result.build ?? '', /pnpm/);
  assert.ok(result.fixesApplied.some((f) => f.startsWith('pnpm-detect')));
});

test('detect: karpathy/autoresearch flips to uv', () => {
  const snap: RepoSnapshot = {
    fullName: 'karpathy/autoresearch',
    readme: '# autoresearch',
    files: [
      { path: 'pyproject.toml', type: 'file' },
      { path: 'prepare.py', type: 'file' },
    ],
    fileContents: {
      'pyproject.toml': '[project]\nname = "autoresearch"\n',
      'prepare.py': '# /// script\n# dependencies = ["requests"]\n# ///\nimport requests\n',
    },
  };
  const result = detect(snap);
  assert.equal(result.runtime, 'python3.12');
  assert.match(result.build ?? '', /uv/);
  assert.ok(result.fixesApplied.some((f) => f.startsWith('uv-detect')));
});

test('detect: crewAI uses src/ layout, switch to pip install .', () => {
  const snap: RepoSnapshot = {
    fullName: 'crewAIInc/crewAI',
    readme: '# crewAI\n```\ncrewai --help\n```',
    files: [
      { path: 'pyproject.toml', type: 'file' },
      { path: 'src/crewai/__init__.py', type: 'file' },
      { path: 'src/crewai/agent.py', type: 'file' },
    ],
    fileContents: {
      'pyproject.toml': '[project]\nname="crewai"\n[tool.setuptools.packages.find]\nwhere=["src"]\n',
    },
  };
  const result = detect(snap);
  assert.equal(result.runtime, 'python3.12');
  assert.equal(result.build, 'pip install .');
  assert.ok(result.fixesApplied.some((f) => f.startsWith('src-layout')));
});

test('detect: airflow-client-go uses subdir workdir', () => {
  const snap: RepoSnapshot = {
    fullName: 'apache/airflow-client-go',
    files: [
      { path: 'README.md', type: 'file' },
      { path: 'airflow-client-go/go.mod', type: 'file' },
      { path: 'airflow-client-go/main.go', type: 'file' },
    ],
    fileContents: {},
  };
  const result = detect(snap);
  assert.equal(result.runtime, 'go1.22');
  assert.equal(result.workdir, 'airflow-client-go');
  assert.match(result.build ?? '', /go build/);
  assert.ok(result.fixesApplied.some((f) => f.startsWith('workdir-detect')));
});

test('detect: ai-client-html installs ext-curl', () => {
  const snap: RepoSnapshot = {
    fullName: 'aimeos/ai-client-html',
    files: [
      { path: 'composer.json', type: 'file' },
      { path: 'src', type: 'dir' },
    ],
    fileContents: {
      'composer.json': JSON.stringify({
        name: 'aimeos/ai-client-html',
        require: { php: '>=8.0', 'ext-curl': '*' },
      }),
    },
  };
  const result = detect(snap);
  assert.equal(result.runtime, 'php');
  assert.match(result.build ?? '', /php-curl/);
  assert.ok(result.fixesApplied.some((f) => f.startsWith('php-ext')));
});

test('detect: fastmcp (simple Python package) - no fix needed', () => {
  const snap: RepoSnapshot = {
    fullName: 'PrefectHQ/fastmcp',
    readme: '# fastmcp\n```\nfastmcp --help\n```',
    files: [
      { path: 'pyproject.toml', type: 'file' },
      { path: 'fastmcp', type: 'dir' },
      { path: 'fastmcp/__init__.py', type: 'file' },
    ],
    fileContents: {
      'pyproject.toml': `[project]
name = "fastmcp"
[project.scripts]
fastmcp = "fastmcp.cli:main"
`,
    },
  };
  const result = detect(snap);
  assert.equal(result.runtime, 'python3.12');
  assert.equal(result.build, 'pip install -e .');
  assert.equal(result.run, 'fastmcp');
  assert.equal(result.workdir, '');
});
