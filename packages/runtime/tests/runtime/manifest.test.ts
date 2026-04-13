/**
 * Unit tests for manifest parse + generate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '@floom/manifest';
import { generateManifest } from '@floom/manifest';
import type { RepoSnapshot } from '@floom/detect';

test('parseManifest: valid manifest round-trips', () => {
  const yaml = `
name: demo
displayName: Demo App
description: A demo.
creator: floom
runtime: python3.12
build: pip install -e .
run: demo --run
inputs:
  - name: query
    type: string
    required: true
outputs:
  type: stdout
secrets:
  - OPENAI_API_KEY
memoryMb: 1024
timeout: 60s
`;
  const result = parseManifest(yaml);
  assert.equal(result.ok, true);
  assert.equal(result.manifest?.name, 'demo');
  assert.equal(result.manifest?.runtime, 'python3.12');
  assert.equal(result.manifest?.inputs.length, 1);
  assert.deepEqual(result.manifest?.secrets, ['OPENAI_API_KEY']);
  assert.equal(result.manifest?.memoryMb, 1024);
});

test('parseManifest: missing required field reported', () => {
  const yaml = `
name: bad
runtime: python3.12
`;
  const result = parseManifest(yaml);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('run')));
});

test('parseManifest: invalid runtime rejected', () => {
  const yaml = `
name: x
runtime: cobol
run: echo hi
inputs: []
outputs: { type: stdout }
`;
  const result = parseManifest(yaml);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('runtime')));
});

test('generateManifest: fastmcp produces complete manifest', () => {
  const snap: RepoSnapshot = {
    fullName: 'PrefectHQ/fastmcp',
    description: 'Fast MCP server',
    readme: '',
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
  const result = generateManifest(snap);
  assert.equal(result.isDraft, false);
  assert.equal(result.manifest?.name, 'fastmcp');
  assert.equal(result.manifest?.build, 'pip install -e .');
  assert.equal(result.manifest?.run, 'fastmcp');
});

test('generateManifest: BrowserMCP uses pnpm build', () => {
  const snap: RepoSnapshot = {
    fullName: 'BrowserMCP/mcp',
    description: 'browser MCP',
    files: [
      { path: 'package.json', type: 'file' },
    ],
    fileContents: {
      'package.json': JSON.stringify({
        name: 'mcp',
        bin: { 'mcp-server-browsermcp': 'dist/index.js' },
        dependencies: { '@browser-mcp/shared': 'workspace:*' },
      }),
    },
  };
  const result = generateManifest(snap);
  assert.match(result.manifest?.build ?? '', /pnpm install/);
  assert.equal(result.manifest?.run, 'mcp-server-browsermcp');
});
