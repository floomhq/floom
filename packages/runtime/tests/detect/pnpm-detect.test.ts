/**
 * Unit tests for Suite H fix #1 (pnpm workspace detection).
 *
 * Covers:
 *   - package.json with `workspace:*` deps → pnpm detected
 *   - package.json with top-level `workspaces` field → detected
 *   - pnpm-lock.yaml present → detected
 *   - plain npm package → not detected
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPnpm } from '@floom/detect';

test('detectPnpm: workspace: protocol in deps (BrowserMCP case)', () => {
  const pkg = JSON.stringify({
    name: 'mcp',
    dependencies: {
      '@browser-mcp/shared': 'workspace:*',
    },
  });
  const result = detectPnpm({ packageJsonRaw: pkg });
  assert.equal(result.isPnpmWorkspace, true);
  assert.match(result.reason, /workspace:/);
});

test('detectPnpm: top-level workspaces field', () => {
  const pkg = JSON.stringify({
    name: 'mcp-root',
    private: true,
    workspaces: ['packages/*'],
  });
  const result = detectPnpm({ packageJsonRaw: pkg });
  assert.equal(result.isPnpmWorkspace, true);
});

test('detectPnpm: pnpm-lock.yaml sibling', () => {
  const result = detectPnpm({
    packageJsonRaw: JSON.stringify({ name: 'x', dependencies: { react: '^18' } }),
    siblingFiles: ['package.json', 'pnpm-lock.yaml', 'README.md'],
  });
  assert.equal(result.isPnpmWorkspace, true);
  assert.match(result.reason, /pnpm-lock/);
});

test('detectPnpm: pnpm-workspace.yaml sibling', () => {
  const result = detectPnpm({
    packageJsonRaw: JSON.stringify({ name: 'x' }),
    siblingFiles: ['package.json', 'pnpm-workspace.yaml'],
  });
  assert.equal(result.isPnpmWorkspace, true);
});

test('detectPnpm: plain npm package is NOT pnpm', () => {
  const pkg = JSON.stringify({
    name: 'plain',
    dependencies: { lodash: '^4' },
  });
  const result = detectPnpm({
    packageJsonRaw: pkg,
    siblingFiles: ['package.json', 'package-lock.json'],
  });
  assert.equal(result.isPnpmWorkspace, false);
});

test('detectPnpm: malformed package.json with workspace: string still detected', () => {
  const result = detectPnpm({ packageJsonRaw: 'this is { not json but contains workspace:*}' });
  assert.equal(result.isPnpmWorkspace, true);
});
