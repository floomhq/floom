#!/usr/bin/env node
// Stress/unit coverage for scripts/ops/db-backup.sh.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BACKUP_SCRIPT = join(REPO_ROOT, 'scripts', 'ops', 'db-backup.sh');
const RESTORE_SCRIPT = join(REPO_ROOT, 'scripts', 'ops', 'db-restore.sh');

let passed = 0;
let failed = 0;

function log(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}

function runSqlite(dbPath, sql) {
  return run('sqlite3', [dbPath, sql]).stdout.trim();
}

console.log('db backup encrypted snapshot');

const workDir = mkdtempSync(join(tmpdir(), 'floom-db-backup-test-'));
const dbPath = join(workDir, 'sample.db');
const backupsDir = join(workDir, 'backups');
const identityPath = join(workDir, 'age-identity.txt');
const decryptedZst = join(workDir, 'decrypted.db.zst');
const restoredDb = join(workDir, 'restored.db');
const restoreTargetDb = join(workDir, 'restore-target.db');
const restoreStagingDb = `${restoreTargetDb}.restore-staging`;

runSqlite(
  dbPath,
  `
  PRAGMA journal_mode=WAL;
  CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, rating INTEGER NOT NULL);
  WITH RECURSIVE c(x) AS (
    SELECT 1
    UNION ALL
    SELECT x + 1 FROM c WHERE x < 100
  )
  INSERT INTO users(email, rating)
  SELECT 'user-' || x || '@example.test', x % 5 FROM c;
  `,
);

const keygen = spawnSync('age-keygen', ['-o', identityPath], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(keygen.status, 0, keygen.stderr);
const publicKey = `${keygen.stdout}\n${keygen.stderr}`
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.startsWith('Public key: '))
  ?.replace('Public key: ', '');
assert.ok(publicKey?.startsWith('age1'), `age-keygen output did not include public key: ${keygen.stderr}`);

const timestamp = '2026-04-26T03-00-00Z';
const backupFile = join(backupsDir, `floom-chat-${timestamp}.db.zst.age`);

const backup = spawnSync('bash', [BACKUP_SCRIPT], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BACKUP_TEST_MODE: '1',
    BACKUP_SOURCE_DB: dbPath,
    BACKUP_LOCAL_DIR: backupsDir,
    BACKUP_LOG_FILE: join(workDir, 'backup.log'),
    BACKUP_AGE_RECIPIENT: publicKey,
    BACKUP_TIMESTAMP: timestamp,
  },
});
log('backup script exits 0 in test mode', backup.status === 0, backup.stderr);
assert.equal(backup.status, 0, backup.stderr);

const encryptedHeader = readFileSync(backupFile, 'utf8').slice(0, 128);
log('encrypted age file exists', encryptedHeader.startsWith('age-encryption.org/v1'), encryptedHeader);
assert.ok(encryptedHeader.startsWith('age-encryption.org/v1'));

const sizeBytes = statSync(backupFile).size;
log('encrypted sample backup is below 10MB', sizeBytes < 10 * 1024 * 1024, `size=${sizeBytes}`);
assert.ok(sizeBytes < 10 * 1024 * 1024);

run('age', ['-d', '-i', identityPath, '-o', decryptedZst, backupFile]);
run('zstd', ['-d', '-q', '-f', decryptedZst, '-o', restoredDb]);

const integrity = runSqlite(restoredDb, 'PRAGMA integrity_check;');
log('restored DB integrity_check is ok', integrity === 'ok', integrity);
assert.equal(integrity, 'ok');

const count = runSqlite(restoredDb, 'SELECT count(*) FROM users;');
log('restored DB keeps 100 sample rows', count === '100', count);
assert.equal(count, '100');

const restore = spawnSync('bash', [RESTORE_SCRIPT, 'latest'], {
  cwd: REPO_ROOT,
  input: 'NO\n',
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BACKUP_LOCAL_DIR: backupsDir,
    BACKUP_AGE_IDENTITY: identityPath,
    RESTORE_DB_PATH: restoreTargetDb,
  },
});
log('restore script stages and validates backup', restore.status === 0 && existsSync(restoreStagingDb), restore.stderr);
assert.equal(restore.status, 0, restore.stderr);
assert.ok(existsSync(restoreStagingDb));
assert.equal(runSqlite(restoreStagingDb, 'PRAGMA integrity_check;'), 'ok');

const rerun = spawnSync('bash', [BACKUP_SCRIPT], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BACKUP_TEST_MODE: '1',
    BACKUP_SOURCE_DB: dbPath,
    BACKUP_LOCAL_DIR: backupsDir,
    BACKUP_LOG_FILE: join(workDir, 'backup.log'),
    BACKUP_AGE_RECIPIENT: publicKey,
    BACKUP_TIMESTAMP: timestamp,
  },
});
log('same-minute rerun is a no-op success', rerun.status === 0 && rerun.stderr.includes('already exists'), rerun.stderr);
assert.equal(rerun.status, 0, rerun.stderr);
assert.match(rerun.stderr, /already exists/);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
