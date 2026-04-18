/**
 * Unit tests for Suite H fix #2 (Python src/ layout detection).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSrcLayout } from '@floom/detect';

test('detectSrcLayout: setuptools.packages.find with src/ (crewAI case)', () => {
  const pyproject = `
[project]
name = "crewai"
version = "1.0"

[tool.setuptools.packages.find]
where = ["src"]
`;
  const result = detectSrcLayout({
    pyprojectTomlRaw: pyproject,
    files: ['pyproject.toml', 'src/crewai/__init__.py', 'src/crewai/agent.py'],
  });
  assert.equal(result.isSrcLayout, true);
  assert.equal(result.build, 'pip install .');
});

test('detectSrcLayout: packages list with src prefix', () => {
  const pyproject = `
[project]
name = "foo"

[tool.setuptools]
packages = ["src.foo"]
`;
  const result = detectSrcLayout({
    pyprojectTomlRaw: pyproject,
    files: ['pyproject.toml', 'src/foo/__init__.py'],
  });
  assert.equal(result.isSrcLayout, true);
});

test('detectSrcLayout: classic flat layout is NOT src', () => {
  const pyproject = `
[project]
name = "flat"
`;
  const result = detectSrcLayout({
    pyprojectTomlRaw: pyproject,
    files: ['pyproject.toml', 'flat/__init__.py', 'flat/main.py'],
  });
  assert.equal(result.isSrcLayout, false);
});

test('detectSrcLayout: no pyproject, no detection', () => {
  const result = detectSrcLayout({ files: ['src/foo.py'] });
  assert.equal(result.isSrcLayout, false);
});
