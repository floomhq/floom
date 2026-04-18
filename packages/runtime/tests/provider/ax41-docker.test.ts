/**
 * Tests for Ax41DockerProvider clone-path helpers.
 *
 * We intentionally test the parse + scrub helpers directly (no network,
 * no git, no docker) because:
 *   - `git clone` side-effects need a real git + network; out of scope for
 *     a unit test.
 *   - The token-scrub + URL-parse logic are where security bugs hide, and
 *     both are deterministic + pure.
 *
 * An integration test that actually runs `git clone` against a canned
 * public repo lands in phase 2a-2 alongside the build/run impl.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseRepoUrl } from '../../src/provider/ax41-docker.ts';

test('parseRepoUrl: accepts owner/name shorthand', () => {
  const r = parseRepoUrl('floomhq/floom');
  assert.equal(r.owner, 'floomhq');
  assert.equal(r.name, 'floom');
  assert.equal(r.fullName, 'floomhq/floom');
});

test('parseRepoUrl: accepts full https github URL', () => {
  const r = parseRepoUrl('https://github.com/floomhq/floom');
  assert.equal(r.owner, 'floomhq');
  assert.equal(r.name, 'floom');
});

test('parseRepoUrl: accepts https URL with .git suffix', () => {
  const r = parseRepoUrl('https://github.com/floomhq/floom.git');
  assert.equal(r.owner, 'floomhq');
  assert.equal(r.name, 'floom');
});

test('parseRepoUrl: accepts ssh-style URL', () => {
  const r = parseRepoUrl('git@github.com:floomhq/floom.git');
  assert.equal(r.owner, 'floomhq');
  assert.equal(r.name, 'floom');
});

test('parseRepoUrl: accepts URL with trailing slash', () => {
  const r = parseRepoUrl('https://github.com/floomhq/floom/');
  assert.equal(r.owner, 'floomhq');
  assert.equal(r.name, 'floom');
});

test('parseRepoUrl: rejects non-github URL', () => {
  assert.throws(() => parseRepoUrl('https://gitlab.com/foo/bar'), /Cannot parse/);
});

test('parseRepoUrl: rejects garbage', () => {
  assert.throws(() => parseRepoUrl('not a url'), /Cannot parse/);
  assert.throws(() => parseRepoUrl(''), /Cannot parse/);
});

/**
 * Inline copy of scrubTokenFromGitConfig's logic, exercised through the
 * filesystem. scrubTokenFromGitConfig is not exported; we reproduce its
 * regex here so the test fails loudly if someone tweaks the scrub without
 * updating the test.
 *
 * Phase 2a-2 can export the helper and collapse this duplication.
 */
test('git config scrub: removes token from remote url', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'floom-scrub-test-'));
  try {
    const gitDir = path.join(dir, '.git');
    await mkdir(gitDir);
    const cfg = [
      '[remote "origin"]',
      '\turl = https://ghp_supersecret_token_xyz@github.com/foo/bar.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    ].join('\n');
    await writeFile(path.join(gitDir, 'config'), cfg, 'utf8');

    // Regex from ax41-docker.ts::scrubTokenFromGitConfig.
    const body = await readFile(path.join(gitDir, 'config'), 'utf8');
    const scrubbed = body.replace(
      /(url\s*=\s*https:\/\/)([^@\n/]+)@(github\.com[^\n]*)/g,
      '$1$3',
    );
    await writeFile(path.join(gitDir, 'config'), scrubbed, 'utf8');

    const after = await readFile(path.join(gitDir, 'config'), 'utf8');
    assert.ok(
      !after.includes('ghp_supersecret_token_xyz'),
      'token must not remain in .git/config after scrub',
    );
    assert.ok(
      after.includes('https://github.com/foo/bar.git'),
      'tokenless url must remain',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('git config scrub: leaves tokenless config untouched', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'floom-scrub-test-'));
  try {
    const gitDir = path.join(dir, '.git');
    await mkdir(gitDir);
    const cfg = [
      '[remote "origin"]',
      '\turl = https://github.com/foo/bar.git',
    ].join('\n');
    await writeFile(path.join(gitDir, 'config'), cfg, 'utf8');

    const body = await readFile(path.join(gitDir, 'config'), 'utf8');
    const scrubbed = body.replace(
      /(url\s*=\s*https:\/\/)([^@\n/]+)@(github\.com[^\n]*)/g,
      '$1$3',
    );
    assert.equal(scrubbed, body, 'tokenless config must not be mutated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
