/**
 * Unit tests for Suite H fix #3 (uv script detection).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectUv } from '@floom/detect';

test('detectUv: uv.lock present', () => {
  const result = detectUv({ siblingFiles: ['uv.lock', 'pyproject.toml'] });
  assert.equal(result.isUvProject, true);
  assert.match(result.build ?? '', /uv sync/);
});

test('detectUv: PEP 723 inline metadata (autoresearch case)', () => {
  const content = [
    '# /// script',
    '# dependencies = [',
    '#   "requests",',
    '# ]',
    '# ///',
    'import requests',
    'print("hello")',
  ].join('\n');
  const result = detectUv({
    pyFileHeaders: { 'prepare.py': content },
    siblingFiles: ['prepare.py', 'README.md'],
  });
  assert.equal(result.isUvProject, true);
  assert.equal(result.scriptFile, 'prepare.py');
});

test('detectUv: [tool.uv] in pyproject.toml', () => {
  const pyproject = `
[project]
name = "x"

[tool.uv]
dev-dependencies = ["pytest"]
`;
  const result = detectUv({ pyprojectTomlRaw: pyproject });
  assert.equal(result.isUvProject, true);
});

test('detectUv: plain pyproject is NOT uv', () => {
  const pyproject = `
[project]
name = "normal"
dependencies = ["requests"]
`;
  const result = detectUv({
    pyprojectTomlRaw: pyproject,
    siblingFiles: ['pyproject.toml', 'README.md'],
  });
  assert.equal(result.isUvProject, false);
});
