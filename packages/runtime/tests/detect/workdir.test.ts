/**
 * Unit tests for the Suite H fix #4 (workdir detection).
 *
 * Covers:
 *   - Python repo with manifest at root → workdir = ''
 *   - Go module in a subdirectory (airflow-client-go case) → workdir = 'clients/go'
 *   - Multi-language monorepo → picks shallowest
 *   - Empty repo → null
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectWorkdir } from '@floom/detect';

test('detectWorkdir: root manifest wins over nested', () => {
  const result = detectWorkdir([
    { path: 'pyproject.toml', type: 'file' },
    { path: 'src/foo/__init__.py', type: 'file' },
    { path: 'submodule/go.mod', type: 'file' },
  ]);
  assert.deepEqual(result, { workdir: '', manifest: 'pyproject.toml' });
});

test('detectWorkdir: Go module in subdir (airflow-client-go regression)', () => {
  const result = detectWorkdir([
    { path: 'README.md', type: 'file' },
    { path: 'LICENSE', type: 'file' },
    { path: 'clients', type: 'dir' },
    { path: 'clients/go', type: 'dir' },
    { path: 'clients/go/go.mod', type: 'file' },
    { path: 'clients/go/main.go', type: 'file' },
  ]);
  assert.deepEqual(result, { workdir: 'clients/go', manifest: 'go.mod' });
});

test('detectWorkdir: prefer shallowest, tie-break alphabetically', () => {
  const result = detectWorkdir([
    { path: 'backend/pyproject.toml', type: 'file' },
    { path: 'frontend/package.json', type: 'file' },
    { path: 'deep/nested/path/Cargo.toml', type: 'file' },
  ]);
  // backend/ and frontend/ are both at depth 1. 'backend' sorts first.
  assert.equal(result?.workdir, 'backend');
});

test('detectWorkdir: returns null when nothing recognisable', () => {
  const result = detectWorkdir([
    { path: 'README.md', type: 'file' },
    { path: 'notes.txt', type: 'file' },
  ]);
  assert.equal(result, null);
});

test('detectWorkdir: package.json at root wins over go.mod in subdir', () => {
  const result = detectWorkdir([
    { path: 'package.json', type: 'file' },
    { path: 'server/go.mod', type: 'file' },
  ]);
  assert.deepEqual(result, { workdir: '', manifest: 'package.json' });
});
